/**
 * Multi-human call window resolver — integration test.
 *
 * Validates the concurrent call-window machinery added when
 * `MatchProcess` was generalized to support up to four human seats:
 *
 *   - Each non-discarder human gets an independent call window
 *     (`openCallWindow`) carrying their own `legalActions` and
 *     `pending*` slots.
 *   - `resolveCallWindow` records each response and only fires
 *     `finalizeCallWindow` once every still-open window has
 *     answered, so an early `pass` does NOT prematurely award the
 *     ron to a later seat.
 *   - The head-bumper tie-breaker in `resolveRons` (multi-ron path)
 *     awards a single ron to the unique seat that submitted one
 *     when others passed.
 *
 * Scenario (verbatim from the user request):
 *   - Seats 1, 2, 3 are all tenpai on `4m` with a pinfu + tanyao
 *     hand.
 *   - Seat 0 discards `4m`. Three concurrent call windows open.
 *   - Seat 1 passes (despite having ron available — declines).
 *   - Seat 2 declares ron.
 *   - Seat 3 also has ron available; we sequence them passing as
 *     well so the resolver fires (ron @ priority 4 does NOT
 *     short-circuit other ron windows — multi-ron is preserved).
 *   - Assert: a single `win` event fires for seat 2, with
 *     `loser: 0`, and `hand_end` reports `reason: "ron"`.
 *
 * The 4-bot harness used by the other specs is not reusable here:
 * we need a 4-human factory and direct state mutation to inject a
 * known tenpai configuration (the engine wall is random, so we
 * can't seed our way into a guaranteed pinfu shape).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  MatchProcess,
  setNextHandDelayMs,
  setDelayAfterDiscardMs,
  setActionTimingMs,
  setActionTimeoutMs,
  setReadyCheckMs,
} from "./match";
import {
  ephemeralMatchRepository,
  type MatchRepository,
} from "./repository";
import {
  createInitialState,
  type MatchState,
  type Meld,
} from "~/game/rules";
import type {
  GameEvent,
  LegalAction,
  ServerMessage,
  Tile,
} from "~/game/protocol/messages";

function tiles(value: string): Tile[] {
  const result: Tile[] = [];
  let digits = "";
  for (const character of value) {
    if (character >= "0" && character <= "9") {
      digits += character;
      continue;
    }
    for (const digit of digits) {
      result.push(`${digit}${character}` as Tile);
    }
    digits = "";
  }
  return result;
}

interface SinkHandle {
  send: (msg: ServerMessage) => void;
  events: GameEvent[];
  lastLegals: LegalAction[] | null;
  lastDeadline: number | null | undefined;
}

function makeSink(): SinkHandle {
  const events: GameEvent[] = [];
  let lastLegals: LegalAction[] | null = null;
  // `undefined` = never seen a frame; `null` = explicit clear
  // (deadline omitted from a message that carried legals);
  // number = active deadline.
  let lastDeadline: number | null | undefined = undefined;
  return {
    send: (msg: ServerMessage): void => {
      if (msg.type === "event") {
        for (const ev of msg.events) {
          events.push(ev);
        }
        if (msg.legalActions !== undefined) {
          lastLegals = msg.legalActions;
          lastDeadline = msg.deadline ?? null;
        }
      } else if (msg.type === "snapshot") {
        if (msg.legalActions !== undefined) {
          lastLegals = msg.legalActions;
          lastDeadline = msg.deadline ?? null;
        }
      }
    },
    events,
    get lastLegals(): LegalAction[] | null {
      return lastLegals;
    },
    get lastDeadline(): number | null | undefined {
      return lastDeadline;
    },
  };
}

function makeFourHumanMatch(
  seed: number,
  repository: MatchRepository = ephemeralMatchRepository
): MatchProcess {
  return new MatchProcess(
    `m-${seed}-${Math.random().toString(36).slice(2, 8)}`,
    seed,
    [
      { userId: "u0", displayName: "H0", isBot: false },
      { userId: "u1", displayName: "H1", isBot: false },
      { userId: "u2", displayName: "H2", isBot: false },
      { userId: "u3", displayName: "H3", isBot: false },
    ],
    { repository }
  );
}

/**
 * Minimal view of the orchestrator + engine internals we need to
 * mutate to plant a deterministic tenpai scenario.
 */
