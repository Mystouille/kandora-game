import { type SeatValues } from "~/game/protocol/seat";
import type { MatchDebug, Seat } from "~/game/protocol/messages";
import type { SpectatorDelayMs } from "~/game/protocol/spectatorDelay";
import type { MatchModeConfig } from "~/game/protocol/matchMode";
import type { MatchEndReason, RuleSetOverride } from "~/game/rules";

export interface MatchConfiguration {
  readonly matchId: string;
  readonly seed: number;
  readonly debug: MatchDebug;
  readonly ruleSetOverride?: RuleSetOverride;
  readonly presetId: string;
  readonly mode: MatchModeConfig;
  readonly spectatorDelayMs: SpectatorDelayMs;
}

export interface FinalScore {
  seat: Seat;
  score: number;
  place: 1 | 2 | 3 | 4;
}

export interface AutomaticActionContext {
  matchId: string;
  gameId: string;
  seat: Seat;
  actionId: string;
  reason: "deadline" | "disconnected" | "afk";
  nextSeq: number;
  bufferMs: number;
  actionWindowElapsedMs: number | null;
}

export interface EndMatchOptions {
  skipHandEnd?: boolean;
  finalScores?: SeatValues<number>;
  matchEndReason?: MatchEndReason;
  serverAbort?: boolean;
}

export type SessionEndReason =
  "vote_no" | "vote_timeout" | "single_game" | "server_abort";
