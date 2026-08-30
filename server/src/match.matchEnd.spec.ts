/**
 * Match-end orchestrator integration test.
 *
 * Validates that when the engine reports `phase === "match_ended"`
 * (round limit exceeded), the orchestrator:
 *   - Emits exactly one `match_end` wire event.
 *   - Carries the engine's authoritative `finalScores` (NOT the old
 *     placeholder `25000` × 4) and computes per-seat `place` from
 *     them, with ties broken by seat-from-dealer order.
 *   - Persists via `archiveMatch` once (single Mongo write at end).
 *
 * Mongo is mocked. We bypass the slow random-bot turn loop by
 * mutating the orchestrator's internal `state` to "just-finished a
 * hand at the round limit", then invoking the private
 * `afterHandEnd()` directly.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { archiveMatchMock, archiveReplayLogMock } = vi.hoisted(() => ({
  archiveMatchMock: vi.fn(async () => undefined),
  archiveReplayLogMock: vi.fn(async () => undefined),
}));

import {
  MatchProcess,
  setNextHandDelayMs,
  setDelayAfterDiscardMs,
} from "./match";
import type { GameEvent, ServerMessage } from "~/game/protocol/messages";
import { REPLAY_LOG_SCHEMA_VERSION } from "~/game/replay/types";
import type { ReplayLog } from "~/game/replay/types";
import { replayReducer } from "~/game/replay/player";
import type { MatchRepository } from "./repository";
import type { MatchEventJournalStore } from "./repository";

const recordingRepository: MatchRepository = {
  createMatch: async () => undefined,
  archiveMatch: archiveMatchMock,
  archiveReplayLog: archiveReplayLogMock,
  saveCheckpoint: async () => undefined,
  saveCommandTransaction: async () => undefined,
  loadCheckpoint: async () => null,
  loadRecoveryRecord: async () => null,
  markCheckpointTerminal: async () => undefined,
  deleteCheckpoint: async () => undefined,
};

interface CapturedEvent {
  seq: number;
  event: GameEvent;
}

function captureSink(): {
  sink: (msg: ServerMessage) => void;
  events: CapturedEvent[];
} {
  const events: CapturedEvent[] = [];
  const sink = (msg: ServerMessage): void => {
    if (msg.type === "event") {
      for (const ev of msg.events) {
        events.push({ seq: msg.seq, event: ev });
      }
    }
  };
  return { sink, events };
}

function makeMatch(
  seed: number,
  eventJournalStore?: MatchEventJournalStore
): MatchProcess {
  return new MatchProcess(
    `m-${seed}-${Math.random().toString(36).slice(2, 8)}`,
    seed,
    [
      { userId: "u0", displayName: "Human", isBot: false },
      { userId: "u1", displayName: "Bot1", isBot: true },
      { userId: "u2", displayName: "Bot2", isBot: true },
      { userId: "u3", displayName: "Bot3", isBot: true },
    ],
    { repository: recordingRepository, eventJournalStore },
    undefined,
    undefined,
    "tenhou-hanchan"
  );
}

interface InternalState {
  phase: string;
  scores: number[];
  riichiSticks: number;
  dealer: number;
  roundNumber: number;
  roundWind: "E" | "S" | "W" | "N";
  lastHandResult: {
    reason: string;
    winner: number | null;
    loser: number | null;
    delta: number[];
    tenpai: boolean[] | null;
    abortKind: string | null;
  } | null;
  ruleSet: { roundWindCount: number };
}

interface MatchInternals {
  state: InternalState;
  afterHandEnd: () => Promise<void>;
}

describe("MatchProcess — match-end transition", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setNextHandDelayMs(0);
    setDelayAfterDiscardMs(0);
  });
  afterEach(() => {
    vi.clearAllMocks();
    setNextHandDelayMs(3000);
    setDelayAfterDiscardMs(350);
  });

  it("supersedes queued journal events before writing the complete archive", async () => {
    let releaseAppend!: () => void;
    const heldAppend = new Promise<void>((resolve) => {
      releaseAppend = resolve;
    });
    const appendMatchEvents = vi.fn(async () => {
      await heldAppend;
    });
    const eventJournalStore: MatchEventJournalStore = {
      appendMatchEvents,
      loadMatchEventJournalState: async () => null,
    };
    const m = makeMatch(91, eventJournalStore);
    await m.start();
    const internals = m as unknown as MatchInternals;
    internals.state.phase = "hand_ended";
    internals.state.scores = [38000, 30000, 20000, 10000];
    internals.state.riichiSticks = 0;
    internals.state.dealer = 3;
    internals.state.roundWind = "E";
    internals.state.roundNumber = 4;
    internals.state.ruleSet.roundWindCount = 1;
    internals.state.lastHandResult = {
      reason: "exhaustive_draw",
      winner: null,
      loser: null,
      delta: [0, 0, 0, 0],
      tenpai: [false, false, false, false],
      abortKind: null,
    };
    archiveMatchMock.mockClear();

    const ending = internals.afterHandEnd();
    await new Promise((resolve) => setImmediate(resolve));
    expect(archiveMatchMock).not.toHaveBeenCalled();
    expect(appendMatchEvents).toHaveBeenCalledTimes(1);

    releaseAppend();
    await ending;
    expect(appendMatchEvents).toHaveBeenCalledTimes(1);
    expect(archiveMatchMock).toHaveBeenCalledTimes(1);
    const archiveCalls = archiveMatchMock.mock.calls as unknown as Array<
      [Parameters<MatchRepository["archiveMatch"]>[0]]
    >;
    const archived = archiveCalls[0][0];
    expect(archived.events.at(-1)?.event.type).toBe("match_end");
  });

  it("emits match_end with real engine scores when the round limit is exceeded", async () => {
    const m = makeMatch(1);
    const { sink, events } = captureSink();
    m.attachHuman(0, sink);
    await m.start();

    const internals = m as unknown as MatchInternals;
    // Force the engine into "just finished the last hand of the
    // last round wind" with non-tenpai dealer so `start_next_hand`
    // rotates the dealer past the round limit and ends the match.
    internals.state.phase = "hand_ended";
    internals.state.scores = [38000, 30000, 20000, 10000];
    internals.state.riichiSticks = 2;
    internals.state.dealer = 3;
    internals.state.roundWind = "E";
    internals.state.roundNumber =
      internals.state.ruleSet.roundWindCount === 1 ? 4 : 4; // E4 of an east-only or hanchan E-round; we'll force wind exhaust below
    internals.state.ruleSet.roundWindCount = 1; // east-only — E4 is the last hand
    internals.state.lastHandResult = {
      reason: "exhaustive_draw",
      winner: null,
      loser: null,
      delta: [0, 0, 0, 0],
      tenpai: [false, false, false, false], // dealer (seat 3) NOT tenpai → rotates
      abortKind: null,
    };

    // Reset captured events so we only inspect the match_end batch.
    events.length = 0;
    archiveMatchMock.mockClear();

    await internals.afterHandEnd();

    expect(internals.state.scores).toEqual([40000, 30000, 20000, 10000]);
    expect(internals.state.riichiSticks).toBe(0);

    const matchEnds = events.filter((e) => e.event.type === "match_end");
    expect(matchEnds).toHaveLength(1);
    if (matchEnds[0].event.type === "match_end") {
      const fs = matchEnds[0].event.finalScores;
      // Final scores match the engine's `state.scores` (NOT the old
      // 25000-placeholder behaviour).
      const bySeatScore = new Map(fs.map((f) => [f.seat, f.score]));
      expect(bySeatScore.get(0)).toBe(40000);
      expect(bySeatScore.get(1)).toBe(30000);
      expect(bySeatScore.get(2)).toBe(20000);
      expect(bySeatScore.get(3)).toBe(10000);
      // Place ranking matches score order, ties broken by seat asc.
      const bySeatPlace = new Map(fs.map((f) => [f.seat, f.place]));
      expect(bySeatPlace.get(0)).toBe(1);
      expect(bySeatPlace.get(1)).toBe(2);
      expect(bySeatPlace.get(2)).toBe(3);
      expect(bySeatPlace.get(3)).toBe(4);
    }
    expect(archiveMatchMock).toHaveBeenCalledTimes(1);
    const calls = archiveMatchMock.mock.calls as unknown as Array<
      [{ finalScores: Array<{ seat: number; score: number; place: number }> }]
    >;
    const finalizeArg = calls[0][0];
    const persistedScores = new Map(
      finalizeArg.finalScores.map((f) => [f.seat, f.score])
    );
    expect(persistedScores.get(0)).toBe(40000);
    expect(persistedScores.get(3)).toBe(10000);

    // Phase 4.5: `archiveReplayLog` is invoked alongside
    // `archiveMatch` with a structurally-valid `ReplayLog`.
    expect(archiveReplayLogMock).toHaveBeenCalledTimes(1);
    const replayCalls = archiveReplayLogMock.mock.calls as unknown as Array<
      [
        {
          matchId: string;
          startedAt: Date;
          endedAt: Date;
          ruleSet: string;
          events: GameEvent[];
          seats: Array<{
            seat: number;
            displayName: string;
            finalScore: number;
            place: number;
          }>;
        },
      ]
    >;
    const replayArg = replayCalls[0][0];
    expect(replayArg.matchId).toBe(
      (m as unknown as { matchId: string }).matchId
    );
    expect(replayArg.startedAt.getTime()).toBeLessThanOrEqual(
      replayArg.endedAt.getTime()
    );
    expect(replayArg.seats).toHaveLength(4);
    // Same final scores end up in the replay row.
    const replayBySeat = new Map(replayArg.seats.map((s) => [s.seat, s]));
    expect(replayBySeat.get(0)?.finalScore).toBe(40000);
    expect(replayBySeat.get(0)?.place).toBe(1);
    expect(replayBySeat.get(3)?.finalScore).toBe(10000);
    expect(replayBySeat.get(3)?.place).toBe(4);
    // The events stream contains the `match_end` event we just
    // observed on the wire.
    expect(replayArg.events.some((e) => e.type === "match_end")).toBe(true);
    // The version stamp is the one we'd write to Mongo.
    expect(REPLAY_LOG_SCHEMA_VERSION).toBeGreaterThanOrEqual(1);

    // End-to-end through the Phase 4.5 reducer: build a ReplayLog
    // from the writer args + fold every event. The final view must
    // report the same finalScores the engine emitted on the wire.
    const log: ReplayLog = {
      source: "ingame",
      sourceGameId: replayArg.matchId,
      ruleSet: replayArg.ruleSet,
      startedAt: replayArg.startedAt.getTime(),
      endedAt: replayArg.endedAt.getTime(),
      seats: replayArg.seats as ReplayLog["seats"],
      events: replayArg.events,
      schemaVersion: REPLAY_LOG_SCHEMA_VERSION,
    };
    const finalView = replayReducer(log, log.events.length - 1);
    expect(finalView.matchEnded).not.toBeNull();
    const replayedScores = new Map(
      finalView.matchEnded!.finalScores.map((f) => [f.seat, f.score])
    );
    expect(replayedScores.get(0)).toBe(40000);
    expect(replayedScores.get(3)).toBe(10000);
  });

  it("breaks ties by seat order (closer to dealer wins on equal score)", async () => {
    const m = makeMatch(2);
    const { sink, events } = captureSink();
    m.attachHuman(0, sink);
    await m.start();

    const internals = m as unknown as MatchInternals;
    internals.state.phase = "hand_ended";
    internals.state.scores = [25000, 25000, 25000, 25000];
    internals.state.dealer = 3;
    internals.state.roundWind = "E";
    internals.state.roundNumber = 4;
    internals.state.ruleSet.roundWindCount = 1;
    internals.state.lastHandResult = {
      reason: "exhaustive_draw",
      winner: null,
      loser: null,
      delta: [0, 0, 0, 0],
      tenpai: [false, false, false, false],
      abortKind: null,
    };

    events.length = 0;
    await internals.afterHandEnd();

    const matchEnd = events.find((e) => e.event.type === "match_end");
    expect(matchEnd).toBeTruthy();
    if (matchEnd && matchEnd.event.type === "match_end") {
      const bySeat = new Map(
        matchEnd.event.finalScores.map((f) => [f.seat, f])
      );
      // All scores equal → places assigned in seat order 0,1,2,3.
      expect(bySeat.get(0)?.place).toBe(1);
      expect(bySeat.get(1)?.place).toBe(2);
      expect(bySeat.get(2)?.place).toBe(3);
      expect(bySeat.get(3)?.place).toBe(4);
    }
  });
});
