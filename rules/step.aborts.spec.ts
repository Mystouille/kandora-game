/**
 * Phase 1 step 5d — abortive draws.
 *
 * Covers:
 *   - kyuushuu kyuuhai (player-declared, ≥9 distinct terminal/honor
 *     tiles in the dealer's opening 14-tile hand).
 *   - suufon renda (auto: all four seats' first discards are the
 *     same wind tile, no calls).
 *   - suucha riichi (auto: 4th seat declares riichi successfully).
 *   - dealer-keep + honba bookkeeping after an abort.
 */

import { describe, expect, it } from "vitest";
import { createInitialState, type MatchState } from "./state";
import { step } from "./step";
import type { Tile } from "./types";

function tiles(s: string): Tile[] {
  const out: Tile[] = [];
  let digits = "";
  for (const ch of s) {
    if (ch >= "0" && ch <= "9") {
      digits += ch;
    } else {
      for (const d of digits) {
        out.push(`${d}${ch}`);
      }
      digits = "";
    }
  }
  return out;
}

const FILLER13 = tiles("9p9p9p9p9p9p9p9p9p9p9p9p9p");

function craft(opts: {
  hands: Tile[][];
  turn: 0 | 1 | 2 | 3;
  phase: "awaiting_draw" | "awaiting_discard";
  dealer?: 0 | 1 | 2 | 3;
  lastDrawn?: Tile;
  lastDiscard?: { seat: 0 | 1 | 2 | 3; tile: Tile };
  liveWall?: Tile[];
  discards?: Tile[][];
  riichiDeclared?: [boolean, boolean, boolean, boolean];
  scores?: [number, number, number, number];
}): MatchState {
  const base = createInitialState(0);
  return {
    ...base,
    hands: opts.hands.map((h) => [...h]),
    discards: opts.discards ?? [[], [], [], []],
    liveWall: opts.liveWall ?? Array.from({ length: 30 }, () => "1m" as Tile),
    doraIndicators: [],
    uraDoraIndicators: [],
    turn: opts.turn,
    phase: opts.phase,
    dealer: opts.dealer ?? 0,
    lastDrawn: [null, null, null, null].map((_, i) =>
      i === opts.turn && opts.lastDrawn ? opts.lastDrawn : null
    ) as (Tile | null)[],
    lastDiscard: opts.lastDiscard ?? null,
    riichiDeclared: opts.riichiDeclared ?? [false, false, false, false],
    doubleRiichi: [false, false, false, false],
    ippatsuEligible: [false, false, false, false],
    melds: [[], [], [], []],
    scores: opts.scores ?? [25000, 25000, 25000, 25000],
    lastHandResult: null,
  };
}

describe("step — kyuushuu kyuuhai", () => {
  it("aborts when the dealer's 14-tile opener has ≥9 distinct terminal/honors", () => {
    // 1m 9m 1p 9p 1s 9s 1z 2z 3z + 4z + 5z + 6z + 7z + filler
    // 9 distinct terminals/honors required; this hand has 13.
    const opener = tiles("1m9m1p9p1s9s1z2z3z4z5z6z7z2m");
    expect(opener).toHaveLength(14);
    const state = craft({
      hands: [opener, FILLER13, FILLER13, FILLER13],
      turn: 0,
      phase: "awaiting_discard",
      dealer: 0,
      lastDrawn: "2m",
    });
    const r = step(state, { type: "abort", seat: 0, kind: "kyuushuu" });
    expect(r.events.map((e) => e.type)).toEqual(["hand_end"]);
    expect(r.events[0]).toMatchObject({
      type: "hand_end",
      reason: "abort",
      abortKind: "kyuushuu",
    });
    expect(r.state.phase).toBe("hand_ended");
    expect(r.state.lastHandResult).toMatchObject({
      reason: "abort",
      abortKind: "kyuushuu",
      delta: [0, 0, 0, 0],
    });
  });

  it("rejects when only 8 distinct terminal/honors", () => {
    // 8 distinct: 1m 9m 1p 9p 1s 9s 1z 2z + duplicates + middles
    const opener = tiles("1m9m1p9p1s9s1z2z2m3m4m5m6m7m");
    expect(opener).toHaveLength(14);
    const state = craft({
      hands: [opener, FILLER13, FILLER13, FILLER13],
      turn: 0,
      phase: "awaiting_discard",
      dealer: 0,
      lastDrawn: "7m",
    });
    const r = step(state, { type: "abort", seat: 0, kind: "kyuushuu" });
    expect(r.events).toEqual([]);
    expect(r.state).toBe(state);
  });

  it("rejects after any seat has discarded", () => {
    const opener = tiles("1m9m1p9p1s9s1z2z3z4z5z6z7z2m");
    const discards: Tile[][] = [[], [], [], []];
    discards[3] = ["5p"];
    const state = craft({
      hands: [opener, FILLER13, FILLER13, FILLER13],
      turn: 0,
      phase: "awaiting_discard",
      dealer: 0,
      lastDrawn: "2m",
      discards,
    });
    const r = step(state, { type: "abort", seat: 0, kind: "kyuushuu" });
    expect(r.events).toEqual([]);
  });

  it("rejects from a non-active seat", () => {
    const opener = tiles("1m9m1p9p1s9s1z2z3z4z5z6z7z2m");
    const state = craft({
      hands: [FILLER13, opener, FILLER13, FILLER13],
      turn: 0,
      phase: "awaiting_discard",
      dealer: 0,
      lastDrawn: "1m",
    });
    const r = step(state, { type: "abort", seat: 1, kind: "kyuushuu" });
    expect(r.events).toEqual([]);
  });
});

