/**
 * Phase 1 — shouminkan (added kan).
 *
 * Shouminkan is split into two engine actions:
 *   1. `kan/shouminkan` (declare): removes the upgrade tile from
 *      the caller's hand, swaps the matching pon → shouminkan in
 *      `melds`, sets `pendingShouminkan`, and transitions the
 *      phase to `awaiting_chankan`. Emits a single `call` event.
 *      No rinshan draw, no new dora reveal yet.
 *   2. `complete_shouminkan` (orchestrator-driven, after the chankan
 *      window closes without a robbing ron): performs the rinshan
 *      draw, reveals the post-kan dora, returns to
 *      `awaiting_discard`. Emits the `new_dora` event.
 *
 * The chankan ron path itself is exercised in
 * `step.chankan.spec.ts` — these tests focus on the declare /
 * complete halves and the standard legality gates.
 */

import { describe, expect, it } from "vitest";
import { createInitialState, type MatchState } from "./state";
import { step } from "./step";
import type { Tile } from "./types";
import type { Meld } from "./state";

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
  liveWall?: Tile[];
  deadWall?: Tile[];
  melds?: Meld[][];
  riichiDeclared?: [boolean, boolean, boolean, boolean];
}): MatchState {
  const base = createInitialState(0);
  return {
    ...base,
    hands: opts.hands.map((h) => [...h]),
    discards: [[], [], [], []],
    liveWall: opts.liveWall ?? Array.from({ length: 30 }, () => "1m" as Tile),
    deadWall: opts.deadWall ?? base.deadWall,
    doraIndicators: [],
    uraDoraIndicators: [],
    turn: opts.turn,
    phase: opts.phase,
    dealer: opts.dealer ?? 0,
    lastDrawn: [null, null, null, null].map((_, i) =>
      i === opts.turn && opts.lastDrawn ? opts.lastDrawn : null
    ) as (Tile | null)[],
    lastDiscard: null,
    riichiDeclared: opts.riichiDeclared ?? [false, false, false, false],
    doubleRiichi: [false, false, false, false],
    ippatsuEligible: [false, false, false, false],
    melds: opts.melds ?? [[], [], [], []],
    lastHandResult: null,
  };
}

