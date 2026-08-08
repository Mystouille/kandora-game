/**
 * Mongo persistence for `MatchProcess`.
 *
 * Design:
 *
 *   - **Mid-match durability lives in RAM.** The per-match
 *     `MatchProcess` holds the live event log in memory; Mongo is
 *     not in the per-event hot path.
 *   - **Mongo is the archive.** We write exactly two times per
 *     match: `createMatchDoc` at start (so lobby/portal can see
 *     "match X exists, status playing") and `archiveMatch` at end
 *     (writes the full event log + final scores in one shot).
 *   - **No crash recovery.** A game-server restart drops every
 *     in-flight `MatchProcess`. Reconnects to a no-longer-resident
 *     match are refused by the WS upgrade handler (it consults
 *     `getMatchStatus` and returns `match_lost`). This trade keeps
 *     the architecture simple; the cost is bounded by restart
 *     frequency.
 *
 * Reading: `loadMatchEvents` returns the finished-match event log
 * (or `[]` for an in-progress match — those events live only in
 * the resident `MatchProcess`).
 */
import { MatchModel, type MatchPlayer } from "~/db/models/Match";
import { ReplayLogModel } from "~/db/models/ReplayLog";
import type { GameEvent } from "~/game/protocol/messages";
import { REPLAY_LOG_SCHEMA_VERSION } from "~/game/replay/types";

export async function createMatchDoc(args: {
  matchId: string;
  seed: number;
  players: MatchPlayer[];
  sessionId?: string;
  gameIndex?: number;
}): Promise<void> {
  await MatchModel.create({
    _id: args.matchId,
    seed: args.seed,
    players: args.players,
    status: "playing",
    startedAt: new Date(),
    events: [],
    nextSeq: 0,
    ...(args.sessionId ? { sessionId: args.sessionId } : {}),
    ...(args.gameIndex !== undefined ? { gameIndex: args.gameIndex } : {}),
  });
}

/**
 * Finalize a match: write the full event log + final scores +
 * `status: "finished"` in a single update. Called once per match,
 * after the `match_end` event has been emitted.
 */
export async function archiveMatch(args: {
  matchId: string;
  events: Array<{ seq: number; event: GameEvent }>;
  finalScores: Array<{ seat: number; score: number; place: number }>;
}): Promise<void> {
  const now = new Date();
  const setOps: Record<string, unknown> = {
    status: "finished",
    endedAt: now,
    events: args.events.map((e) => ({
      seq: e.seq,
      timestamp: now,
      event: e.event,
    })),
    nextSeq: args.events.length,
  };
  for (const fs of args.finalScores) {
    setOps[`players.${fs.seat}.finalScore`] = fs.score;
    setOps[`players.${fs.seat}.place`] = fs.place;
  }
  await MatchModel.updateOne({ _id: args.matchId }, { $set: setOps });
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
    displayName: string;
    finalScore: number;
    place: 1 | 2 | 3 | 4;
  }>;
}): Promise<void> {
  const source = args.source ?? "ingame";
  const sourceGameId = args.sourceGameId ?? args.matchId;
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
        seats: args.seats,
        events: args.events,
        schemaVersion: REPLAY_LOG_SCHEMA_VERSION,
        parsedAt: new Date(),
      },
    },
    { upsert: true }
  );
}

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
