/**
 * Phase 1 step 5b — riichi declaration, ippatsu, ura-dora,
 * tenpai-payments + dealer-keep-on-tenpai at exhaustive draw.
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

function craft(opts: {
  hands: Tile[][];
  turn: 0 | 1 | 2 | 3;
  phase: "awaiting_draw" | "awaiting_discard";
  dealer?: 0 | 1 | 2 | 3;
  lastDrawn?: Tile;
  lastDiscard?: { seat: 0 | 1 | 2 | 3; tile: Tile };
  liveWall?: Tile[];
  deadWall?: Tile[];
  doraIndicators?: Tile[];
  uraDoraIndicators?: Tile[];
  scores?: [number, number, number, number];
  discards?: Tile[][];
  riichiDeclared?: [boolean, boolean, boolean, boolean];
  ippatsuEligible?: [boolean, boolean, boolean, boolean];
}): MatchState {
  const base = createInitialState(0);
  const dealer = opts.dealer ?? 0;
  return {
    ...base,
    hands: opts.hands.map((h) => [...h]),
    discards: opts.discards ?? [[], [], [], []],
    liveWall: opts.liveWall ?? Array.from({ length: 20 }, () => "1m" as Tile),
    deadWall: opts.deadWall ?? base.deadWall,
    doraIndicators: opts.doraIndicators ?? [],
    uraDoraIndicators: opts.uraDoraIndicators ?? [],
    turn: opts.turn,
    phase: opts.phase,
    dealer,
    lastDrawn: [null, null, null, null].map((_, i) =>
      i === opts.turn && opts.lastDrawn ? opts.lastDrawn : null
    ) as (Tile | null)[],
    lastDiscard: opts.lastDiscard ?? null,
    scores: opts.scores ?? [25000, 25000, 25000, 25000],
    riichiDeclared: opts.riichiDeclared ?? [false, false, false, false],
    doubleRiichi: [false, false, false, false],
    ippatsuEligible: opts.ippatsuEligible ?? [false, false, false, false],
    lastHandResult: null,
  };
}

const FILLER = tiles("9p9p9p9p9p9p9p9p9p9p9p9p9p");

describe("step — riichi declaration", () => {
  it("accepts riichi when tenpai with sufficient points and wall", () => {
    // Tenpai chiitoitsu: 6 pairs + 7z single, waits on 7z.
    // 14-tile hand: drew 9m as a useless tile to discard.
    const handTenpai = tiles("11m22p33s44m55p66s7z");
    const drawn: Tile = "9m";
    const state = craft({
      hands: [[...handTenpai, drawn], FILLER, FILLER, FILLER],
      turn: 0,
      phase: "awaiting_discard",
      dealer: 0,
      lastDrawn: drawn,
    });
    const r = step(state, { type: "riichi", seat: 0, tile: drawn });
    expect(r.events).toHaveLength(1);
    expect(r.events[0]).toMatchObject({
      type: "discard",
      seat: 0,
      tile: drawn,
      tsumogiri: true,
    });
    expect(r.state.riichiDeclared[0]).toBe(true);
    expect(r.state.doubleRiichi[0]).toBe(true); // first uninterrupted turn
    expect(r.state.ippatsuEligible[0]).toBe(true);
    expect(r.state.scores[0]).toBe(24000);
    expect(r.state.riichiSticks).toBe(1);
    expect(r.state.lastDiscard).toEqual({ seat: 0, tile: drawn });
    expect(r.state.turn).toBe(1);
  });

  it("rejects riichi when not tenpai", () => {
    // Random 14-tile mess, no tenpai for any discard.
    const hand = tiles("13579m13579p1357s");
    const state = craft({
      hands: [hand, FILLER, FILLER, FILLER],
      turn: 0,
      phase: "awaiting_discard",
      lastDrawn: "7s",
    });
    const r = step(state, { type: "riichi", seat: 0, tile: "1m" });
    expect(r.events).toEqual([]);
    expect(r.state.riichiDeclared[0]).toBe(false);
  });

  it("rejects riichi when scores < 1000", () => {
    const handTenpai = tiles("11m22p33s44m55p66s7z");
    const drawn: Tile = "9m";
    const state = craft({
      hands: [[...handTenpai, drawn], FILLER, FILLER, FILLER],
      turn: 0,
      phase: "awaiting_discard",
      lastDrawn: drawn,
      scores: [500, 25000, 25000, 25000],
    });
    const r = step(state, { type: "riichi", seat: 0, tile: drawn });
    expect(r.events).toEqual([]);
  });

  it("rejects riichi when live wall < 4", () => {
    const handTenpai = tiles("11m22p33s44m55p66s7z");
    const drawn: Tile = "9m";
    const state = craft({
      hands: [[...handTenpai, drawn], FILLER, FILLER, FILLER],
      turn: 0,
      phase: "awaiting_discard",
      lastDrawn: drawn,
      liveWall: tiles("1m2m3m"), // 3 < 4
    });
    const r = step(state, { type: "riichi", seat: 0, tile: drawn });
    expect(r.events).toEqual([]);
  });
});

describe("step — riichi locked tsumogiri", () => {
  it("forces tsumogiri on next discard after riichi", () => {
    const handTenpai = tiles("11m22p33s44m55p66s7z"); // 13 tiles
    const drawn: Tile = "8m"; // not the wait
    const state = craft({
      hands: [[...handTenpai, drawn], FILLER, FILLER, FILLER],
      turn: 0,
      phase: "awaiting_discard",
      lastDrawn: drawn,
      riichiDeclared: [true, false, false, false],
    });
    // Try to discard a hand tile instead of the drawn one — must reject.
    const bad = step(state, { type: "discard", seat: 0, tile: "1m" });
    expect(bad.events).toEqual([]);
    // Tsumogiri on the drawn tile is fine.
    const ok = step(state, { type: "discard", seat: 0, tile: drawn });
    expect(ok.events).toHaveLength(1);
    expect(ok.state.turn).toBe(1);
  });
});

describe("step — ippatsu + ura-dora on riichi win", () => {
  it("ippatsu tsumo includes the ippatsu yaku", () => {
    // Tenpai for chiitoitsu on 7z; just drew 7z.
    const handTenpai = tiles("11m22p33s44m55p66s7z");
    const winTile: Tile = "7z";
    const state = craft({
      hands: [FILLER, [...handTenpai, winTile], FILLER, FILLER],
      turn: 1,
      phase: "awaiting_discard",
      dealer: 0,
      lastDrawn: winTile,
      riichiDeclared: [false, true, false, false],
      ippatsuEligible: [false, true, false, false],
      uraDoraIndicators: [],
    });
    const r = step(state, { type: "tsumo", seat: 1 });
    const winEv = r.events.find((e) => e.type === "win");
    if (winEv?.type !== "win") {
      throw new Error("expected win event");
    }
    // Chiitoitsu(2) + riichi(1) + ippatsu(1) + tsumo(1) = 5 han.
    expect(winEv.score.han).toBe(5);
  });

  it("riichi ron reveals ura-dora when ura indicator matches a tile", () => {
    // Tenpai chiitoitsu waiting on 7z; ura indicator 6z → ura dora = 7z.
    const handTenpai = tiles("11m22p33s44m55p66s7z");
    const state = craft({
      hands: [FILLER, handTenpai, FILLER, FILLER],
      turn: 1,
      phase: "awaiting_draw",
      dealer: 0,
      lastDiscard: { seat: 0, tile: "7z" },
      riichiDeclared: [false, true, false, false],
      ippatsuEligible: [false, false, false, false], // already lapsed
      uraDoraIndicators: ["6z"], // ura dora = 7z, hand has 7z×2 in winning shape
    });
    const r = step(state, { type: "ron", seat: 1 });
    const winEv = r.events.find((e) => e.type === "win");
    if (winEv?.type !== "win") {
      throw new Error("expected win event");
    }
    // chiitoitsu(2) + riichi(1) + ura-dora 2 = 5 han.
    expect(winEv.score.han).toBeGreaterThanOrEqual(5);
  });

  it("non-riichi seat does not see ura-dora", () => {
    const handTenpai = tiles("11m22p33s44m55p66s7z");
    const state = craft({
      hands: [FILLER, handTenpai, FILLER, FILLER],
      turn: 1,
      phase: "awaiting_draw",
      dealer: 0,
      lastDiscard: { seat: 0, tile: "7z" },
      uraDoraIndicators: ["6z"], // would give 2 ura-dora if revealed
    });
    const r = step(state, { type: "ron", seat: 1 });
    const winEv = r.events.find((e) => e.type === "win");
    if (winEv?.type !== "win") {
      throw new Error("expected win event");
    }
    // No riichi, no ippatsu, no ura → chiitoitsu only = 2 han.
    expect(winEv.score.han).toBe(2);
  });
});

describe("step — riichi sticks", () => {
  it("riichi stick goes to the winner", () => {
    const handTenpai = tiles("11m22p33s44m55p66s7z");
    const state = craft({
      hands: [FILLER, handTenpai, FILLER, FILLER],
      turn: 1,
      phase: "awaiting_draw",
      dealer: 0,
      lastDiscard: { seat: 0, tile: "7z" },
      scores: [25000, 24000, 25000, 25000], // seat 1 already paid 1000
      riichiDeclared: [false, true, false, false],
    });
    // Manually set riichiSticks via post-craft mutation (craft doesn't expose it).
    const seeded: MatchState = { ...state, riichiSticks: 1 };
    const r = step(seeded, { type: "ron", seat: 1 });
    expect(r.state.riichiSticks).toBe(0);
    // Non-dealer chiitoitsu+riichi ron: 25fu 3han = 3200; +1000 stick.
    expect(r.state.scores[1]).toBe(24000 + 3200 + 1000);
  });
});

describe("step — exhaustive-draw tenpai payments", () => {
  function exhaustState(opts: {
    hands: Tile[][];
    dealer?: 0 | 1 | 2 | 3;
    riichiDeclared?: [boolean, boolean, boolean, boolean];
  }): MatchState {
    return craft({
      hands: opts.hands,
      turn: 0,
      phase: "awaiting_draw",
      dealer: opts.dealer ?? 0,
      liveWall: [], // exhausts on next draw
      riichiDeclared: opts.riichiDeclared,
    });
  }

  const TENPAI = tiles("11m22p33s44m55p66s7z"); // chiitoitsu tenpai on 7z
  const NOTEN = tiles("13579m13579p123s"); // 13 random tiles, far from tenpai

  it("1 tenpai vs 3 noten → +3000 / -1000 each", () => {
    const state = exhaustState({
      hands: [TENPAI, NOTEN, NOTEN, NOTEN],
    });
    const r = step(state, { type: "draw", seat: 0 });
    expect(r.state.phase).toBe("hand_ended");
    expect(r.state.lastHandResult?.delta).toEqual([3000, -1000, -1000, -1000]);
    expect(r.state.lastHandResult?.tenpai).toEqual([true, false, false, false]);
  });

  it("2 tenpai vs 2 noten → +1500 / -1500 each", () => {
    const state = exhaustState({
      hands: [TENPAI, TENPAI, NOTEN, NOTEN],
    });
    const r = step(state, { type: "draw", seat: 0 });
    expect(r.state.lastHandResult?.delta).toEqual([1500, 1500, -1500, -1500]);
  });

  it("3 tenpai vs 1 noten → +1000 / -3000", () => {
    const state = exhaustState({
      hands: [TENPAI, TENPAI, TENPAI, NOTEN],
    });
    const r = step(state, { type: "draw", seat: 0 });
    expect(r.state.lastHandResult?.delta).toEqual([1000, 1000, 1000, -3000]);
  });

  it("all 4 tenpai → no payments", () => {
    const state = exhaustState({
      hands: [TENPAI, TENPAI, TENPAI, TENPAI],
    });
    const r = step(state, { type: "draw", seat: 0 });
    expect(r.state.lastHandResult?.delta).toEqual([0, 0, 0, 0]);
  });

  it("riichi-declared seat counted tenpai even if hand check fails", () => {
    // Riichi flag forces tenpai; noten hand otherwise.
    const state = exhaustState({
      hands: [NOTEN, NOTEN, NOTEN, NOTEN],
      riichiDeclared: [true, false, false, false],
    });
    const r = step(state, { type: "draw", seat: 0 });
    expect(r.state.lastHandResult?.tenpai).toEqual([true, false, false, false]);
    expect(r.state.lastHandResult?.delta).toEqual([3000, -1000, -1000, -1000]);
  });
});

describe("step — dealer-keep-on-tenpai at exhaustive draw", () => {
  const TENPAI = tiles("11m22p33s44m55p66s7z");
  const NOTEN = tiles("13579m13579p123s");

  it("dealer keeps + honba++ when dealer tenpai at exhaustive draw", () => {
    let state = craft({
      hands: [TENPAI, NOTEN, NOTEN, NOTEN],
      turn: 0,
      phase: "awaiting_draw",
      dealer: 0,
      liveWall: [],
    });
    state = step(state, { type: "draw", seat: 0 }).state;
    const after = step(state, { type: "start_next_hand" });
    expect(after.state.dealer).toBe(0);
    expect(after.state.roundNumber).toBe(1);
    expect(after.state.honba).toBe(1);
  });

  it("dealer rotates + honba++ when dealer noten at exhaustive draw", () => {
    let state = craft({
      hands: [NOTEN, TENPAI, NOTEN, NOTEN],
      turn: 0,
      phase: "awaiting_draw",
      dealer: 0,
      liveWall: [],
    });
    state = step(state, { type: "draw", seat: 0 }).state;
    const after = step(state, { type: "start_next_hand" });
    expect(after.state.dealer).toBe(1);
    expect(after.state.roundNumber).toBe(2);
    expect(after.state.honba).toBe(1);
  });
});

describe("step — riichi sticks carry over on exhaustive draw", () => {
  it("riichi sticks remain on the table after exhaustive draw", () => {
    const TENPAI = tiles("11m22p33s44m55p66s7z");
    const NOTEN = tiles("13579m13579p123s");
    const base = craft({
      hands: [TENPAI, NOTEN, NOTEN, NOTEN],
      turn: 0,
      phase: "awaiting_draw",
      dealer: 0,
      liveWall: [],
    });
    const state: MatchState = { ...base, riichiSticks: 2 };
    const r = step(state, { type: "draw", seat: 0 });
    expect(r.state.riichiSticks).toBe(2);
  });
});

describe("step — riichi ankan legality", () => {
  it("rejects ankan during riichi when it removes a hand interpretation", () => {
    // Pre-riichi 13-tile hand: 11122333p99m789s.
    // Wait set {2p, 9m} has two decompositions; declaring kan on
    // 1p destroys the kanchan reading.
    const hand = tiles("11122333p99m789s1p"); // 14 (drew the 4th 1p)
    const state = craft({
      hands: [hand, FILLER, FILLER, FILLER],
      turn: 0,
      phase: "awaiting_discard",
      dealer: 0,
      lastDrawn: "1p",
      riichiDeclared: [true, false, false, false],
    });
    const r = step(state, { type: "kan", seat: 0, kind: "ankan", tile: "1p" });
    expect(r.events).toEqual([]);
    expect(r.state).toBe(state);
  });

  it("accepts ankan during riichi when no run-using-kan reading exists", () => {
    // 999m + 234p 234s 11z 67m (13 tiles). Wait on 5m/8m via 67m.
    // 9m has no 7m/8m neighbours that could form 789m with our 9m
    // copies in any winning decomposition, so 9999m ankan preserves
    // every reading.
    const hand = tiles("999m234p234s11z67m9m"); // 14 (drew 4th 9m)
    const state = craft({
      hands: [hand, FILLER, FILLER, FILLER],
      turn: 0,
      phase: "awaiting_discard",
      dealer: 0,
      lastDrawn: "9m",
      riichiDeclared: [true, false, false, false],
      // Provide a deadWall with a known rinshan tile.
      deadWall: tiles("5z111z2z3z4z5z6z7z1m2m3m4m5m"),
    });
    const r = step(state, { type: "kan", seat: 0, kind: "ankan", tile: "9m" });
    expect(r.events[0]).toMatchObject({ type: "call" });
    expect(r.state.melds[0]).toHaveLength(1);
    expect(r.state.melds[0][0].type).toBe("ankan");
  });
});
