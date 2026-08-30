/**
 * Mongo persistence for `MatchProcess`.
 *
 * Design:
 *
 *   - **Live authority remains in RAM.** Accepted commands never await Mongo.
 *     Archive-enriched events are appended through a per-match ordered queue;
 *     transient journal failures lag persistence without pausing gameplay.
 *   - **Mongo also owns the final archive.** `createMatchDoc` advertises the
 *     playing match; `archiveMatch` replaces any partial journal prefix with
 *     the complete event log and scores at game end.
 *   - Explicit lifecycle pauses still write a full recovery checkpoint after
 *     flushing the event journal. `pendingCommand` remains readable only for
 *     checkpoints created by older builds; new commands do not create it.
 *   - Session completion replaces an existing recovery record with a terminal
 *     tombstone before clients receive `session_end`; the marker prevents a
 *     delayed stale writer from resurrecting the match.
 *   - **Recovery is host-driven.** This module can save/load/delete
 *     checkpoints, but the current Node bootstrap does not automatically
 *     pause rooms or restore them at startup. Mobile/local composition owns
 *     that lifecycle; cloud startup recovery remains a later integration.
 *
 * Reading: `loadMatchEvents` returns the finished-match event log. Partial
 * playing journals are deliberately not exposed as completed replays.
 */
import mongoose, { Schema } from "mongoose";
import { MatchModel } from "~/core/models/game/Match";
import { ReplayLogModel } from "~/core/models/game/ReplayLog";
import type { GameEvent } from "~/game/protocol/messages";
import { REPLAY_LOG_SCHEMA_VERSION } from "~/game/replay/types";
import {
  assertContiguousMatchEvents,
  parseMatchRecoveryRecord,
  PendingMatchCommandSchema,
  type ArchiveMatchArgs,
  type CreateMatchArgs,
  type MatchEventJournalStore,
  type MatchRecoveryRecord,
  type MatchRepository,
  type PendingMatchCommand,
  type PersistedMatchEvent,
} from "./repository";
import {
  parseMatchCheckpoint,
  type MatchCheckpoint,
} from "./checkpoint";

const MatchCheckpointModel =
  mongoose.models.GameMatchCheckpoint ??
  mongoose.model(
    "GameMatchCheckpoint",
    new Schema(
      {
        _id: { type: String, required: true },
        checkpoint: { type: Schema.Types.Mixed, required: false },
        pendingCommand: { type: Schema.Types.Mixed, required: false },
        terminalAt: { type: Date, required: false },
      },
      { timestamps: true, _id: false }
    ),
    "game_match_checkpoints"
  );

export async function createMatchDoc(args: CreateMatchArgs): Promise<void> {
  await MatchModel.updateOne(
    { _id: args.matchId },
    {
      $setOnInsert: {
        _id: args.matchId,
        seed: args.seed,
        ruleSet: args.ruleSet,
        players: args.players,
        status: "playing",
        startedAt: new Date(),
        events: [],
        nextSeq: args.initialEventSeq,
        ...(args.sessionId ? { sessionId: args.sessionId } : {}),
        ...(args.gameIndex !== undefined ? { gameIndex: args.gameIndex } : {}),
      },
    },
    { upsert: true }
  );
}

/**
 * Finalize a match: write the full event log + final scores +
 * `status: "finished"` in a single update. Called once per match,
 * after the `match_end` event has been emitted.
 */
export async function archiveMatch(args: ArchiveMatchArgs): Promise<void> {
  const now = new Date();
  const nextSeq =
    args.events.length === 0
      ? 0
      : assertContiguousMatchEvents(args.events).nextSeq;
  const setOps: Record<string, unknown> = {
    status: "finished",
    endedAt: now,
    events: args.events.map((e) => ({
      seq: e.seq,
      timestamp: new Date(e.emittedAt),
      event: e.event,
    })),
    nextSeq,
  };
  for (const fs of args.finalScores) {
    setOps[`players.${fs.seat}.finalScore`] = fs.score;
    setOps[`players.${fs.seat}.place`] = fs.place;
  }
  await MatchModel.updateOne({ _id: args.matchId }, { $set: setOps });
}

