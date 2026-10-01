import type { Seat } from "~/game/protocol/messages";

import type { PlayingContinueVoteCheckpoint } from "../checkpoint";

import type { MatchRuntime, MatchTimer } from "../runtime";

import { RoomRoster } from "./roomRoster";

import { PlayerConnections } from "./playerConnections";

import { CommandCoordinator } from "./commandCoordinator";

import type { FinalScore } from "./sessionTypes";

import type { ContinueVotePort } from "./lifecyclePorts";

import { legacyTiming } from "./legacyPolicy";

export interface ContinueVoteSnapshot {
  readonly votes: [
    "yes" | "no" | null,
    "yes" | "no" | null,
    "yes" | "no" | null,
    "yes" | "no" | null,
  ];
  readonly deadline: number | null;
  readonly active: boolean;
  readonly timerPending: boolean;
  readonly finalScores: FinalScore[] | null;
  readonly lastVoteReason: "vote_no" | "vote_timeout" | null;
}

export class ContinueVote {
  private continueVote: [
    "yes" | "no" | null,
    "yes" | "no" | null,
    "yes" | "no" | null,
    "yes" | "no" | null,
  ] = [null, null, null, null];
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
    private readonly port: ContinueVotePort
  ) {}
  snapshot(): ContinueVoteSnapshot {
    return {
      votes: [...this.continueVote],
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
      this.continueVote = [null, null, null, null];
      this.continueVoteFinalScores = finalScores.map((score) => ({ ...score }));
      this.lastVoteReason = null;
      for (let s = 0; s < 4; s++) {
        const p = this.roster.players().get(s as Seat);
        if (p?.isBot) {
          this.continueVote[s] = "yes";
        }
      }
      for (let s = 0; s < 4; s++) {
        if (
          this.connections.view(s as Seat).disconnected &&
          this.continueVote[s] === null
        ) {
          this.continueVote[s] = "no";
        }
      }
      this.continueVoteDeadline =
        this.runtime.now() + legacyTiming.CONTINUE_VOTE_MS;
      this.continueVoteResolve = resolve;

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
      if (legacyTiming.CONTINUE_VOTE_MS > 0) {
        this.continueVoteTimer = this.runtime.schedule(
          () => {
            this.lastVoteReason = "vote_timeout";
            this.finishContinueVote(false);
          },
          legacyTiming.CONTINUE_VOTE_MS,
          { unref: true }
        );
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
    }
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
    if (resolve) {
      resolve(cont);
    }
  }

  installCheckpointContinueVote(
    checkpoint: PlayingContinueVoteCheckpoint,
    restored: boolean
  ): void {
    const finalScores = checkpoint.finalScores.map((score) => ({ ...score }));
    this.continueVote = [...checkpoint.votes];
    this.continueVoteDeadline = this.runtime.now() + checkpoint.voteRemainingMs;
    this.continueVoteFinalScores = finalScores;
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
    this.continueVoteTimer = checkpoint.timeoutArmed
      ? this.runtime.schedule(
          () => {
            if (this.port.isPaused()) {
              return;
            }
            this.lastVoteReason = "vote_timeout";
            this.finishContinueVote(false);
          },
          checkpoint.voteRemainingMs,
          { unref: true }
        )
      : null;
  }
}
