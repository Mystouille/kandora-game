/**
 * Tests for chankan ("robbing the kan").
 *
 * After a seat declares shouminkan, the engine sits in
 * `awaiting_chankan` while the orchestrator runs the chankan
 * window. Opponents may declare ron on the upgrade tile; the
 * engine validates the agari with `rinshanOrChankan: true` so
 * scoring picks up the chankan yaku. If no one robs, the
 * orchestrator dispatches `complete_shouminkan` and play resumes.
 */

import { describe, expect, it } from "vitest";
import { createInitialState, type MatchState, type Meld } from "./state";
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
  dealer?: 0 | 1 | 2 | 3;
  lastDrawn?: Tile;
  melds?: Meld[][];
  riichiDeclared?: [boolean, boolean, boolean, boolean];
}): MatchState {
  const base = createInitialState(0);
  return {
    ...base,
    hands: opts.hands.map((h) => [...h]),
    discards: [[], [], [], []],
    liveWall: Array.from({ length: 30 }, () => "1m" as Tile),
    doraIndicators: [],
    uraDoraIndicators: [],
    turn: opts.turn,
    phase: "awaiting_discard",
    dealer: opts.dealer ?? 0,
    lastDrawn: [null, null, null, null].map((_, i) =>
      i === opts.turn && opts.lastDrawn ? opts.lastDrawn : null
    ) as (Tile | null)[],
    lastDiscard: null,
    riichiDeclared: opts.riichiDeclared ?? [false, false, false, false],
    doubleRiichi: [false, false, false, false],
    ippatsuEligible: [false, false, false, false],
    melds: opts.melds ?? [[], [], [], []],
    pendingShouminkan: null,
    lastHandResult: null,
  };
}

/** Build a state already mid-shouminkan-declaration via the engine. */
function declareShouminkan(state: MatchState): MatchState {
  const r = step(state, {
    type: "kan",
    seat: state.turn,
    kind: "shouminkan",
    tile: state.lastDrawn[state.turn] as Tile,
  });
  expect(r.state.phase).toBe("awaiting_chankan");
  return r.state;
}

describe("step — chankan (rob the kan)", () => {
  it("ron in awaiting_chankan wins on the upgrade tile with rinshanOrChankan flag", () => {
    // Seat 0 has an open pon of 3m and just drew the 4th 3m
    // (declares shouminkan with 3m).
    const seat0Hand = tiles("3m4p5p6p7p8p9p1s2s3s4s5s"); // 12 tiles
    const ponMeld: Meld = {
      type: "pon",
      tiles: ["3m", "3m", "3m"],
      claimedTile: "3m",
      from: 1,
    };
    // Seat 1 is riichi-tenpai waiting on 3m: 11m22m44m... → use a
    // straightforward pinfu-shaped hand with 3m wait. A simple
    // 13-tile chiitoitsu shape waiting on 3m works:
    //   pairs of 1m,2m,4m,5m,6m,7m + lone 3m wait.
    // Wait, that's 13 tiles already (2*6+1=13). Good.
    const seat1Wait3m = tiles("1m1m2m2m4m4m5m5m6m6m7m7m3m");
    expect(seat1Wait3m).toHaveLength(13);
    const state = craft({
      hands: [seat0Hand, seat1Wait3m, FILLER13, FILLER13],
      turn: 0,
      dealer: 0,
      lastDrawn: "3m",
      melds: [[ponMeld], [], [], []],
      riichiDeclared: [false, true, false, false],
    });
    const declared = declareShouminkan(state);
    expect(declared.pendingShouminkan).toEqual({
      seat: 0,
      tile: "3m",
      ponIdx: 0,
    });

    const r = step(declared, { type: "ron", seat: 1 });
    expect(r.state.phase).toBe("hand_ended");
    expect(r.state.lastHandResult).toMatchObject({
      reason: "ron",
      winner: 1,
      loser: 0,
    });
    const winEv = r.events.find((e) => e.type === "win");
    if (winEv?.type !== "win") {
      throw new Error("expected win event");
    }
    expect(winEv.winTile).toBe("3m");
    // Chankan yaku must be present in the score breakdown.
    const yakuKeys = Object.keys(winEv.score.yaku);
    expect(yakuKeys.some((k) => /搶槓|槍槓|chankan/i.test(k))).toBe(true);
  });

  it("complete_shouminkan after no chankan ron: rinshan draw + new dora", () => {
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
      dealer: 0,
      lastDrawn: "3m",
      melds: [[ponMeld], [], [], []],
    });
    const declared = declareShouminkan(state);
    expect(declared.hands[0]).toHaveLength(11);
    expect(declared.doraIndicators).toEqual([]);

    const r = step(declared, { type: "complete_shouminkan" });
    expect(r.events.map((e) => e.type)).toEqual(["draw", "new_dora"]);
    expect(r.state.phase).toBe("awaiting_discard");
    expect(r.state.pendingShouminkan).toBeNull();
    // Hand back to 12 (rinshan added).
    expect(r.state.hands[0]).toHaveLength(12);
    expect(r.state.lastDrawn[0]).not.toBeNull();
    expect(r.state.doraIndicators).toHaveLength(1);
  });

  it("complete_shouminkan rejects when phase isn't awaiting_chankan", () => {
    const state = craft({
      hands: [FILLER13, FILLER13, FILLER13, FILLER13],
      turn: 0,
    });
    const r = step(state, { type: "complete_shouminkan" });
    expect(r.events).toEqual([]);
    expect(r.state).toBe(state);
  });

  it("ron in awaiting_chankan rejects when the seat has no agari on the upgrade tile", () => {
    const seat0Hand = tiles("3m4p5p6p7p8p9p1s2s3s4s5s");
    const ponMeld: Meld = {
      type: "pon",
      tiles: ["3m", "3m", "3m"],
      claimedTile: "3m",
      from: 1,
    };
    const state = craft({
      hands: [seat0Hand, FILLER13, FILLER13, FILLER13],
      turn: 0,
      dealer: 0,
      lastDrawn: "3m",
      melds: [[ponMeld], [], [], []],
    });
    const declared = declareShouminkan(state);
    const r = step(declared, { type: "ron", seat: 1 });
    expect(r.events).toEqual([]);
    expect(r.state).toBe(declared);
  });

  it("ron in awaiting_chankan rejects the declarer themself", () => {
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
      dealer: 0,
      lastDrawn: "3m",
      melds: [[ponMeld], [], [], []],
    });
    const declared = declareShouminkan(state);
    const r = step(declared, { type: "ron", seat: 0 });
    expect(r.events).toEqual([]);
  });
});