function journalEventDocuments(events: PersistedMatchEvent[]) {
  return events.map((entry) => ({
    seq: entry.seq,
    timestamp: new Date(entry.emittedAt),
    event: entry.event,
  }));
}

export async function appendMatchEvents(args: {
  matchId: string;
  events: PersistedMatchEvent[];
}): Promise<void> {
  const { firstSeq, nextSeq } = assertContiguousMatchEvents(args.events);
  const result = await MatchModel.updateOne(
    {
      _id: args.matchId,
      status: "playing",
      nextSeq: firstSeq,
    },
    {
      $push: { events: { $each: journalEventDocuments(args.events) } },
      $set: { nextSeq },
    }
  );
  if (result.modifiedCount === 1) {
    return;
  }
  const stored = (await MatchModel.findById(
    args.matchId,
    { status: 1, nextSeq: 1 }
  ).lean()) as
    | { status?: "playing" | "finished" | "aborted"; nextSeq?: number }
    | null;
  if (stored === null) {
    throw new Error(`Cannot append events for unknown match ${args.matchId}`);
  }
  if (stored.status !== "playing" || (stored.nextSeq ?? 0) >= nextSeq) {
    return;
  }
  throw new Error(
    `Match ${args.matchId} expected event seq ${stored.nextSeq ?? 0}, got ${firstSeq}`
  );
}

export async function loadMatchEventJournalState(
  matchId: string
): Promise<{
  status: "playing" | "finished" | "aborted";
  nextSeq: number;
} | null> {
  const stored = (await MatchModel.findById(
    matchId,
    { status: 1, nextSeq: 1 }
  ).lean()) as
    | { status?: "playing" | "finished" | "aborted"; nextSeq?: number }
    | null;
  if (stored === null || stored.status === undefined) {
    return null;
  }
  return { status: stored.status, nextSeq: stored.nextSeq ?? 0 };
}

/**
 * Phase 4.5: write the cross-platform `ReplayLog` row for an in-app
 * match. Called from `MatchProcess.endMatch` right after
 * `archiveMatch`. Idempotent: `(source, sourceGameId)` is unique,
 * so retrying a finalize after a write failure either succeeds or
 * is a no-op upsert.
 *
 * Per-platform adapters (Majsoul, Tenhou, Riichi City) will call
 * the same `replaylogs` collection from the portal-side hydration
 * pipeline — this helper is the in-app source equivalent.
 */
export async function archiveReplayLog(args: {
  matchId: string;
  /** Replay source; defaults to "ingame" (engine matches). Relay matches pass e.g. "tenhou". */
  source?: string;
  /** Platform-native game id; defaults to `matchId`. */
  sourceGameId?: string;
  startedAt: Date;
  endedAt: Date;
  ruleSet: string;
  ruleSetDetails?: Record<string, unknown>;
  events: GameEvent[];
  seats: Array<{
    seat: 0 | 1 | 2 | 3;
    userDbId?: string;
    displayName: string;
    finalScore: number;
    place: 1 | 2 | 3 | 4;
  }>;
}): Promise<void> {
  const source = args.source ?? "ingame";
  const sourceGameId = args.sourceGameId ?? args.matchId;
  const seats = args.seats.map(({ userDbId, ...seat }) => ({
    ...seat,
    ...(userDbId && mongoose.isValidObjectId(userDbId)
      ? { userDbId: new mongoose.Types.ObjectId(userDbId) }
      : {}),
  }));
  await ReplayLogModel.updateOne(
    { source, sourceGameId },
    {
      $set: {
        source,
        sourceGameId,
        ruleSet: args.ruleSet,
        ruleSetDetails: args.ruleSetDetails,
        startedAt: args.startedAt.getTime(),
        endedAt: args.endedAt.getTime(),
        seats,
        events: args.events,
        schemaVersion: REPLAY_LOG_SCHEMA_VERSION,
        parsedAt: new Date(),
      },
    },
    { upsert: true }
  );
}

export async function saveMatchCheckpoint(args: {
  matchId: string;
  checkpoint: MatchCheckpoint;
}): Promise<void> {
  const checkpoint = parseMatchCheckpoint(args.checkpoint);
  await MatchCheckpointModel.updateOne(
    { _id: args.matchId, terminalAt: { $exists: false } },
    { $set: { checkpoint }, $unset: { pendingCommand: "" } },
    { upsert: true }
  );
}