describe("step — shouminkan", () => {
  it("upgrades an existing pon to a shouminkan with the matching tile from hand", () => {
    // Seat 0 has an open pon of 3m and just drew the 4th 3m.
    const seat0Hand = tiles("3m1p2p3p4p5p6p7p8p9p1s2s"); // 12 tiles
    const ponMeld: Meld = {
      type: "pon",
      tiles: ["3m", "3m", "3m"],
      claimedTile: "3m",
      from: 1,
    };
    const melds: Meld[][] = [[ponMeld], [], [], []];
    // Use a deadWall whose front (rinshan) is a known tile (5z) so we
    // can assert the rinshan landed in the seat's hand.
    const deadWall: Tile[] = [
      "5z", // rinshan
      "9m",
      "9m",
      "9m",
      "1m",
      "2m",
      "3m",
      "4m",
      "5m",
      "6m",
      "7m",
      "8m",
      "9m",
      "1p",
    ];
    const state = craft({
      hands: [seat0Hand, FILLER13, FILLER13, FILLER13],
      turn: 0,
      phase: "awaiting_discard",
      dealer: 0,
      lastDrawn: "3m",
      melds,
      deadWall,
    });
    const r = step(state, {
      type: "kan",
      seat: 0,
      kind: "shouminkan",
      tile: "3m",
    });
    expect(r.events.map((e) => e.type)).toEqual(["call"]);
    expect(r.events[0]).toMatchObject({
      type: "call",
      seat: 0,
      meld: {
        type: "shouminkan",
        tiles: ["3m", "3m", "3m", "3m"],
        claimedTile: "3m",
        from: 1,
      },
    });
    // Declare: hand drops one 3m (12 → 11), no rinshan yet.
    expect(r.state.hands[0]).toHaveLength(11);
    expect(r.state.hands[0]).not.toContain("3m");
    expect(r.state.melds[0]).toHaveLength(1);
    expect(r.state.melds[0][0].type).toBe("shouminkan");
    expect(r.state.phase).toBe("awaiting_chankan");
    expect(r.state.pendingShouminkan).toEqual({
      seat: 0,
      tile: "3m",
      ponIdx: 0,
    });
    // No dora reveal yet — that ships with `complete_shouminkan`.
    expect(r.state.doraIndicators).toEqual([]);

    // Now complete (no chankan ron).
    const r2 = step(r.state, { type: "complete_shouminkan" });
    expect(r2.events.map((e) => e.type)).toEqual(["draw", "new_dora"]);
    // Hand: 11 + rinshan 5z = 12.
    expect(r2.state.hands[0]).toHaveLength(12);
    expect(r2.state.hands[0]).toContain("5z");
    expect(r2.state.lastDrawn[0]).toBe("5z");
    expect(r2.state.phase).toBe("awaiting_discard");
    expect(r2.state.pendingShouminkan).toBeNull();
    // After the rinshan shift, deadWall[3] is the original index 4 = "1m".
    expect(r2.state.doraIndicators).toEqual(["1m"]);
  });

  it("rejects when the seat doesn't own a matching pon", () => {
    const seat0Hand = tiles("3m1p2p3p4p5p6p7p8p9p1s2s");
    const state = craft({
      hands: [seat0Hand, FILLER13, FILLER13, FILLER13],
      turn: 0,
      phase: "awaiting_discard",
      dealer: 0,
      lastDrawn: "3m",
      // No melds at all.
    });
    const r = step(state, {
      type: "kan",
      seat: 0,
      kind: "shouminkan",
      tile: "3m",
    });
    expect(r.events).toEqual([]);
    expect(r.state).toBe(state);
  });

  it("rejects when the upgrading tile isn't in hand", () => {
    const seat0Hand = tiles("1p2p3p4p5p6p7p8p9p1s2s3s"); // no 3m
    const ponMeld: Meld = {
      type: "pon",
      tiles: ["3m", "3m", "3m"],
      claimedTile: "3m",
      from: 1,
    };
    const state = craft({
      hands: [seat0Hand, FILLER13, FILLER13, FILLER13],
      turn: 0,
      phase: "awaiting_discard",
      dealer: 0,
      lastDrawn: "3s",
      melds: [[ponMeld], [], [], []],
    });
    const r = step(state, {
      type: "kan",
      seat: 0,
      kind: "shouminkan",
      tile: "3m",
    });
    expect(r.events).toEqual([]);
  });

  it("rejects when the seat is in riichi", () => {
    // Standard rule: a riichi seat may only declare ankan, never shouminkan.
    const seat0Hand = tiles("3m1p2p3p4p5p6p7p8p9p1s2s");
    const ponMeld: Meld = {
      type: "pon",
      tiles: ["3m", "3m", "3m"],
      claimedTile: "3m",
      from: 1,
    };
    const state = craft({
      hands: [seat0Hand, FILLER13, FILLER13, FILLER13],
      turn: 0,
      phase: "awaiting_discard",
      dealer: 0,
      lastDrawn: "3m",
      melds: [[ponMeld], [], [], []],
      riichiDeclared: [true, false, false, false],
    });
    const r = step(state, {
      type: "kan",
      seat: 0,
      kind: "shouminkan",
      tile: "3m",
    });
    expect(r.events).toEqual([]);
  });

  it("rejects from an off-turn seat", () => {
    const seat0Hand = tiles("3m1p2p3p4p5p6p7p8p9p1s2s");
    const ponMeld: Meld = {
      type: "pon",
      tiles: ["3m", "3m", "3m"],
      claimedTile: "3m",
      from: 1,
    };
    const state = craft({
      hands: [seat0Hand, FILLER13, FILLER13, FILLER13],
      turn: 0,
      phase: "awaiting_discard",
      dealer: 0,
      lastDrawn: "3m",
      melds: [[ponMeld], [], [], []],
    });
    const r = step(state, {
      type: "kan",
      seat: 1,
      kind: "shouminkan",
      tile: "3m",
    });
    expect(r.events).toEqual([]);
  });

  it("does not reveal new dora when ruleSet.kanDora = false", () => {
    const seat0Hand = tiles("3m1p2p3p4p5p6p7p8p9p1s2s");
    const ponMeld: Meld = {
      type: "pon",
      tiles: ["3m", "3m", "3m"],
      claimedTile: "3m",
      from: 1,
    };
    const base = createInitialState(0, { ruleSet: { kanDora: false } });
    const state: MatchState = {
      ...base,
      hands: [seat0Hand, FILLER13, FILLER13, FILLER13].map((h) => [...h]),
      discards: [[], [], [], []],
      doraIndicators: [],
      uraDoraIndicators: [],
      turn: 0,
      phase: "awaiting_discard",
      dealer: 0,
      lastDrawn: [null, null, null, null].map((_, i) =>
        i === 0 ? "3m" : null
      ) as (Tile | null)[],
      lastDiscard: null,
      melds: [[ponMeld], [], [], []],
      lastHandResult: null,
    };
    const r = step(state, {
      type: "kan",
      seat: 0,
      kind: "shouminkan",
      tile: "3m",
    });
    expect(r.events.map((e) => e.type)).toEqual(["call"]);
    expect(r.state.doraIndicators).toEqual([]);
  });
});
