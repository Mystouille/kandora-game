import type { Seat, ServerMessage } from "~/game/protocol/messages";

import type { PlayingReadyCheckpoint } from "../checkpoint";

import type { MatchRuntime, MatchTimer } from "../runtime";

import { RoomRoster } from "./roomRoster";

import { CommandCoordinator } from "./commandCoordinator";

import type { ReadyCheckPort } from "./lifecyclePorts";

import { gameTiming } from "./timingPolicy";
import type { InputReceipt } from "~/game/protocol/timing";
import type { PromptTimingService } from "../timing/promptWindows";

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
    private readonly port: ReadyCheckPort,
    private readonly timing?: PromptTimingService
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
      if (this.timing && this.readyDeadline !== null) {
        this.timing.addReadySeat(seat, this.readyDeadline);
        this.scheduleExpiry(
          Math.max(0, this.readyDeadline - this.runtime.now())
        );
      }
    }
  }

  async runReadyCheck(
    ms: number = gameTiming.READY_CHECK_MS,
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
    this.timing?.open("ready", this.port.humanSeats(), ms);
    const waiting = new Promise<void>((resolve) => {
      this.readyResolve = resolve;
      this.scheduleExpiry(ms);
    });
    this.broadcastReadyCheck();
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
    this.timing?.resolve(seat);
    this.readyAcked[seat] = true;
    if (this.readyAcked.every(Boolean)) {
      if (!this.commands.legacyRecoveryInProgress) {
        this.finishReadyCheck();
      }
      return;
    }
    this.broadcastReadyCheck();
    if (
      this.timing &&
      this.runtime.now() >= (this.timing.deadline("ready") ?? Infinity)
    ) {
      this.expire();
    }
  }

  reserve(seat: Seat, receipt: InputReceipt): void {
    this.timing?.reserve(seat, "ready", receipt);
  }

  releaseReceipt(seat: Seat, receipt: InputReceipt): void {
    this.timing?.releaseReservation(seat, receipt);
    if (this.readyResolve !== null && this.readyTimer === null) {
      this.scheduleExpiry(
        Math.max(
          0,
          (this.readyDeadline ?? this.runtime.now()) - this.runtime.now()
        )
      );
    }
  }

  private scheduleExpiry(remainingMs: number): void {
    this.readyTimer?.cancel();
    const expiry = this.timing?.deadline("ready");
    const delay =
      expiry === undefined || expiry === null
        ? remainingMs
        : Math.max(0, expiry - this.runtime.now());
    this.readyTimer = this.runtime.schedule(() => this.expire(), delay, {
      unref: true,
    });
  }

  private expire(): void {
    this.readyTimer = null;
    if (this.port.isPaused() || this.timing?.hasReserved("ready")) {
      return;
    }
    this.finishReadyCheck();
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
    this.timing?.clear("ready");

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
        const window = this.timing?.view(seat);
        send({
          ...frame,
          ...(this.timing
            ? {
                clock: this.timing.stamp(),
                window,
              }
            : {}),
        });
      }
    }
  }

  installCheckpointReadyCheck(
    checkpoint: PlayingReadyCheckpoint,
    restored: boolean,
    restoredAt = this.runtime.now()
  ): void {
    const continuation = checkpoint.readyContinuation;
    this.readyAcked = [...checkpoint.readyAcked];
    this.readyDeadline = restoredAt + checkpoint.readyRemainingMs;
    this.readyContinuationKind = continuation;
    if (this.timing && checkpoint.decisionTiming?.prompts) {
      this.timing.restore(
        checkpoint.decisionTiming.prompts,
        checkpoint.savedAt,
        restoredAt
      );
      const active = this.port.humanSeats().flatMap((seat) => {
        const window = this.timing?.view(seat);
        return window && !this.readyAcked[seat] ? [window.baseEndsAt] : [];
      });
      if (active.length > 0) {
        this.readyDeadline = Math.max(...active);
      }
    } else if (this.timing) {
      this.timing.restoreLegacy(
        "ready",
        this.port.humanSeats().filter((seat) => !this.readyAcked[seat]),
        checkpoint.readyRemainingMs,
        restoredAt
      );
    }
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
    this.scheduleExpiry(Math.max(0, this.readyDeadline - this.runtime.now()));
  }
}