interface MatchInternals {
  state: {
    phase: string;
    turn: number;
    hands: Tile[][];
    discards: Tile[][];
    lastDrawn: (Tile | null)[];
    lastDiscard: { seat: number; tile: Tile } | null;
    melds: unknown[][];
    riichiDeclared: [boolean, boolean, boolean, boolean];
    doubleRiichi: [boolean, boolean, boolean, boolean];
    ippatsuEligible: [boolean, boolean, boolean, boolean];
    furitenLocked: [boolean, boolean, boolean, boolean];
    furitenTemp: [boolean, boolean, boolean, boolean];
    pendingShouminkan: unknown | null;
  };
  legalActions: LegalAction[][];
  buildDiscardLegals: (seat: number) => LegalAction[];
  setSeatLegals: (seat: number, actions: LegalAction[]) => void;
}

// Pinfu + tanyao tenpai on 4m / 1m (closed):
//   234p + 234s + 567s + 55m + 23m, ryanmen wait on 23m.
// Winning on 4m completes 234m → 4 sequences + non-yakuhai pair.
const TENPAI_HAND: Tile[] = [
  "2p",
  "3p",
  "4p",
  "2s",
  "3s",
  "4s",
  "5s",
  "6s",
  "7s",
  "5m",
  "5m",
  "2m",
  "3m",
];

// Seat-0 stuffer hand: 13 honor/terminal tiles + drawn "4m" so the
// only meaningful discard is "4m" and no call-relevant shape leaks.
const DISCARDER_HAND: Tile[] = [
  "9m",
  "9m",
  "9m",
  "9p",
  "9p",
  "9p",
  "9s",
  "9s",
  "9s",
  "1z",
  "1z",
  "2z",
  "3z",
];

function plantThreeRonScenario(m: MatchProcess): MatchInternals {
  const internals = m as unknown as MatchInternals;
  internals.state.hands[0] = [...DISCARDER_HAND, "4m"];
  internals.state.hands[1] = [...TENPAI_HAND];
  internals.state.hands[2] = [...TENPAI_HAND];
  internals.state.hands[3] = [...TENPAI_HAND];
  internals.state.lastDrawn = ["4m", null, null, null];
  internals.state.discards = [[], [], [], []];
  internals.state.melds = [[], [], [], []];
  internals.state.lastDiscard = null;
  internals.state.pendingShouminkan = null;
  internals.state.riichiDeclared = [false, false, false, false];
  internals.state.doubleRiichi = [false, false, false, false];
  internals.state.ippatsuEligible = [false, false, false, false];
  internals.state.furitenLocked = [false, false, false, false];
  internals.state.furitenTemp = [false, false, false, false];
  internals.setSeatLegals(0, [
    { id: "discard:4m", type: "discard", tile: "4m" },
  ]);
  return internals;
}

