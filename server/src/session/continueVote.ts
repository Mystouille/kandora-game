import type { Seat } from "~/game/protocol/messages";

import type { PlayingContinueVoteCheckpoint } from "../checkpoint";

import type { MatchRuntime, MatchTimer } from "../runtime";

import { RoomRoster } from "./roomRoster";

import { PlayerConnections } from "./playerConnections";

import { CommandCoordinator } from "./commandCoordinator";

import type { FinalScore } from "./sessionTypes";

import type { ContinueVotePort } from "./lifecyclePorts";

import { gameTiming } from "./timingPolicy";
import type { InputReceipt } from "~/game/protocol/timing";
import type { PromptTimingService } from "../timing/promptWindows";
import {
  copySeatValues,
  seatValues,
  type SeatValues,
} from "~/game/rules/seats";

type Vote = "yes" | "no" | null;

export interface ContinueVoteSnapshot {
  readonly votes: SeatValues<Vote>;
  readonly deadline: number | null;
  readonly active: boolean;
  readonly timerPending: boolean;
  readonly finalScores: FinalScore[] | null;
  readonly lastVoteReason: "vote_no" | "vote_timeout" | null;
}

export class ContinueVote {
  private continueVote: SeatValues<Vote>;
  private continueVoteDeadline: number | null = null;
  private continueVoteTimer: MatchTimer | null = null;
  private continueVoteResolve: ((cont: boolean) => void) | null = null;
  private continueVoteFinalScores: FinalScore[] | null = null;
  private lastVoteReason: "vote_no" | "vote_timeout" | null = null;

  constructor(
    private readonly runtime: MatchRuntime,
    private readonly roster: RoomRoster,
    private readonly connections: PlayerConnections,
    private readonly commands: CommandCoordinator,
    private readonly port: ContinueVotePort,
    private readonly timing?: PromptTimingService
  ) {
    this.continueVote = seatValues(roster.playerCount, () => null);
  }
  snapshot(): ContinueVoteSnapshot {
    return {
      votes: copySeatValues(this.continueVote),
      deadline: this.continueVoteDeadline,
      active: this.continueVoteResolve !== null,
      timerPending: this.continueVoteTimer !== null,
      finalScores:
        this.continueVoteFinalScores?.map((score) => ({ ...score })) ?? null,
      lastVoteReason: this.lastVoteReason,
    };
  }
  cancelTimer(): void {
    this.continueVoteTimer?.cancel();
    this.continueVoteTimer = null;
  }

  async runContinueVote(finalScores: FinalScore[]): Promise<boolean> {
    const voting = new Promise<boolean>((resolve) => {
      this.continueVote = seatValues(this.roster.playerCount, () => null);
      this.continueVoteFinalScores = finalScores.map((score) => ({ ...score }));
      this.lastVoteReason = null;
      for (let s = 0; s < this.roster.playerCount; s++) {
        const p = this.roster.players().get(s as Seat);
        if (p?.isBot) {
          this.continueVote[s] = "yes";
        }
      }
      for (let s = 0; s < this.roster.playerCount; s++) {
        if (
          this.connections.view(s as Seat).disconnected &&
          this.continueVote[s] === null
        ) {
          this.continueVote[s] = "no";
        }
      }
      this.continueVoteDeadline =
        this.runtime.now() + gameTiming.CONTINUE_VOTE_MS;
      this.continueVoteResolve = resolve;
      if (gameTiming.CONTINUE_VOTE_MS > 0) {
        this.timing?.open(
          "session_vote",
          [...this.roster.players()].flatMap(([seat, player]) =>
            player && !player.isBot && !this.connections.view(seat).disconnected
              ? [seat]
              : []
          ),
          gameTiming.CONTINUE_VOTE_MS
        );
      }

      void this.port.emitEvent({
        type: "session_vote_open",
        deadline: this.continueVoteDeadline,
        votes: [...this.continueVote] as [
          "yes" | "no" | null,
          "yes" | "no" | null,
          "yes" | "no" | null,
          "yes" | "no" | null,
        ],
        gameIndex: this.port.gameIndex(),
      });

      this.tallyContinueVote();
      if (this.continueVoteResolve === null) {
        return;
      }
      if (gameTiming.CONTINUE_VOTE_MS > 0) {
        this.scheduleExpiry(gameTiming.CONTINUE_VOTE_MS);
      }
    });
    if (this.continueVoteResolve !== null) {
      await this.commands.commitOpenInputBoundary();
    }
    return voting;
  }

  isAcceptedContinueVote(seat: Seat, vote: "yes" | "no"): boolean {
    const player = this.roster.players().get(seat);
    return (
      this.continueVoteResolve !== null &&
      player !== null &&
      player !== undefined &&
      !player.isBot &&
      !this.continueVote.some((current) => current === "no") &&
      !this.continueVote.every((current) => current === "yes") &&
      this.continueVote[seat] !== vote
    );
  }

