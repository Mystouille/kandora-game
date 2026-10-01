import type { Seat, ServerMessage } from "~/game/protocol/messages";

import type { PlayingReadyCheckpoint } from "../checkpoint";

import type { MatchRuntime, MatchTimer } from "../runtime";

import { RoomRoster } from "./roomRoster";

import { CommandCoordinator } from "./commandCoordinator";

import type { ReadyCheckPort } from "./lifecyclePorts";

import { legacyTiming } from "./legacyPolicy";

export interface ReadyCheckSnapshot {
  readonly acked: [boolean, boolean, boolean, boolean];
  readonly deadline: number | null;
  readonly active: boolean;
  readonly timerPending: boolean;
  readonly continuation: PlayingReadyCheckpoint["readyContinuation"] | null;
}

export class ReadyCheck {
  private readyAcked: [boolean, boolean, boolean, boolean] = [
    false,
    false,
    false,
    false,
  ];
  private readyDeadline: number | null = null;
  private readyTimer: MatchTimer | null = null;
  private readyResolve: (() => void) | null = null;
  private readyContinuationKind:
    PlayingReadyCheckpoint["readyContinuation"] | null = null;

  constructor(
    private readonly runtime: MatchRuntime,
    private readonly roster: RoomRoster,
    private readonly commands: CommandCoordinator,
    private readonly port: ReadyCheckPort
  ) {}
  snapshot(): ReadyCheckSnapshot {
    return {
      acked: [...this.readyAcked],
      deadline: this.readyDeadline,
      active: this.readyResolve !== null,
      timerPending: this.readyTimer !== null,
      continuation: this.readyContinuationKind,
    };
  }
  cancelTimer(): void {
    this.readyTimer?.cancel();
    this.readyTimer = null;
  }
  unackHuman(seat: Seat): void {
    if (this.readyResolve !== null) {
      this.readyAcked[seat] = false;
    }
  }

  async runReadyCheck(
    ms: number = legacyTiming.READY_CHECK_MS,
    continuation: PlayingReadyCheckpoint["readyContinuation"] | null = null
  ): Promise<void> {
    this.readyContinuationKind = null;
    for (const [seat, p] of this.roster.players()) {
      this.readyAcked[seat] = p?.isBot ?? true;
    }
    if (ms <= 0 || this.readyAcked.every((a) => a)) {
      this.readyDeadline = null;
      return;
    }
    this.readyContinuationKind = continuation;
    this.readyDeadline = this.runtime.now() + ms;
    this.broadcastReadyCheck();
    const waiting = new Promise<void>((resolve) => {
      this.readyResolve = resolve;
      this.readyTimer = this.runtime.schedule(
        () => {
          this.finishReadyCheck();
        },
        ms,
        { unref: true }
      );
    });
    await this.commands.commitOpenInputBoundary();
    await waiting;
  }

  isAcceptedReady(seat: Seat): boolean {
    const player = this.roster.players().get(seat);
    return (
      this.readyResolve !== null &&
      player !== null &&
      player !== undefined &&
      !player.isBot &&
      !this.readyAcked[seat]
    );
  }

  handleReadyDirect(seat: Seat): void {
    this.readyAcked[seat] = true;
    if (this.readyAcked.every(Boolean)) {
      if (!this.commands.legacyRecoveryInProgress) {
        this.finishReadyCheck();
      }
      return;
    }
    this.broadcastReadyCheck();
  }

  finishReadyCheck(): void {
    if (this.port.isPaused()) {
      return;
    }
    if (this.readyTimer) {
      this.readyTimer.cancel();
      this.readyTimer = null;
    }
    const resolve = this.readyResolve;
    this.readyResolve = null;
    this.readyDeadline = null;
    this.readyContinuationKind = null;

    for (const seat of this.port.humanSeats()) {
      const send = this.port.sender(seat);
      if (send) {
        send({ type: "ready_check_end" });
      }
    }
    if (resolve) {
      resolve();
    }
  }

  broadcastReadyCheck(): void {
    if (this.readyDeadline === null) {
      return;
    }
    const frame: ServerMessage = {
      type: "ready_check",
      deadline: this.readyDeadline,
      acked: [...this.readyAcked] as [boolean, boolean, boolean, boolean],
    };
    for (const seat of this.port.humanSeats()) {
      const send = this.port.sender(seat);
      if (send) {
        send(frame);
      }
    }
  }

  installCheckpointReadyCheck(
    checkpoint: PlayingReadyCheckpoint,
    restored: boolean
  ): void {
    const continuation = checkpoint.readyContinuation;
    this.readyAcked = [...checkpoint.readyAcked];
    this.readyDeadline = this.runtime.now() + checkpoint.readyRemainingMs;
    this.readyContinuationKind = continuation;
    if (restored) {
      this.readyResolve = () => {
        void this.port.resumeReadyContinuation(continuation);
      };
    } else if (this.readyResolve === null) {
      throw new Error(
        "MatchProcess.installCheckpointReadyCheck: missing live continuation"
      );
    }
    this.readyTimer?.cancel();
    if (checkpoint.readyAcked.every(Boolean)) {
      this.readyTimer = null;
      this.finishReadyCheck();
      return;
    }
    this.readyTimer = this.runtime.schedule(
      () => {
        if (!this.port.isPaused()) {
          this.finishReadyCheck();
        }
      },
      checkpoint.readyRemainingMs,
      { unref: true }
    );
  }
}