describe("step — suufon renda", () => {
  it("auto-aborts when the 4th seat's first discard completes 4 matching winds", () => {
    // Three seats already discarded "1z"; seat 3 about to discard "1z".
    const seat3Hand = tiles("1z2m3m4m5m6m7m8m9m1p2p3p4p1s");
    expect(seat3Hand).toHaveLength(14);
    const discards: Tile[][] = [["1z"], ["1z"], ["1z"], []];
    const state = craft({
      hands: [FILLER13, FILLER13, FILLER13, seat3Hand],
      turn: 3,
      phase: "awaiting_discard",
      dealer: 0,
      lastDrawn: "1z",
      discards,
    });
    const r = step(state, { type: "discard", seat: 3, tile: "1z" });
    expect(r.events.map((e) => e.type)).toEqual(["discard", "hand_end"]);
    expect(r.events[1]).toMatchObject({
      type: "hand_end",
      reason: "abort",
      abortKind: "suufon_renda",
    });
    expect(r.state.phase).toBe("hand_ended");
  });

  it("does not abort when discards are matching but not all wind tiles", () => {
    // Same shape but the discarded tile is "5m" (not a wind).
    const seat3Hand = tiles("5m2m3m4m6m7m8m9m1p2p3p4p1s2s");
    const discards: Tile[][] = [["5m"], ["5m"], ["5m"], []];
    const state = craft({
      hands: [FILLER13, FILLER13, FILLER13, seat3Hand],
      turn: 3,
      phase: "awaiting_discard",
      dealer: 0,
      lastDrawn: "5m",
      discards,
    });
    const r = step(state, { type: "discard", seat: 3, tile: "5m" });
    expect(r.events.map((e) => e.type)).toEqual(["discard"]);
    expect(r.state.phase).toBe("awaiting_draw");
  });

  it("does not abort when winds differ across seats", () => {
    const seat3Hand = tiles("4z2m3m4m5m6m7m8m9m1p2p3p4p1s");
    const discards: Tile[][] = [["1z"], ["2z"], ["3z"], []];
    const state = craft({
      hands: [FILLER13, FILLER13, FILLER13, seat3Hand],
      turn: 3,
      phase: "awaiting_discard",
      dealer: 0,
      lastDrawn: "4z",
      discards,
    });
    const r = step(state, { type: "discard", seat: 3, tile: "4z" });
    expect(r.events.map((e) => e.type)).toEqual(["discard"]);
  });
});

describe("step — suucha riichi", () => {
  it("auto-aborts when the 4th seat's riichi succeeds", () => {
    // Tenpai shape for seat 3: 234m 234p 234s 11z 67m (13 tiles,
    // waits on 58m) + drew 5m → discard 5m to declare riichi.
    const seat3Hand = tiles("234m234p234s11z67m5m");
    expect(seat3Hand).toHaveLength(14);
    const state = craft({
      hands: [FILLER13, FILLER13, FILLER13, seat3Hand],
      turn: 3,
      phase: "awaiting_discard",
      dealer: 0,
      lastDrawn: "5m",
      // Three other seats already in riichi.
      riichiDeclared: [true, true, true, false],
      // Each prior riichi paid a 1000 stick — 3 sticks on the table,
      // and they have at least 1000 to spend (irrelevant for seat 3
      // declaring; checks own score).
      scores: [24000, 24000, 24000, 25000],
    });
    const r = step(state, { type: "riichi", seat: 3, tile: "5m" });
    expect(r.events.map((e) => e.type)).toEqual(["discard", "hand_end"]);
    expect(r.events[1]).toMatchObject({
      type: "hand_end",
      reason: "abort",
      abortKind: "suucha_riichi",
    });
    expect(r.state.riichiDeclared).toEqual([true, true, true, true]);
    expect(r.state.phase).toBe("hand_ended");
    // Only seat 3's 1000 stick is paid into the table here (the
    // earlier three sticks aren't tracked by the test fixture).
    expect(r.state.riichiSticks).toBe(1);
  });

  it("does not abort when only 3 seats are in riichi", () => {
    const seat3Hand = tiles("234m234p234s11z67m5m");
    const state = craft({
      hands: [FILLER13, FILLER13, FILLER13, seat3Hand],
      turn: 3,
      phase: "awaiting_discard",
      dealer: 0,
      lastDrawn: "5m",
      riichiDeclared: [true, true, false, false],
    });
    const r = step(state, { type: "riichi", seat: 3, tile: "5m" });
    expect(r.events.map((e) => e.type)).toEqual(["discard"]);
    expect(r.state.phase).toBe("awaiting_draw");
  });
});

describe("step — abort + start_next_hand", () => {
  it("dealer keeps and honba advances after an abort", () => {
    const opener = tiles("1m9m1p9p1s9s1z2z3z4z5z6z7z2m");
    let state = craft({
      hands: [opener, FILLER13, FILLER13, FILLER13],
      turn: 0,
      phase: "awaiting_discard",
      dealer: 0,
      lastDrawn: "2m",
    });
    const r1 = step(state, { type: "abort", seat: 0, kind: "kyuushuu" });
    state = r1.state;
    expect(state.dealer).toBe(0);
    expect(state.honba).toBe(0);

    const r2 = step(state, { type: "start_next_hand" });
    expect(r2.state.phase).toBe("awaiting_draw");
    expect(r2.state.dealer).toBe(0); // dealer keeps
    expect(r2.state.honba).toBe(1); // +1 honba
    expect(r2.state.roundNumber).toBe(1); // unchanged
  });
});