describe("MatchProcess — concurrent call windows (multi-human ron)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setNextHandDelayMs(0);
    setDelayAfterDiscardMs(0);
    setActionTimeoutMs(0);
    setReadyCheckMs(0);
  });
  afterEach(() => {
    setNextHandDelayMs(3000);
    setDelayAfterDiscardMs(350);
    setActionTimeoutMs(30_000);
    setReadyCheckMs(8000);
  });

  it("broadcasts tedashi when a hand copy matches the drawn tile", async () => {
    const m = makeFourHumanMatch(41);
    const sinks = [makeSink(), makeSink(), makeSink(), makeSink()];
    for (let seat = 0; seat < 4; seat++) {
      m.attachHuman(seat as 0 | 1 | 2 | 3, sinks[seat].send);
    }
    await m.start();

    const internals = m as unknown as MatchInternals;
    const drawn = internals.state.lastDrawn[0];
    if (drawn === null) {
      throw new Error("expected seat 0 to have drawn");
    }
    internals.state.hands[0][0] = drawn;
    const legals = internals.buildDiscardLegals(0);
    expect(legals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: `discard:draw:${drawn}`,
          discardSource: "draw",
        }),
        expect.objectContaining({
          id: `discard:hand:${drawn}`,
          discardSource: "hand",
        }),
      ])
    );
    internals.setSeatLegals(0, legals);
    for (const sink of sinks) {
      sink.events.length = 0;
    }

    await m.handleAct(0, `discard:hand:${drawn}`);

    const discard = sinks[0].events.find(
      (event) => event.type === "discard" && event.seat === 0
    );
    expect(discard).toMatchObject({
      type: "discard",
      tile: drawn,
      tsumogiri: false,
      discardSource: "hand",
    });
  });

  it("awards the ron to seat 2 when seat 1 passes and seat 2 calls (seat 3 also passes)", async () => {
    const m = makeFourHumanMatch(42);
    const sinks: SinkHandle[] = [
      makeSink(),
      makeSink(),
      makeSink(),
      makeSink(),
    ];
    m.attachHuman(0, sinks[0].send);
    m.attachHuman(1, sinks[1].send);
    m.attachHuman(2, sinks[2].send);
    m.attachHuman(3, sinks[3].send);
    await m.start();

    const internals = m as unknown as MatchInternals;
    // Sanity: start() must have landed us at seat 0's discard turn.
    expect(internals.state.phase).toBe("awaiting_discard");
    expect(internals.state.turn).toBe(0);

    // Plant the deterministic scenario.
    internals.state.hands[0] = [...DISCARDER_HAND, "4m"];
    internals.state.hands[1] = [...TENPAI_HAND];
    internals.state.hands[2] = [...TENPAI_HAND];
    internals.state.hands[3] = [...TENPAI_HAND];
    internals.state.lastDrawn[0] = "4m";
    internals.state.lastDrawn[1] = null;
    internals.state.lastDrawn[2] = null;
    internals.state.lastDrawn[3] = null;
    internals.state.discards = [[], [], [], []];
    internals.state.melds = [[], [], [], []];
    internals.state.lastDiscard = null;
    internals.state.pendingShouminkan = null;
    internals.state.riichiDeclared = [false, false, false, false];
    internals.state.doubleRiichi = [false, false, false, false];
    internals.state.ippatsuEligible = [false, false, false, false];
    internals.state.furitenLocked = [false, false, false, false];
    internals.state.furitenTemp = [false, false, false, false];

    // Replace seat 0's stale legals (built from the random initial
    // hand) with the only action we want them to take.
    internals.setSeatLegals(0, [
      { id: "discard:4m", type: "discard", tile: "4m" },
    ]);

    // Step 1: seat 0 discards 4m → afterDiscard opens windows for 1/2/3.
    await m.handleAct(0, "discard:4m");

    // Each non-discarder human seat must have a ron option in their
    // call window. Seat 1 also has chi (2m + 3m → 234m), so its
    // ron id is shifted by one; seats 2/3 only have ron.
    const ronId = (seat: 1 | 2 | 3): string => {
      const legals = internals.legalActions[seat];
      const ron = legals.find((a) => a.type === "ron");
      expect(ron, `seat ${seat} should have a ron legal`).toBeDefined();
      // Cast checked above.
      return (ron as LegalAction).id;
    };
    const seat1Ron = ronId(1);
    const seat2Ron = ronId(2);
    const seat3Ron = ronId(3);
    expect(seat1Ron).toBeTruthy();
    expect(seat2Ron).toBeTruthy();
    expect(seat3Ron).toBeTruthy();

    // Step 2: seat 1 passes (declines ron). Window for 1 closes,
    // 2 and 3 stay open. No finalize yet.
    await m.handleAct(1, "pass");
    expect(internals.state.phase).toBe("awaiting_draw");

    // Step 3: seat 2 calls ron. Priority short-circuit MUST NOT
    // close seat 3's window (it also has a ron option @ prio 4,
    // and `4 < 4` is false → preserved for multi-ron).
    await m.handleAct(2, seat2Ron);
    expect(internals.state.phase).toBe("awaiting_draw");

    // Step 4: seat 3 passes. All windows closed → finalize → ron
    // applies for the lone ron candidate (seat 2).
    await m.handleAct(3, "pass");

    // Exactly one `win` event must have fired, and it must be for
    // seat 2 with seat 0 as the loser. We inspect seat 2's sink
    // (the winner) — they see their own win event.
    const winEvents = sinks[2].events.filter((e) => e.type === "win");
    expect(winEvents).toHaveLength(1);
    const win = winEvents[0];
    expect(win.seat).toBe(2);
    expect(win.loser).toBe(0);
    expect(win.winTile).toBe("4m");

    // No other seat should have won.
    for (const otherSeat of [0, 1, 3] as const) {
      const otherWins = sinks[otherSeat].events.filter((e) => e.type === "win");
      // Spectator-style sinks receive every seat's win event
      // (no per-recipient redaction on the win line), so they
      // should also see exactly one win for seat 2 and nothing
      // for themselves.
      expect(otherWins).toHaveLength(1);
      expect(otherWins[0].seat).toBe(2);
    }

    // Hand-end reason must be ron, with seat 2 in the delta winner
    // position (positive delta) and seat 0 paying (negative delta).
    const handEnd = sinks[2].events.find((e) => e.type === "hand_end");
    expect(handEnd, "hand_end event should fire").toBeDefined();
    if (handEnd && handEnd.type === "hand_end") {
      expect(handEnd.reason).toBe("ron");
      const delta = handEnd.delta;
      expect(delta).toBeDefined();
      if (delta) {
        expect(delta[2]).toBeGreaterThan(0);
        expect(delta[0]).toBeLessThan(0);
        expect(delta[1]).toBe(0);
        expect(delta[3]).toBe(0);
      }
    }
  });

  it("restores a partially-answered multi-ron call window", async () => {
    setActionTimingMs({ base: 5_000, grace: 200, buffer: 20_000 });
    const m = makeFourHumanMatch(142);
    await m.start();
    plantThreeRonScenario(m);

    await m.handleAct(0, "discard:4m");
    await m.handleAct(1, "pass");
    const checkpoint = m.createCheckpoint();
    if (
      checkpoint.status !== "playing" ||
      checkpoint.checkpointKind !== "call_window"
    ) {
      throw new Error("expected a call-window checkpoint");
    }
    expect(checkpoint.callWindows[1]).toBeNull();
    expect(checkpoint.pendingHumanCallActions[1]?.type).toBe("pass");
    expect(checkpoint.callWindows[2]).not.toBeNull();
    expect(checkpoint.callWindows[3]).not.toBeNull();

    const restored = MatchProcess.restoreCheckpoint(
      JSON.parse(JSON.stringify(checkpoint)),
      { repository: ephemeralMatchRepository }
    );
    const seat2Ron = checkpoint.callTimers[2]?.legalActions.find(
      (action) => action.type === "ron"
    );
    if (!seat2Ron) {
      throw new Error("expected seat 2 ron");
    }
    await m.handleAct(2, seat2Ron.id);
    await restored.handleAct(2, seat2Ron.id);
    await m.handleAct(3, "pass");
    await restored.handleAct(3, "pass");

    expect(restored.replayFromBuffer(0, 0)).toEqual(
      m.replayFromBuffer(0, 0)
    );
    for (const seat of [0, 1, 2, 3] as const) {
      const originalSnapshot = m.buildSnapshotForSeat(seat);
      const restoredSnapshot = restored.buildSnapshotForSeat(seat);
      if (
        originalSnapshot.type !== "snapshot" ||
        restoredSnapshot.type !== "snapshot"
      ) {
        throw new Error("expected snapshots");
      }
      expect(restoredSnapshot.state).toEqual(originalSnapshot.state);
      expect(restoredSnapshot.legalActions).toEqual(
        originalSnapshot.legalActions
      );
      expect(restoredSnapshot.bufferMs).toBe(originalSnapshot.bufferMs);
    }
  });

  it("rearms a partially-answered call window after save failure", async () => {
    setActionTimingMs({ base: 5_000, grace: 200, buffer: 20_000 });
    const repository: MatchRepository = {
      ...ephemeralMatchRepository,
      saveCheckpoint: async () => {
        throw new Error("call checkpoint write failed");
      },
    };
    const m = makeFourHumanMatch(144, repository);
    await m.start();
    const internals = plantThreeRonScenario(m);
    await m.handleAct(0, "discard:4m");
    await m.handleAct(1, "pass");

    await expect(m.pauseAndSaveCheckpoint()).rejects.toThrow(
      "call checkpoint write failed"
    );
    expect(m.isPaused).toBe(false);
    const rolledBack = m.createCheckpoint();
    if (
      rolledBack.status !== "playing" ||
      rolledBack.checkpointKind !== "call_window"
    ) {
      throw new Error("expected a rolled-back call checkpoint");
    }
    expect(rolledBack.pendingHumanCallActions[1]?.type).toBe("pass");
    expect(rolledBack.callTimers[2]).not.toBeNull();
    expect(rolledBack.callTimers[3]).not.toBeNull();

    const seat2Ron = internals.legalActions[2].find(
      (action) => action.type === "ron"
    );
    if (!seat2Ron) {
      throw new Error("expected seat 2 ron");
    }
    await m.handleAct(2, seat2Ron.id);
    await m.handleAct(3, "pass");
    const win = m
      .replayFromBuffer(0, 0)
      .map(({ event }) => event)
      .find((event) => event.type === "win");
    expect(win).toMatchObject({ type: "win", seat: 2, loser: 0 });
  });

  it("restores a chankan pass window and completes shouminkan", async () => {
    setActionTimingMs({ base: 5_000, grace: 200, buffer: 20_000 });
    const m = makeFourHumanMatch(143);
    await m.start();
    const ponMeld: Meld = {
      type: "pon",
      tiles: ["3m", "3m", "3m"],
      claimedTile: "3m",
      from: 1,
    };
    const base = createInitialState(143);
    const chankanState: MatchState = {
      ...base,
      hands: [
        tiles("3m4p5p6p7p8p9p1s2s3s4s"),
        tiles("1m1m2m2m4m4m5m5m6m6m7m7m3m"),
        Array.from({ length: 13 }, () => "9p"),
        Array.from({ length: 13 }, () => "9p"),
      ],
      discards: [[], [], [], []],
      turn: 0,
      phase: "awaiting_discard",
      lastDrawn: ["3m", null, null, null],
      lastDiscard: null,
      dealer: 0,
      riichiDeclared: [false, true, false, false],
      doubleRiichi: [false, false, false, false],
      ippatsuEligible: [false, false, false, false],
      melds: [[ponMeld], [], [], []],
      pendingShouminkan: null,
      lastHandResult: null,
    };
    const internals = m as unknown as {
      state: MatchState;
      setSeatLegals: (seat: 0, actions: LegalAction[]) => void;
    };
    internals.state = chankanState;
    internals.setSeatLegals(0, [
      {
        id: "kan:shouminkan:3m",
        type: "kan",
        kanKind: "shouminkan",
        tiles: ["3m"],
      },
    ]);

    await m.handleAct(0, "kan:shouminkan:3m");
    const checkpoint = m.createCheckpoint();
    if (
      checkpoint.status !== "playing" ||
      checkpoint.checkpointKind !== "call_window"
    ) {
      throw new Error("expected a chankan checkpoint");
    }
    expect(checkpoint.state.phase).toBe("awaiting_chankan");
    expect(checkpoint.state.pendingShouminkan).toMatchObject({
      seat: 0,
      tile: "3m",
    });
    expect(checkpoint.callTimers[0]).toBeNull();
    expect(checkpoint.callWindows[1]).toEqual([{ kind: "ron" }]);

    const restored = MatchProcess.restoreCheckpoint(checkpoint, {
      repository: ephemeralMatchRepository,
    });
    await m.handleAct(1, "pass");
    await restored.handleAct(1, "pass");

    const originalState = (m as unknown as { state: MatchState }).state;
    const restoredState = (restored as unknown as { state: MatchState }).state;
    expect(restoredState).toEqual(originalState);
    expect(restoredState.phase).toBe("awaiting_discard");
    expect(restoredState.pendingShouminkan).toBeNull();
    expect(restoredState.melds[0][0].type).toBe("shouminkan");
    expect(restored.replayFromBuffer(0, 0)).toEqual(
      m.replayFromBuffer(0, 0)
    );
  });

  it("atamahane: seat 2's ron auto-closes seat 3's still-open ron window (downstream head-bumped)", async () => {
    // Same plant as the multi-ron test, but with the head-bump
    // rule turned on. Sequence: seat 0 discards 4m, then seat 2
    // calls ron directly (without waiting on seat 1 or 3). The
    // atamahane short-circuit must:
    //   - Auto-pass seat 3 (downstream of seat 2 from discarder 0
    //     in head-bump order 1 → 2 → 3) so that window closes
    //     immediately.
    //   - Leave seat 1 open (upstream — could still ron and
    //     out-head-bump seat 2). We then pass seat 1 manually to
    //     drive the finalize.
    // Final: seat 2 wins; no win event for seat 3 (their ron was
    // dropped by atamahane, not even reaching `resolveRons`).
    const m = makeFourHumanMatch(43);
    const sinks: SinkHandle[] = [
      makeSink(),
      makeSink(),
      makeSink(),
      makeSink(),
    ];
    m.attachHuman(0, sinks[0].send);
    m.attachHuman(1, sinks[1].send);
    m.attachHuman(2, sinks[2].send);
    m.attachHuman(3, sinks[3].send);
    await m.start();

    const internals = m as unknown as MatchInternals & {
      callWindow: (unknown | null)[];
      pendingHumanCallActions: (LegalAction | null)[];
      state: MatchInternals["state"] & { ruleSet: { atamahane: boolean } };
    };
    expect(internals.state.phase).toBe("awaiting_discard");
    expect(internals.state.turn).toBe(0);

    // Flip atamahane on for this match.
    internals.state.ruleSet.atamahane = true;

    // Plant the same tenpai scenario.
    internals.state.hands[0] = [...DISCARDER_HAND, "4m"];
    internals.state.hands[1] = [...TENPAI_HAND];
    internals.state.hands[2] = [...TENPAI_HAND];
    internals.state.hands[3] = [...TENPAI_HAND];
    internals.state.lastDrawn[0] = "4m";
    internals.state.lastDrawn[1] = null;
    internals.state.lastDrawn[2] = null;
    internals.state.lastDrawn[3] = null;
    internals.state.discards = [[], [], [], []];
    internals.state.melds = [[], [], [], []];
    internals.state.lastDiscard = null;
    internals.state.pendingShouminkan = null;
    internals.state.riichiDeclared = [false, false, false, false];
    internals.state.doubleRiichi = [false, false, false, false];
    internals.state.ippatsuEligible = [false, false, false, false];
    internals.state.furitenLocked = [false, false, false, false];
    internals.state.furitenTemp = [false, false, false, false];

    internals.setSeatLegals(0, [
      { id: "discard:4m", type: "discard", tile: "4m" },
    ]);

    await m.handleAct(0, "discard:4m");

    // All three non-discarder windows opened.
    expect(internals.callWindow[1]).not.toBeNull();
    expect(internals.callWindow[2]).not.toBeNull();
    expect(internals.callWindow[3]).not.toBeNull();

    const seat2Ron = (() => {
      const ron = internals.legalActions[2].find((a) => a.type === "ron");
      expect(ron).toBeDefined();
      return (ron as LegalAction).id;
    })();

    // Step 2: seat 2 rons. Atamahane short-circuit MUST close
    // seat 3's window (downstream) AND record an auto-pass there,
    // but leave seat 1's window open (upstream).
    await m.handleAct(2, seat2Ron);

    expect(internals.callWindow[3]).toBeNull();
    expect(internals.pendingHumanCallActions[3]?.type).toBe("pass");
    expect(internals.callWindow[1]).not.toBeNull();
    // Resolution must wait on seat 1.
    expect(internals.state.phase).toBe("awaiting_draw");
    // No win yet either.
    expect(sinks[2].events.filter((e) => e.type === "win")).toHaveLength(0);

    // Step 3: seat 1 passes. Finalize runs → seat 2 wins.
    await m.handleAct(1, "pass");

    const winEvents = sinks[2].events.filter((e) => e.type === "win");
    expect(winEvents).toHaveLength(1);
    expect(winEvents[0].seat).toBe(2);
    expect(winEvents[0].loser).toBe(0);

    // Seat 3 must NOT have won — atamahane dropped them before
    // `resolveRons` even saw their ron.
    for (const otherSeat of [0, 1, 3] as const) {
      const wins = sinks[otherSeat].events.filter((e) => e.type === "win");
      expect(wins).toHaveLength(1);
      expect(wins[0].seat).toBe(2);
    }

    const handEnd = sinks[2].events.find((e) => e.type === "hand_end");
    expect(handEnd).toBeDefined();
    if (handEnd && handEnd.type === "hand_end") {
      expect(handEnd.reason).toBe("ron");
    }
  });

  it("flushes empty legals + cleared deadline to the submitter and to dominated seats immediately on call submission", async () => {
    // The HUD timer keeps ticking unless the server pushes a fresh
    // legals frame after closing a seat's call window. This test
    // covers two paths in `resolveCallWindow`:
    //   1. the submitter's own seat (their window closes the moment
    //      they submit — they shouldn't sit on a dead timer while
    //      we wait for upstream/equal-priority seats to resolve);
    //   2. seats force-passed by the atamahane short-circuit when
    //      a downstream ron is dominated by an upstream ron.
    // Same plant as the atamahane test above.
    const m = makeFourHumanMatch(44);
    const sinks: SinkHandle[] = [
      makeSink(),
      makeSink(),
      makeSink(),
      makeSink(),
    ];
    m.attachHuman(0, sinks[0].send);
    m.attachHuman(1, sinks[1].send);
    m.attachHuman(2, sinks[2].send);
    m.attachHuman(3, sinks[3].send);
    await m.start();

    const internals = m as unknown as MatchInternals & {
      state: MatchInternals["state"] & { ruleSet: { atamahane: boolean } };
    };
    expect(internals.state.phase).toBe("awaiting_discard");
    expect(internals.state.turn).toBe(0);

    // Enable atamahane so seat 2's ron force-passes seat 3.
    internals.state.ruleSet.atamahane = true;

    internals.state.hands[0] = [...DISCARDER_HAND, "4m"];
    internals.state.hands[1] = [...TENPAI_HAND];
    internals.state.hands[2] = [...TENPAI_HAND];
    internals.state.hands[3] = [...TENPAI_HAND];
    internals.state.lastDrawn[0] = "4m";
    internals.state.lastDrawn[1] = null;
    internals.state.lastDrawn[2] = null;
    internals.state.lastDrawn[3] = null;
    internals.state.discards = [[], [], [], []];
    internals.state.melds = [[], [], [], []];
    internals.state.lastDiscard = null;
    internals.state.pendingShouminkan = null;
    internals.state.riichiDeclared = [false, false, false, false];
    internals.state.doubleRiichi = [false, false, false, false];
    internals.state.ippatsuEligible = [false, false, false, false];
    internals.state.furitenLocked = [false, false, false, false];
    internals.state.furitenTemp = [false, false, false, false];

    internals.setSeatLegals(0, [
      { id: "discard:4m", type: "discard", tile: "4m" },
    ]);
    await m.handleAct(0, "discard:4m");

    // Sanity: all three non-discarder windows open, each with a
    // non-null deadline pushed to the seat.
    expect(sinks[1].lastLegals?.length ?? 0).toBeGreaterThan(0);
    expect(sinks[2].lastLegals?.length ?? 0).toBeGreaterThan(0);
    expect(sinks[3].lastLegals?.length ?? 0).toBeGreaterThan(0);

    const seat2Ron = (() => {
      const ron = internals.legalActions[2].find((a) => a.type === "ron");
      expect(ron).toBeDefined();
      return (ron as LegalAction).id;
    })();

    // Seat 2 rons. The submitter (seat 2) and the dominated seat
    // (seat 3, head-bumped) must both receive an immediate empty-
    // legals frame so their UIs drop the buttons + timer. Seat 1
    // (upstream) keeps its window open.
    await m.handleAct(2, seat2Ron);

    expect(sinks[2].lastLegals).toEqual([]);
    expect(sinks[2].lastDeadline).toBeNull();
    expect(sinks[3].lastLegals).toEqual([]);
    expect(sinks[3].lastDeadline).toBeNull();
    // Seat 1 still has an open window — they haven't been flushed.
    expect(sinks[1].lastLegals?.length ?? 0).toBeGreaterThan(0);

    // Resolve cleanly so vitest's leak checker is happy.
    await m.handleAct(1, "pass");
  });
});
