import type { GameEvent, Seat } from "~/game/protocol/messages";
import {
  parseMatchCheckpoint,
  type MatchCheckpoint,
} from "./checkpoint";

export interface PersistedMatchPlayer {
  userId: string;
  seat: Seat;
  displayName: string;
  isBot: boolean;
}

export interface CreateMatchArgs {
  matchId: string;
  seed: number;
  players: PersistedMatchPlayer[];
  sessionId?: string;
  gameIndex?: number;
}

export interface ArchiveMatchArgs {
  matchId: string;
  events: Array<{ seq: number; event: GameEvent }>;
  finalScores: Array<{
    seat: Seat;
    score: number;
    place: 1 | 2 | 3 | 4;
  }>;
}

export interface ArchiveReplayLogArgs {
  matchId: string;
  source?: string;
  sourceGameId?: string;
  startedAt: Date;
  endedAt: Date;
  ruleSet: string;
  ruleSetDetails?: Record<string, unknown>;
  events: GameEvent[];
  seats: Array<{
    seat: Seat;
    displayName: string;
    finalScore: number;
    place: 1 | 2 | 3 | 4;
  }>;
}

export interface MatchRepository {
  createMatch(args: CreateMatchArgs): Promise<void>;
  archiveMatch(args: ArchiveMatchArgs): Promise<void>;
  archiveReplayLog(args: ArchiveReplayLogArgs): Promise<void>;
  /** Atomically replace the durable checkpoint for a session. */
  saveCheckpoint(args: {
    matchId: string;
    checkpoint: MatchCheckpoint;
  }): Promise<void>;
  loadCheckpoint(matchId: string): Promise<MatchCheckpoint | null>;
  /** Atomically replace an existing checkpoint with a terminal tombstone. */
  markCheckpointTerminal(args: {
    matchId: string;
    finishedAt: number;
  }): Promise<void>;
  deleteCheckpoint(matchId: string): Promise<void>;
}

/**
 * Persistence-free repository for unit tests and deliberately ephemeral
 * sessions. Production hosts must inject their durable repository.
 */
export const ephemeralMatchRepository: MatchRepository = {
  createMatch: async () => undefined,
  archiveMatch: async () => undefined,
  archiveReplayLog: async () => undefined,
  saveCheckpoint: async () => undefined,
  loadCheckpoint: async () => null,
  markCheckpointTerminal: async () => undefined,
  deleteCheckpoint: async () => undefined,
};

export function createMemoryMatchRepository(): MatchRepository {
  const records = new Map<
    string,
    | { kind: "checkpoint"; checkpoint: MatchCheckpoint }
    | { kind: "terminal"; finishedAt: number }
  >();
  return {
    createMatch: async () => undefined,
    archiveMatch: async () => undefined,
    archiveReplayLog: async () => undefined,
    saveCheckpoint: async ({ matchId, checkpoint }) => {
      if (records.get(matchId)?.kind === "terminal") {
        throw new Error(`Cannot save checkpoint for terminal match ${matchId}`);
      }
      records.set(matchId, {
        kind: "checkpoint",
        checkpoint: parseMatchCheckpoint(JSON.parse(JSON.stringify(checkpoint))),
      });
    },
    loadCheckpoint: async (matchId) => {
      const record = records.get(matchId);
      return record?.kind === "checkpoint"
        ? parseMatchCheckpoint(JSON.parse(JSON.stringify(record.checkpoint)))
        : null;
    },
    markCheckpointTerminal: async ({ matchId, finishedAt }) => {
      if (records.has(matchId)) {
        records.set(matchId, { kind: "terminal", finishedAt });
      }
    },
    deleteCheckpoint: async (matchId) => {
      records.delete(matchId);
    },
  };
}