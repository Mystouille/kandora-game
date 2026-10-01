import type { PlayingResultTransitionCheckpoint } from "../checkpoint";

import type { MatchRuntime, MatchTimer } from "../runtime";

import { CommandCoordinator } from "./commandCoordinator";

import type { ResultTransitionPort } from "./lifecyclePorts";

export interface ResultTransitionSnapshot {
  readonly kind: PlayingResultTransitionCheckpoint["transitionKind"] | null;
  readonly deadline: number | null;
  readonly nextReadyMs: number;
  readonly active: boolean;
  readonly timerPending: boolean;
}

export class ResultTransition {
  private resultTransitionKind:
    PlayingResultTransitionCheckpoint["transitionKind"] | null = null;
  private resultTransitionDeadline: number | null = null;
  private resultTransitionNextReadyMs = 0;
  private resultTransitionTimer: MatchTimer | null = null;
  private resultTransitionResolve: (() => void) | null = null;

  constructor(
    private readonly runtime: MatchRuntime,
    private readonly commands: CommandCoordinator,
    private readonly port: ResultTransitionPort
  ) {}
  snapshot(): ResultTransitionSnapshot {
    return {
      kind: this.resultTransitionKind,
      deadline: this.resultTransitionDeadline,
      nextReadyMs: this.resultTransitionNextReadyMs,
      active: this.resultTransitionResolve !== null,
      timerPending: this.resultTransitionTimer !== null,
    };
  }
  cancelTimer(): void {
    this.resultTransitionTimer?.cancel();
    this.resultTransitionTimer = null;
  }

  async runResultTransition(
    transitionKind: PlayingResultTransitionCheckpoint["transitionKind"],
    delayMs: number,
    nextReadyMs: number
  ): Promise<void> {
    this.resultTransitionKind = transitionKind;
    this.resultTransitionDeadline = this.runtime.now() + delayMs;
    this.resultTransitionNextReadyMs = nextReadyMs;
    const waiting = new Promise<void>((resolve) => {
      this.resultTransitionResolve = resolve;
      this.resultTransitionTimer = this.runtime.schedule(
        () => {
          this.finishResultTransition();
        },
        delayMs,
        { unref: true }
      );
    });
    await this.commands.commitOpenInputBoundary();
    await waiting;
  }

  finishResultTransition(): void {
    if (this.port.isPaused()) {
      return;
    }
    this.resultTransitionTimer?.cancel();
    this.resultTransitionTimer = null;
    const resolve = this.resultTransitionResolve;
    this.resultTransitionResolve = null;
    this.resultTransitionDeadline = null;
    this.resultTransitionKind = null;
    this.resultTransitionNextReadyMs = 0;
    resolve?.();
  }

  installCheckpointResultTransition(
    checkpoint: PlayingResultTransitionCheckpoint,
    restored: boolean,
    restoredAt = this.runtime.now()
  ): void {
    const transitionKind = checkpoint.transitionKind;
    const nextReadyMs = checkpoint.nextReadyMs;
    this.resultTransitionKind = transitionKind;
    this.resultTransitionDeadline =
      restoredAt + checkpoint.transitionRemainingMs;
    this.resultTransitionNextReadyMs = nextReadyMs;
    if (restored) {
      this.resultTransitionResolve = () => {
        void this.port.resumeResultTransition(transitionKind, nextReadyMs);
      };
    } else if (this.resultTransitionResolve === null) {
      throw new Error(
        "MatchProcess.installCheckpointResultTransition: missing live continuation"
      );
    }
    this.resultTransitionTimer?.cancel();
    this.resultTransitionTimer = this.runtime.schedule(
      () => {
        this.finishResultTransition();
      },
      Math.max(0, this.resultTransitionDeadline - this.runtime.now()),
      { unref: true }
    );
  }
}
