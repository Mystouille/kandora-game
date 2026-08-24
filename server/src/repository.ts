import { z } from "zod";
import type { GameEvent, Seat } from "~/game/protocol/messages";
import {
  MatchCheckpointSchema,
  parseMatchCheckpoint,
  type MatchCheckpoint,
} from "./checkpoint";

const SeatSchema = z.union([
  z.literal(0),
  z.literal(1),
  z.literal(2),
  z.literal(3),
]);

export const PendingMatchCommandSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("act"),
      seat: SeatSchema,
      actionId: z.string().min(1),
    })
    .strict(),
  z
    .object({
      type: z.literal("ready"),
      seat: SeatSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("vote_continue"),
      seat: SeatSchema,
      vote: z.enum(["yes", "no"]),
    })
    .strict(),
  z
    .object({
      type: z.literal("afk"),
      seat: SeatSchema,
      afk: z.boolean(),
      defaultActionId: z.string().min(1).nullable(),
    })
    .strict(),
]);
export type PendingMatchCommand = z.infer<typeof PendingMatchCommandSchema>;

function checkpointDefaultActionId(
  checkpoint: MatchCheckpoint,
  seat: Seat
): string | null {
  if (checkpoint.status !== "playing") {
    return null;
  }
  if (
    checkpoint.checkpointKind === "action_window" &&
    checkpoint.actionWindow.seat === seat
  ) {
    const legals = checkpoint.actionWindow.legalActions;
    const drawn = checkpoint.state.lastDrawn[seat];
    const tsumogiri = legals.find(
      (action) =>
        action.type === "discard" &&
        action.tile === drawn &&
        (action.discardSource === "draw" || action.discardSource === undefined)
    );
    return (
      tsumogiri ?? legals.find((action) => action.type === "discard")
    )?.id ?? null;
  }
  if (checkpoint.checkpointKind === "call_window") {
    return (
      checkpoint.callTimers[seat]?.legalActions.find(
        (action) => action.type === "pass"
      )?.id ?? null
    );
  }
  return null;
}

export const MatchRecoveryRecordSchema = z
  .object({
    checkpoint: MatchCheckpointSchema,
    pendingCommand: PendingMatchCommandSchema.nullable(),
  })
  .strict()
  .superRefine((record, context) => {
    const command = record.pendingCommand;
    if (command === null) {
      return;
    }
    const checkpoint = record.checkpoint;
    if (command.type === "ready") {
      const valid =
        checkpoint.status === "playing" &&
        checkpoint.checkpointKind === "ready_check" &&
        !checkpoint.seats[command.seat].isBot &&
        !checkpoint.readyAcked[command.seat];
      if (!valid) {
        context.addIssue({
          code: "custom",
          path: ["pendingCommand", "seat"],
          message: "Pending ready command requires an unacked human seat",
        });
      }
      return;
    }
    if (command.type === "vote_continue") {
      const valid =
        checkpoint.status === "playing" &&
        checkpoint.checkpointKind === "continue_vote" &&
        !checkpoint.seats[command.seat].isBot &&
        !checkpoint.votes.some((vote) => vote === "no") &&
        !checkpoint.votes.every((vote) => vote === "yes") &&
        checkpoint.votes[command.seat] !== command.vote;
      if (!valid) {
        context.addIssue({
          code: "custom",
          path: ["pendingCommand", "vote"],
          message: "Pending vote command requires an unresolved human vote",
        });
      }
      return;
    }
    if (command.type === "afk") {
      const playing = checkpoint.status === "playing";
      const player = playing ? checkpoint.seats[command.seat] : null;
      const policy = playing ? checkpoint.connectionPolicy : null;
      const changesState = command.afk
        ? policy !== null &&
          (!policy.disconnected[command.seat] ||
            !policy.afkSelfReported[command.seat])
        : policy !== null &&
          (policy.disconnected[command.seat] ||
            policy.afkSelfReported[command.seat]);
      if (!playing || player?.isBot !== false || !changesState) {
        context.addIssue({
          code: "custom",
          path: ["pendingCommand", "afk"],
          message: "Pending AFK command requires a playing human state change",
        });
        return;
      }
      const expectedDefault = command.afk
        ? checkpointDefaultActionId(checkpoint, command.seat)
        : null;
      if (command.defaultActionId !== expectedDefault) {
        context.addIssue({
          code: "custom",
          path: ["pendingCommand", "defaultActionId"],
          message: "Pending AFK command has the wrong safe default action",
        });
      }
      return;
    }
    let legalActionIds: string[] = [];
    if (
      checkpoint.status === "playing" &&
      checkpoint.checkpointKind === "action_window" &&
      checkpoint.actionWindow.seat === command.seat
    ) {
      legalActionIds = checkpoint.actionWindow.legalActions.map(
        (action) => action.id
      );
    } else if (
      checkpoint.status === "playing" &&
      checkpoint.checkpointKind === "call_window"
    ) {
      legalActionIds =
        checkpoint.callTimers[command.seat]?.legalActions.map(
          (action) => action.id
        ) ?? [];
    }
    if (!legalActionIds.includes(command.actionId)) {
      context.addIssue({
        code: "custom",
        path: ["pendingCommand", "actionId"],
        message: "Pending action must be legal in its checkpoint window",
      });
    }
  });
export type MatchRecoveryRecord = z.infer<typeof MatchRecoveryRecordSchema>;

export function parseMatchRecoveryRecord(input: unknown): MatchRecoveryRecord {
  return MatchRecoveryRecordSchema.parse(input);
}

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
  /** Atomically save pre-command authority and the command to replay. */
  saveCommandTransaction(args: {
    matchId: string;
    checkpoint: MatchCheckpoint;
    command: PendingMatchCommand;
  }): Promise<void>;
  loadCheckpoint(matchId: string): Promise<MatchCheckpoint | null>;
  loadRecoveryRecord(matchId: string): Promise<MatchRecoveryRecord | null>;
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
  saveCommandTransaction: async () => undefined,
  loadCheckpoint: async () => null,
  loadRecoveryRecord: async () => null,
  markCheckpointTerminal: async () => undefined,
  deleteCheckpoint: async () => undefined,
};

export function createMemoryMatchRepository(): MatchRepository {
  const records = new Map<
    string,
    | { kind: "checkpoint"; recovery: MatchRecoveryRecord }
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
        recovery: parseMatchRecoveryRecord(
          JSON.parse(JSON.stringify({ checkpoint, pendingCommand: null }))
        ),
      });
    },
    saveCommandTransaction: async ({ matchId, checkpoint, command }) => {
      if (records.get(matchId)?.kind === "terminal") {
        throw new Error(`Cannot save command for terminal match ${matchId}`);
      }
      records.set(
        matchId,
        {
          kind: "checkpoint",
          recovery: parseMatchRecoveryRecord(
            JSON.parse(JSON.stringify({ checkpoint, pendingCommand: command }))
          ),
        }
      );
    },
    loadCheckpoint: async (matchId) => {
      const record = records.get(matchId);
      return record?.kind === "checkpoint"
        ? parseMatchCheckpoint(
            JSON.parse(JSON.stringify(record.recovery.checkpoint))
          )
        : null;
    },
    loadRecoveryRecord: async (matchId) => {
      const record = records.get(matchId);
      return record?.kind === "checkpoint"
        ? parseMatchRecoveryRecord(JSON.parse(JSON.stringify(record.recovery)))
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