  async handleVoteContinueDirect(
    seat: Seat,
    vote: "yes" | "no"
  ): Promise<void> {
    this.continueVote[seat] = vote;
    this.timing?.releaseVote(seat);
    await this.port.emitEvent({
      type: "session_vote_update",
      votes: [...this.continueVote] as [
        "yes" | "no" | null,
        "yes" | "no" | null,
        "yes" | "no" | null,
        "yes" | "no" | null,
      ],
    });
    if (!this.commands.legacyRecoveryInProgress) {
      this.tallyContinueVote();
      if (
        this.timing &&
        this.continueVoteResolve &&
        this.runtime.now() >= (this.timing.deadline("session_vote") ?? Infinity)
      ) {
        this.expire();
      }
    }
  }

  reserve(seat: Seat, vote: "yes" | "no", receipt: InputReceipt): void {
    this.timing?.reserve(seat, vote, receipt);
    if (this.continueVote[seat] === vote) {
      this.timing?.releaseVote(seat);
    }
  }

  releaseReceipt(seat: Seat, receipt: InputReceipt): void {
    this.timing?.releaseReservation(seat, receipt);
    if (this.continueVoteResolve !== null && this.continueVoteTimer === null) {
      this.scheduleExpiry(
        Math.max(
          0,
          (this.continueVoteDeadline ?? this.runtime.now()) - this.runtime.now()
        )
      );
    }
  }

  private scheduleExpiry(remainingMs: number): void {
    this.continueVoteTimer?.cancel();
    const expiry = this.timing?.deadline("session_vote");
    const delay =
      expiry === undefined || expiry === null
        ? remainingMs
        : Math.max(0, expiry - this.runtime.now());
    this.continueVoteTimer = this.runtime.schedule(() => this.expire(), delay, {
      unref: true,
    });
  }

  private expire(): void {
    this.continueVoteTimer = null;
    if (this.port.isPaused() || this.timing?.hasReserved("session_vote")) {
      return;
    }
    this.lastVoteReason = "vote_timeout";
    this.finishContinueVote(false);
  }

  tallyContinueVote(): void {
    if (this.continueVoteResolve === null) {
      return;
    }
    if (this.continueVote.some((v) => v === "no")) {
      this.lastVoteReason = "vote_no";
      this.finishContinueVote(false);
      return;
    }
    if (this.continueVote.every((v) => v === "yes")) {
      this.finishContinueVote(true);
      return;
    }
  }

  finishContinueVote(cont: boolean): void {
    if (this.port.isPaused()) {
      return;
    }
    if (this.continueVoteTimer) {
      this.continueVoteTimer.cancel();
      this.continueVoteTimer = null;
    }
    const resolve = this.continueVoteResolve;
    this.continueVoteResolve = null;
    this.continueVoteDeadline = null;
    this.continueVoteFinalScores = null;
    this.timing?.clear("session_vote");
    if (resolve) {
      resolve(cont);
    }
  }

  installCheckpointContinueVote(
    checkpoint: PlayingContinueVoteCheckpoint,
    restored: boolean,
    restoredAt = this.runtime.now()
  ): void {
    const finalScores = checkpoint.finalScores.map((score) => ({ ...score }));
    this.continueVote = copySeatValues(checkpoint.votes);
    this.continueVoteDeadline = restoredAt + checkpoint.voteRemainingMs;
    this.continueVoteFinalScores = finalScores;
    if (this.timing && checkpoint.decisionTiming?.prompts) {
      this.timing.restore(
        checkpoint.decisionTiming.prompts,
        checkpoint.savedAt,
        restoredAt
      );
      const bases = [...this.roster.players()].flatMap(([seat]) => {
        const window = this.timing?.view(seat);
        return window ? [window.baseEndsAt] : [];
      });
      if (bases.length > 0) {
        this.continueVoteDeadline = Math.max(...bases);
      }
    } else if (this.timing) {
      this.timing.restoreLegacy(
        "session_vote",
        [...this.roster.players()].flatMap(([seat, player]) =>
          player && !player.isBot ? [seat] : []
        ),
        checkpoint.voteRemainingMs,
        restoredAt
      );
    }
    this.lastVoteReason = null;
    this.port.gameFinalized();
    if (restored) {
      this.continueVoteResolve = (cont) => {
        void this.port.continueAfterVote(cont, finalScores);
      };
    } else if (this.continueVoteResolve === null) {
      throw new Error(
        "MatchProcess.installCheckpointContinueVote: missing live continuation"
      );
    }
    this.continueVoteTimer?.cancel();
    const hasNoVote = checkpoint.votes.some((vote) => vote === "no");
    const allYes = checkpoint.votes.every((vote) => vote === "yes");
    if (hasNoVote || allYes) {
      this.continueVoteTimer = null;
      if (hasNoVote) {
        this.lastVoteReason = "vote_no";
      }
      this.finishContinueVote(allYes);
      return;
    }
    if (checkpoint.timeoutArmed) {
      this.scheduleExpiry(
        Math.max(0, this.continueVoteDeadline - this.runtime.now())
      );
    } else {
      this.continueVoteTimer = null;
    }
  }
}
