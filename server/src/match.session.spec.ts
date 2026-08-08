/**
 * Buu multi-game session orchestration.
 *
 * Validates the post-`match_end` flow when `ruleSet.buuMode` is on:
 *   - `match_end` carries `chips` / `dabuken` / `gameIndex`.
 *   - A `session_vote_open` event opens the continue-vote window.
 *   - Bots auto-yes; a single human "yes" with 3 bots resolves
 *     immediately. The orchestrator then permutes seats (winner
 *     becomes East), carries chips/dabuken, and emits a fresh
 *     `match_start` + `hand_start` for game 1.
 *   - Each game writes its own `Match` doc (`${matchId}-g${i}`)
 *     with the shared `sessionId`.
 *   - A "no" vote (or timeout) emits `session_end`.
 *   - Non-Buu sessions still emit a single `session_end` with
 *     `reason: "single_game"` immediately after `match_end`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { createMatchDocMock, archiveMatchMock, archiveReplayLogMock } =
  vi.hoisted(() => ({
    createMatchDocMock: vi.fn(async () => undefined),
    archiveMatchMock: vi.fn(async () => undefined),
    archiveReplayLogMock: vi.fn(async () => undefined),
  }));
vi.mock("./persist", () => ({
  createMatchDoc: createMatchDocMock,
  archiveMatch: archiveMatchMock,
  archiveReplayLog: archiveReplayLogMock,
}));

import {
  MatchProcess,
  setNextHandDelayMs,
  setDelayAfterDiscardMs,
  setContinueVoteMs,
  setMatchEndDisplayMs,
} from "./match";
import type { GameEvent, ServerMessage } from "~/game/protocol/messages";

interface CapturedEvent {
  seq: number;
  event: GameEvent;
}

function captureSink(): {
  sink: (msg: ServerMessage) => void;
  events: CapturedEvent[];
  messages: ServerMessage[];
} {
  const events: CapturedEvent[] = [];
  const messages: ServerMessage[] = [];
  const sink = (msg: ServerMessage): void => {
    messages.push(msg);
    if (msg.type === "event") {
      for (const ev of msg.events) {
        events.push({ seq: msg.seq, event: ev });
      }
    }
  };
  return { sink, events, messages };
}

interface InternalState {
  phase: string;
  scores: number[];
  dealer: number;
  roundNumber: number;
  roundWind: "E" | "S" | "W" | "N";
  chips: number[];
  dabuken: boolean[];
  lastHandResult: {
    reason: string;
    winner: number | null;
    loser: number | null;
    delta: number[];
    tenpai: boolean[] | null;
    abortKind: string | null;
  } | null;
  ruleSet: { roundWindCount: number; buuMode: boolean };
}

interface MatchInternals {
  state: InternalState;
  afterHandEnd: () => Promise<void>;
  matchId: string;
  sessionChips: number[];
  sessionDabuken: boolean[];
  gameIndex: number;
  players: Map<number, { userId: string; displayName: string; isBot: boolean }>;
  continueVote: Array<"yes" | "no" | null>;
}

/**
 * Force the engine into "last hand of an East-only round just
 * finished without a tenpai dealer" so `start_next_hand` rotates
 * past the round limit and triggers a match_end.
 */
function forceMatchEndAtScores(
  m: MatchProcess,
  scores: [number, number, number, number],
  opts?: { chips?: [number, number, number, number] }
): void {
  const internals = m as unknown as MatchInternals;
  internals.state.phase = "hand_ended";
  internals.state.scores = [...scores];
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
  if (opts?.chips) {
    internals.state.chips = [...opts.chips];
  }
}

function makeMatch(opts: {
  seed?: number;
  buu?: boolean;
  humans?: Array<0 | 1 | 2 | 3>;
}): MatchProcess {
  const seed = opts.seed ?? 1;
  const humans = new Set(opts.humans ?? [0]);
  const players = [0, 1, 2, 3].map((i) => ({
    userId: `u${i}`,
    displayName: humans.has(i as 0 | 1 | 2 | 3) ? `Human${i}` : `Bot${i}`,
    isBot: !humans.has(i as 0 | 1 | 2 | 3),
  }));
  return new MatchProcess(
    `m-${seed}-${Math.random().toString(36).slice(2, 8)}`,
    seed,
    players,
    undefined,
    opts.buu
      ? {
          buuMode: true,
          roundWindCount: 1,
          startingScore: 6000,
          // Buu-east defaults needed by the end-of-game chip
          // settlement: anyone below 6000 sinks; payouts are
          // 5/3/1 for sankoro/nikoro/chinmai.
          sinkThreshold: 5999,
          chipPayouts: { sankoro: 5, nikoro: 3, chinmai: 1 },
        }
      : undefined
  );
}

