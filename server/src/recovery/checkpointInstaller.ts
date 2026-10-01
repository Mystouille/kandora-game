import type { Seat } from "~/game/protocol/messages";
import type {
  MatchCheckpoint,
  PlayingContinueVoteCheckpoint,
  PlayingReadyCheckpoint,
  PlayingResultTransitionCheckpoint,
} from "../checkpoint";
import type { MatchRuntime } from "../runtime";
import type { CallCoordinator } from "../session/callCoordinator";
import type { ContinueVote } from "../session/continueVote";
import type { ReadyCheck } from "../session/readyCheck";
import type { ResultTransition } from "../session/resultTransition";
import type { ActionWindowRegistry } from "../timing/actionWindows";
import type { TimeBank } from "../timing/timeBank";

export interface CheckpointInstallerPort {
  readonly runtime: Pick<MatchRuntime, "now">;
  readonly calls: Pick<CallCoordinator, "restore">;
  readonly bank: Pick<TimeBank, "restore">;
  readonly windows: Pick<
    ActionWindowRegistry,
    "resetForRestore" | "restore" | "cancelTimer"
  >;
  readonly ready: Pick<ReadyCheck, "cancelTimer"> & {
    installCheckpointReadyCheck(
      checkpoint: PlayingReadyCheckpoint,
      restored: boolean,
      restoredAt?: number
    ): void;
  };
  readonly votes: Pick<ContinueVote, "cancelTimer"> & {
    installCheckpointContinueVote(
      checkpoint: PlayingContinueVoteCheckpoint,
      restored: boolean,
      restoredAt?: number
    ): void;
  };
  readonly results: Pick<ResultTransition, "cancelTimer"> & {
    installCheckpointResultTransition(
      checkpoint: PlayingResultTransitionCheckpoint,
      restored: boolean,
      restoredAt?: number
    ): void;
  };
}

/** Installs relative continuation durations; each concern retains its own timers. */
export class CheckpointInstaller {
  constructor(private readonly port: CheckpointInstallerPort) {}

  cancelTimers(checkpoint: MatchCheckpoint): void {
    if (checkpoint.status !== "playing") {
      return;
    }
    if (checkpoint.checkpointKind === "result_transition") {
      this.port.results.cancelTimer();
    } else if (checkpoint.checkpointKind === "continue_vote") {
      this.port.votes.cancelTimer();
    } else if (checkpoint.checkpointKind === "ready_check") {
      this.port.ready.cancelTimer();
    } else {
      const seats =
        checkpoint.checkpointKind === "action_window"
          ? [checkpoint.actionWindow.seat]
          : checkpoint.callWindows.flatMap((window, seat) =>
              window === null ? [] : [seat as Seat]
            );
      for (const seat of seats) {
        this.port.windows.cancelTimer(seat);
      }
    }
  }

  install(
    checkpoint: MatchCheckpoint,
    restoredContinuation = false,
    restoredAt = this.port.runtime.now()
  ): void {
    if (checkpoint.status !== "playing") {
      return;
    }
    if (checkpoint.checkpointKind === "action_window") {
      this.port.bank.restore(checkpoint.bufferMs);
      this.port.windows.resetForRestore();
      this.port.windows.restore(
        checkpoint.actionWindow.seat,
        checkpoint.actionWindow,
        restoredAt
      );
    } else if (checkpoint.checkpointKind === "call_window") {
      this.port.calls.restore(checkpoint);
      this.port.bank.restore(checkpoint.bufferMs);
      this.port.windows.resetForRestore();
      for (const seat of [0, 1, 2, 3] as const) {
        const timer = checkpoint.callTimers[seat];
        if (timer !== null) {
          this.port.windows.restore(
            seat,
            { ...timer, kind: "turn" },
            restoredAt
          );
        }
      }
    } else if (checkpoint.checkpointKind === "ready_check") {
      this.port.ready.installCheckpointReadyCheck(
        checkpoint,
        restoredContinuation,
        restoredAt
      );
    } else if (checkpoint.checkpointKind === "continue_vote") {
      this.port.votes.installCheckpointContinueVote(
        checkpoint,
        restoredContinuation,
        restoredAt
      );
    } else {
      this.port.results.installCheckpointResultTransition(
        checkpoint,
        restoredContinuation,
        restoredAt
      );
    }
  }
}
