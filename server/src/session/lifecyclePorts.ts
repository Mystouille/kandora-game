import type {
  DuplicateWallState,
  GameEvent,
  Seat,
} from "~/game/protocol/messages";
import type { EngineEvent, FuritenChange } from "~/game/rules";
import type {
  PlayingReadyCheckpoint,
  PlayingResultTransitionCheckpoint,
} from "../checkpoint";
import type { FinalScore, EndMatchOptions } from "./sessionTypes";
import type { Send } from "./playerConnections";

export interface ReadyCheckPort {
  isPaused(): boolean;
  humanSeats(): Seat[];
  sender(seat: Seat): Send | null;
  resumeReadyContinuation(
    kind: PlayingReadyCheckpoint["readyContinuation"]
  ): Promise<void>;
}

export interface ResultTransitionPort {
  isPaused(): boolean;
  resumeResultTransition(
    kind: PlayingResultTransitionCheckpoint["transitionKind"],
    nextReadyMs: number
  ): Promise<void>;
}

export interface HandLifecyclePort {
  emitEvent(event: GameEvent): Promise<void>;
  emitEngineEvent(event: EngineEvent): Promise<void>;
  emitFuritenChanges(
    changes: readonly FuritenChange[] | undefined
  ): Promise<void>;
  advanceTurn(): Promise<void>;
  endMatch(
    reason: "exhaustive_draw" | "ron" | "tsumo" | "abort",
    options: EndMatchOptions
  ): Promise<void>;
  gameIndex(): number;
  gameFinalized(): boolean;
  resetCallState(): void;
  clearLegals(seat: Seat): void;
  runReadyCheck(
    ms: number,
    kind: PlayingReadyCheckpoint["readyContinuation"]
  ): Promise<void>;
  runResultTransition(
    kind: PlayingResultTransitionCheckpoint["transitionKind"],
    delayMs: number,
    nextReadyMs: number
  ): Promise<void>;
  computeSinking(): [boolean, boolean, boolean, boolean];
  rollDice(): [number, number];
  duplicateWallEventFields(): { duplicateWallState?: DuplicateWallState };
}

export interface ContinueVotePort {
  isPaused(): boolean;
  emitEvent(event: GameEvent): Promise<void>;
  gameIndex(): number;
  gameFinalized(): void;
  continueAfterVote(
    continueSession: boolean,
    scores: FinalScore[]
  ): Promise<void>;
}

export interface SessionLifecyclePort {
  assertNotPaused(operation: string): void;
  isPaused(): boolean;
  emitEvent(event: GameEvent): Promise<void>;
  eventCount(): number;
  openEventJournal(gameId: string, initialSeq: number): void;
  broadcastRoomState(): void;
  archiveCurrentGame(scores: FinalScore[]): Promise<void>;
  runReadyCheck(
    ms: number,
    kind: PlayingReadyCheckpoint["readyContinuation"]
  ): Promise<void>;
  beginInitialHandAfterReady(): Promise<void>;
  runContinueVote(scores: FinalScore[]): Promise<boolean>;
  lastVoteReason(): "vote_no" | "vote_timeout" | null;
  runUncheckpointableTransition(
    kind: import("./transitionBarrier").TransitionKind,
    delayMs: number
  ): Promise<void>;
  resetCallState(): void;
  resetRiichiTiles(): void;
  refillBank(): void;
  clearLegals(seat: Seat): void;
  cancelReadyTimer(): void;
  cancelActionTimers(): void;
  hasContinueVote(): boolean;
  finishContinueVote(continueSession: boolean): void;
}