export async function saveMatchCommandTransaction(args: {
  matchId: string;
  checkpoint: MatchCheckpoint;
  command: PendingMatchCommand;
}): Promise<void> {
  const checkpoint = parseMatchCheckpoint(args.checkpoint);
  const command = PendingMatchCommandSchema.parse(args.command);
  parseMatchRecoveryRecord({ checkpoint, pendingCommand: command });
  await MatchCheckpointModel.updateOne(
    { _id: args.matchId, terminalAt: { $exists: false } },
    { $set: { checkpoint, pendingCommand: command } },
    { upsert: true }
  );
}

export async function loadMatchRecoveryRecord(
  matchId: string
): Promise<MatchRecoveryRecord | null> {
  const stored = (await MatchCheckpointModel.findById(matchId).lean()) as
    | {
        checkpoint?: unknown;
        pendingCommand?: unknown;
        terminalAt?: Date;
      }
    | null;
  return stored?.terminalAt !== undefined || stored?.checkpoint === undefined
    ? null
    : parseMatchRecoveryRecord({
        checkpoint: stored.checkpoint,
        pendingCommand: stored.pendingCommand ?? null,
      });
}

export async function loadMatchCheckpoint(
  matchId: string
): Promise<MatchCheckpoint | null> {
  return (await loadMatchRecoveryRecord(matchId))?.checkpoint ?? null;
}

export async function markMatchCheckpointTerminal(args: {
  matchId: string;
  finishedAt: number;
}): Promise<void> {
  await MatchCheckpointModel.updateOne(
    { _id: args.matchId },
    {
      $set: { terminalAt: new Date(args.finishedAt) },
      $unset: { checkpoint: "", pendingCommand: "" },
    }
  );
}

export async function deleteMatchCheckpoint(matchId: string): Promise<void> {
  await MatchCheckpointModel.deleteOne({ _id: matchId });
}

export const mongoMatchRepository: MatchRepository = {
  createMatch: (args) => createMatchDoc(args),
  archiveMatch: (args) => archiveMatch(args),
  archiveReplayLog: (args) => archiveReplayLog(args),
  saveCheckpoint: (args) => saveMatchCheckpoint(args),
  saveCommandTransaction: (args) => saveMatchCommandTransaction(args),
  loadCheckpoint: (matchId) => loadMatchCheckpoint(matchId),
  loadRecoveryRecord: (matchId) => loadMatchRecoveryRecord(matchId),
  markCheckpointTerminal: (args) => markMatchCheckpointTerminal(args),
  deleteCheckpoint: (matchId) => deleteMatchCheckpoint(matchId),
};

export const mongoMatchEventJournalStore: MatchEventJournalStore = {
  appendMatchEvents: (args) => appendMatchEvents(args),
  loadMatchEventJournalState: (matchId) =>
    loadMatchEventJournalState(matchId),
};

/**
 * Read finished-match events with `seq >= fromSeq`. Returns `[]`
 * for in-progress matches (their events live only in the resident
 * `MatchProcess` until `archiveMatch` runs) and for unknown matches.
 */
export async function loadMatchEvents(
  matchId: string,
  fromSeq: number
): Promise<Array<{ seq: number; event: GameEvent }>> {
  const doc = await MatchModel.findById(matchId).lean();
  if (!doc) {
    return [];
  }
  return doc.events
    .filter((e: { seq: number }) => e.seq >= fromSeq)
    .map((e: { seq: number; event: unknown }) => ({
      seq: e.seq,
      event: e.event as GameEvent,
    }));
}

/**
 * Look up the persisted status of a match doc. Used by the WS
 * upgrade handler to detect the dangerous case "client wants to
 * reconnect to a match that was previously playing but whose
 * `MatchProcess` is no longer resident" (e.g. game-server
 * restart). Returns `null` for unknown matches.
 */
export async function getMatchStatus(
  matchId: string
): Promise<"playing" | "finished" | null> {
  const doc = await MatchModel.findById(matchId, { status: 1 }).lean();
  if (!doc) {
    return null;
  }
  return doc.status as "playing" | "finished";
}