describe("MatchProcess — Buu multi-game session", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setNextHandDelayMs(0);
    setDelayAfterDiscardMs(0);
    setContinueVoteMs(0); // 0 disables the wall-clock timeout
    setMatchEndDisplayMs(0); // skip the post-match_end display hold
  });
  afterEach(() => {
    vi.clearAllMocks();
    setNextHandDelayMs(3000);
    setDelayAfterDiscardMs(350);
    setMatchEndDisplayMs(3000);
    setContinueVoteMs(30_000);
  });

  it("non-Buu match emits session_end:single_game after match_end", async () => {
    const m = makeMatch({ seed: 1, buu: false });
    const { sink, events } = captureSink();
    m.attachHuman(0, sink);
    await m.start();
    forceMatchEndAtScores(m, [40000, 30000, 20000, 10000]);
    events.length = 0;

    await (m as unknown as MatchInternals).afterHandEnd();

    const matchEnds = events.filter((e) => e.event.type === "match_end");
    expect(matchEnds).toHaveLength(1);
    const sessionEnds = events.filter((e) => e.event.type === "session_end");
    expect(sessionEnds).toHaveLength(1);
    if (sessionEnds[0].event.type === "session_end") {
      expect(sessionEnds[0].event.reason).toBe("single_game");
      expect(sessionEnds[0].event.gamesPlayed).toBe(1);
      expect(sessionEnds[0].event.chips).toEqual([0, 0, 0, 0]);
    }
    // Non-Buu session never opens a vote.
    expect(events.some((e) => e.event.type === "session_vote_open")).toBe(
      false
    );
  });

  it("Buu match emits match_end with chips/dabuken/gameIndex + opens vote", async () => {
    const m = makeMatch({ seed: 7, buu: true });
    const { sink, events } = captureSink();
    m.attachHuman(0, sink);
    await m.start();

    // Pre-seed chips in the engine so match_end carries them.
    // Scores: seat 0 wins (9000), seats 2 (5000) and 3 (4000)
    // sink — that's a nikoro (per-sinker chinmai chip ×2 sinkers,
    // wait, nikoro base = 3). Seat 0 holds a dabuken from a
    // previous game so the end-of-game settlement consumes it
    // and doubles to perSinker = 6, chipDelta = [12, 0, -6, -6],
    // resulting in post-settlement chips = [15, 0, -6, -9]. All
    // dabuken tokens are then wiped (nikoro never awards a fresh
    // one).
    forceMatchEndAtScores(m, [9000, 6000, 5000, 4000], {
      chips: [3, 0, 0, -3],
    });
    const internals = m as unknown as MatchInternals;
    internals.state.dabuken = [true, false, false, false];

    events.length = 0;
    // The vote will resolve "yes" because 3 bots auto-yes and the
    // human (seat 0) hasn't voted yet — but the orchestrator only
    // proceeds on unanimous yes. So this call will block.
    const done = internals.afterHandEnd();

    // Allow microtasks to run so the vote opens.
    await new Promise((r) => setImmediate(r));

    const matchEnds = events.filter((e) => e.event.type === "match_end");
    expect(matchEnds).toHaveLength(1);
    if (matchEnds[0].event.type === "match_end") {
      // Post-settlement: nikoro × doubled-by-dabuken.
      expect(matchEnds[0].event.chips).toEqual([15, 0, -6, -9]);
      // Winner's dabuken was consumed; no fresh award on nikoro.
      expect(matchEnds[0].event.dabuken).toEqual([false, false, false, false]);
      expect(matchEnds[0].event.gameIndex).toBe(0);
    }
    const voteOpens = events.filter(
      (e) => e.event.type === "session_vote_open"
    );
    expect(voteOpens).toHaveLength(1);
    if (voteOpens[0].event.type === "session_vote_open") {
      // Seat 0 is the human (null); seats 1/2/3 are bots (pre-voted yes).
      expect(voteOpens[0].event.votes).toEqual([null, "yes", "yes", "yes"]);
    }

    // Cast the human's yes vote → unanimous → next game starts.
    m.handleVoteContinue(0, "yes");
    await done;

    // After resolving: a fresh match_start was emitted for game 1.
    const matchStarts = events.filter((e) => e.event.type === "match_start");
    // Game 0's match_start was emitted in `start()` (before our reset);
    // events.length was cleared after start(), so any match_start now
    // is the game-1 one. (start() emits before forceMatchEnd, but we
    // cleared events after start, so this is purely from game 1.)
    expect(matchStarts.length).toBeGreaterThanOrEqual(1);
    // Game 1's match_start must carry the post-game-0 chips,
    // permuted so the winner (place 1, seat 0) lands at seat 0.
    // seed=7 → game-0 chips [3, 0, 0, -3], winner=seat 0 (place 1).
    // Perm puts winner at seat 0; non-winners shuffled
    // deterministically from seed.
    if (matchStarts[0].event.type === "match_start") {
      const chipsAtStart = matchStarts[0].event.chips;
      expect(chipsAtStart).toBeDefined();
      // The winner's post-settlement chips MUST be preserved
      // (now at seat 0): old seat 0 = 15.
      expect(chipsAtStart?.[0]).toBe(15);
      // Sum of chips is conserved across permutation.
      expect((chipsAtStart ?? []).reduce((a, b) => a + b, 0)).toBe(0);
    }

    // gameIndex advanced; another Match doc was created for game 1.
    expect(internals.gameIndex).toBe(1);
    expect(createMatchDocMock).toHaveBeenCalledTimes(2);
    const calls = createMatchDocMock.mock.calls as unknown as Array<
      [{ matchId: string; sessionId?: string; gameIndex?: number }]
    >;
    const sessionId = (m as unknown as { matchId: string }).matchId;
    expect(calls[0][0].matchId).toBe(`${sessionId}-g0`);
    expect(calls[0][0].sessionId).toBe(sessionId);
    expect(calls[0][0].gameIndex).toBe(0);
    expect(calls[1][0].matchId).toBe(`${sessionId}-g1`);
    expect(calls[1][0].sessionId).toBe(sessionId);
    expect(calls[1][0].gameIndex).toBe(1);
  });

  it("Buu vote: human votes no → session ends with vote_no", async () => {
    const m = makeMatch({ seed: 11, buu: true });
    const { sink, events } = captureSink();
    m.attachHuman(0, sink);
    await m.start();
    forceMatchEndAtScores(m, [9000, 6000, 5000, 4000]);
    const internals = m as unknown as MatchInternals;
    events.length = 0;
    const done = internals.afterHandEnd();
    await new Promise((r) => setImmediate(r));

    m.handleVoteContinue(0, "no");
    await done;

    const sessionEnds = events.filter((e) => e.event.type === "session_end");
    expect(sessionEnds).toHaveLength(1);
    if (sessionEnds[0].event.type === "session_end") {
      expect(sessionEnds[0].event.reason).toBe("vote_no");
      expect(sessionEnds[0].event.gamesPlayed).toBe(1);
    }
    // No second-game Match doc.
    expect(createMatchDocMock).toHaveBeenCalledTimes(1);
    // Game 0 was archived once.
    expect(archiveMatchMock).toHaveBeenCalledTimes(1);
  });

  it("Buu vote: timeout ends the session with vote_timeout", async () => {
    setContinueVoteMs(20); // 20 ms — short but non-zero so timer arms
    const m = makeMatch({ seed: 13, buu: true });
    const { sink, events } = captureSink();
    m.attachHuman(0, sink);
    await m.start();
    forceMatchEndAtScores(m, [9000, 6000, 5000, 4000]);
    events.length = 0;
    await (m as unknown as MatchInternals).afterHandEnd();

    const sessionEnds = events.filter((e) => e.event.type === "session_end");
    expect(sessionEnds).toHaveLength(1);
    if (sessionEnds[0].event.type === "session_end") {
      expect(sessionEnds[0].event.reason).toBe("vote_timeout");
    }
  });

  it("Buu next-game: winner becomes seat 0 and carries chips/dabuken", async () => {
    const m = makeMatch({ seed: 21, buu: true });
    const { sink, events } = captureSink();
    m.attachHuman(0, sink);
    await m.start();

    // Seat 2 wins; pre-game chips arranged seat-0:1, seat-2:5.
    // End-of-game settlement: only seat 3 (5000) sinks → chinmai
    // (base 1 chip). Seat 2 holds a dabuken → consumed → doubled
    // to 2 chips. chipDelta = [0, 0, 2, -2], post-settlement
    // chips = [1, 0, 7, -5]. Chinmai does NOT award a fresh
    // dabuken — token is wiped.
    forceMatchEndAtScores(m, [6000, 6000, 9000, 5000], {
      chips: [1, 0, 5, -3],
    });
    const internals = m as unknown as MatchInternals;
    internals.state.dabuken = [false, false, true, false];
    events.length = 0;
    const done = internals.afterHandEnd();
    await new Promise((r) => setImmediate(r));
    m.handleVoteContinue(0, "yes");
    await done;

    // After permutation: new seat 0 = old seat 2 (winner).
    // Winner's post-settlement chips = 7.
    expect(internals.sessionChips[0]).toBe(7);
    // Dabuken was consumed by the chinmai doubling, not re-awarded.
    expect(internals.sessionDabuken[0]).toBe(false);
    // Chips total preserved across the permutation.
    const totalBefore = 1 + 0 + 5 + -3;
    const totalAfter = internals.sessionChips.reduce((a, b) => a + b, 0);
    expect(totalAfter).toBe(totalBefore);

    // New game's state.scores reset to ruleSet starting value.
    expect(internals.state.scores.every((s) => s === 6000)).toBe(true);
    // New game's state.chips/dabuken match the permuted session ledger.
    expect(internals.state.chips).toEqual([...internals.sessionChips]);
    expect(internals.state.dabuken).toEqual([...internals.sessionDabuken]);
  });
});
