/**
 * Phase 1 step 5c — calls (chi / pon / daiminkan / ankan).
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
  discards?: Tile[][];
  riichiDeclared?: [boolean, boolean, boolean, boolean];
  ippatsuEligible?: [boolean, boolean, boolean, boolean];
}): MatchState {
  const base = createInitialState(0);
  const dealer = opts.dealer ?? 0;
  const discards =
    opts.discards ??
    (opts.lastDiscard
      ? (() => {
          const d: Tile[][] = [[], [], [], []];
          d[opts.lastDiscard!.seat].push(opts.lastDiscard!.tile);
          return d;
        })()
      : [[], [], [], []]);
  return {
    ...base,
    hands: opts.hands.map((h) => [...h]),
    discards,
    liveWall: opts.liveWall ?? Array.from({ length: 20 }, () => "1m" as Tile),
    doraIndicators: [],
    uraDoraIndicators: [],
    turn: opts.turn,
    phase: opts.phase,
    dealer,
    lastDrawn: [null, null, null, null].map((_, i) =>
      i === opts.turn && opts.lastDrawn ? opts.lastDrawn : null
    ) as (Tile | null)[],
    lastDiscard: opts.lastDiscard ?? null,
    riichiDeclared: opts.riichiDeclared ?? [false, false, false, false],
    doubleRiichi: [false, false, false, false],
    ippatsuEligible: opts.ippatsuEligible ?? [false, false, false, false],
    melds: [[], [], [], []],
    lastHandResult: null,
  };
}

const FILLER = tiles("9p9p9p9p9p9p9p9p9p9p9p9p9p");

describe("step — chi", () => {
  it("accepts chi from the next seat with valid pair from hand", () => {
    // Seat 0 discards 4m; seat 1 calls chi using 5m + 6m.
    const seat1Hand = tiles("5m6m1p2p3p4p5p6p7p8p9p1s2s");
    const state = craft({
      hands: [FILLER, seat1Hand, FILLER, FILLER],
      turn: 1, // post-discard, seat 1 is about to draw
      phase: "awaiting_draw",
      dealer: 0,
      lastDiscard: { seat: 0, tile: "4m" },
    });
    const r = step(state, {
      type: "chi",
      seat: 1,
      tiles: ["5m", "6m"],
    });
    expect(r.events).toHaveLength(1);
    expect(r.events[0]).toMatchObject({ type: "call", seat: 1 });
    expect(r.state.melds[1]).toHaveLength(1);
    expect(r.state.melds[1][0]).toMatchObject({
      type: "chi",
      tiles: ["4m", "5m", "6m"],
      claimedTile: "4m",
      from: 0,
    });
    expect(r.state.hands[1]).not.toContain("5m");
    expect(r.state.hands[1]).not.toContain("6m");
    expect(r.state.discards[0]).not.toContain("4m");
    expect(r.state.turn).toBe(1);
    expect(r.state.phase).toBe("awaiting_discard");
    expect(r.state.lastDiscard).toBeNull();
  });

  it("rejects chi from a non-adjacent seat", () => {
    const seat2Hand = tiles("5m6m1p2p3p4p5p6p7p8p9p1s2s");
    const state = craft({
      hands: [FILLER, FILLER, seat2Hand, FILLER],
      turn: 1,
      phase: "awaiting_draw",
      lastDiscard: { seat: 0, tile: "4m" },
    });
    const r = step(state, {
      type: "chi",
      seat: 2,
      tiles: ["5m", "6m"],
    });
    expect(r.events).toEqual([]);
    expect(r.state.melds[2]).toHaveLength(0);
  });

  it("rejects chi on an honor tile", () => {
    const seat1Hand = tiles("1z2z3z4z5z6z7z1m2m3m4m5m6m");
    const state = craft({
      hands: [FILLER, seat1Hand, FILLER, FILLER],
      turn: 1,
      phase: "awaiting_draw",
      lastDiscard: { seat: 0, tile: "1z" },
    });
    const r = step(state, {
      type: "chi",
      seat: 1,
      tiles: ["2z", "3z"],
    });
    expect(r.events).toEqual([]);
  });

  it("rejects chi when contributed tiles do not form a run with claimed", () => {
    const seat1Hand = tiles("5m7m1p2p3p4p5p6p7p8p9p1s2s");
    const state = craft({
      hands: [FILLER, seat1Hand, FILLER, FILLER],
      turn: 1,
      phase: "awaiting_draw",
      lastDiscard: { seat: 0, tile: "4m" },
    });
    const r = step(state, {
      type: "chi",
      seat: 1,
      tiles: ["5m", "7m"],
    });
    expect(r.events).toEqual([]);
  });

  it("rejects chi from a riichi-declared seat", () => {
    const seat1Hand = tiles("5m6m1p2p3p4p5p6p7p8p9p1s2s");
    const state = craft({
      hands: [FILLER, seat1Hand, FILLER, FILLER],
      turn: 1,
      phase: "awaiting_draw",
      lastDiscard: { seat: 0, tile: "4m" },
      riichiDeclared: [false, true, false, false],
    });
    const r = step(state, {
      type: "chi",
      seat: 1,
      tiles: ["5m", "6m"],
    });
    expect(r.events).toEqual([]);
  });
});

describe("step — pon", () => {
  it("accepts pon from any non-discarder seat", () => {
    const seat2Hand = tiles("4m4m1p2p3p4p5p6p7p8p9p1s2s");
    const state = craft({
      hands: [FILLER, FILLER, seat2Hand, FILLER],
      turn: 1, // doesn't matter — pon overrides turn
      phase: "awaiting_draw",
      lastDiscard: { seat: 0, tile: "4m" },
    });
    const r = step(state, {
      type: "pon",
      seat: 2,
      tiles: ["4m", "4m"],
    });
    expect(r.events).toHaveLength(1);
    expect(r.state.melds[2][0]).toMatchObject({
      type: "pon",
      tiles: ["4m", "4m", "4m"],
      from: 0,
    });
    expect(r.state.turn).toBe(2);
    expect(r.state.phase).toBe("awaiting_discard");
  });

  it("rejects self-pon (discarder calling their own tile)", () => {
    const state = craft({
      hands: [tiles("4m4m1p2p3p4p5p6p7p8p9p1s2s"), FILLER, FILLER, FILLER],
      turn: 1,
      phase: "awaiting_draw",
      lastDiscard: { seat: 0, tile: "4m" },
    });
    const r = step(state, {
      type: "pon",
      seat: 0,
      tiles: ["4m", "4m"],
    });
    expect(r.events).toEqual([]);
  });

  it("clears all four ippatsu flags when called", () => {
    const seat2Hand = tiles("4m4m1p2p3p4p5p6p7p8p9p1s2s");
    const state = craft({
      hands: [FILLER, FILLER, seat2Hand, FILLER],
      turn: 1,
      phase: "awaiting_draw",
      lastDiscard: { seat: 0, tile: "4m" },
      ippatsuEligible: [true, true, true, true],
    });
    const r = step(state, {
      type: "pon",
      seat: 2,
      tiles: ["4m", "4m"],
    });
    expect(r.state.ippatsuEligible).toEqual([false, false, false, false]);
  });
});

describe("step — daiminkan", () => {
  it("accepts daiminkan, draws rinshan, reveals new dora", () => {
    const seat2Hand = tiles("4m4m4m1p2p3p4p5p6p7p8p9p1s");
    const state = craft({
      hands: [FILLER, FILLER, seat2Hand, FILLER],
      turn: 1,
      phase: "awaiting_draw",
      lastDiscard: { seat: 0, tile: "4m" },
    });
    // Rig the dead wall: rinshan slot 0 = "9z", new dora indicator at idx 3 = "8z".
    const dw = [...state.deadWall];
    dw[0] = "9z";
    dw[3] = "8z";
    dw[4] = "7z"; // already-revealed slot (we set doraIndicators = []), but new layout uses idx 3 after rinshan removed
    const seeded: MatchState = {
      ...state,
      deadWall: dw,
      doraIndicators: ["1m"], // pretend one dora already shown
    };
    const r = step(seeded, {
      type: "kan",
      seat: 2,
      kind: "daiminkan",
      tile: "4m",
    });
    expect(r.events.find((e) => e.type === "call")).toBeDefined();
    expect(r.events.find((e) => e.type === "new_dora")).toBeDefined();
    expect(r.state.melds[2][0]).toMatchObject({
      type: "daiminkan",
      tiles: ["4m", "4m", "4m", "4m"],
    });
    expect(r.state.lastDrawn[2]).toBe("9z");
    expect(r.state.hands[2]).toContain("9z");
    expect(r.state.doraIndicators).toHaveLength(2);
    expect(r.state.turn).toBe(2);
    expect(r.state.phase).toBe("awaiting_discard");
  });

  it("rejects daiminkan when caller does not hold 3 matching tiles", () => {
    const seat2Hand = tiles("4m4m1p2p3p4p5p6p7p8p9p1s2s");
    const state = craft({
      hands: [FILLER, FILLER, seat2Hand, FILLER],
      turn: 1,
      phase: "awaiting_draw",
      lastDiscard: { seat: 0, tile: "4m" },
    });
    const r = step(state, {
      type: "kan",
      seat: 2,
      kind: "daiminkan",
      tile: "4m",
    });
    expect(r.events).toEqual([]);
  });
});

describe("step — ankan", () => {
  it("accepts ankan, draws rinshan, reveals new dora", () => {
    // 14-tile hand with 4×4m; just drew the 4th 4m.
    const seat0Hand = tiles("4m4m4m4m1p2p3p4p5p6p7p8p9p1s");
    const state = craft({
      hands: [seat0Hand, FILLER, FILLER, FILLER],
      turn: 0,
      phase: "awaiting_discard",
      dealer: 0,
      lastDrawn: "1s",
    });
    const dw = [...state.deadWall];
    dw[0] = "9z";
    dw[3] = "8z";
    const seeded: MatchState = {
      ...state,
      deadWall: dw,
      doraIndicators: ["1m"],
    };
    const r = step(seeded, {
      type: "kan",
      seat: 0,
      kind: "ankan",
      tile: "4m",
    });
    expect(r.events.find((e) => e.type === "call")).toBeDefined();
    expect(r.state.melds[0][0]).toMatchObject({
      type: "ankan",
      tiles: ["4m", "4m", "4m", "4m"],
      from: null,
      claimedTile: null,
    });
    expect(r.state.lastDrawn[0]).toBe("9z");
    expect(r.state.doraIndicators).toHaveLength(2);
    expect(r.state.phase).toBe("awaiting_discard");
    expect(r.state.turn).toBe(0);
  });

  it("rejects ankan when caller does not hold 4 matching tiles", () => {
    const seat0Hand = tiles("4m4m4m1p2p3p4p5p6p7p8p9p1s2s");
    const state = craft({
      hands: [seat0Hand, FILLER, FILLER, FILLER],
      turn: 0,
      phase: "awaiting_discard",
      dealer: 0,
      lastDrawn: "2s",
    });
    const r = step(state, {
      type: "kan",
      seat: 0,
      kind: "ankan",
      tile: "4m",
    });
    expect(r.events).toEqual([]);
  });
});

describe("step — open-hand scoring (ron after pon)", () => {
  it("scores a ron on an open hand with pon", () => {
    // Hand-rig an open-hand winning shape:
    // Pon of 1z (East), concealed 234m + 567m + 789m + pair 5p
    // wait on 5p (ron 5p completes the pair).
    // Concealed 10 tiles: 234m 567m 789m 5p (10 tiles); ron 5p completes pair.
    const seat0Hand = tiles("234m567p789s5p"); // 10 tiles
    const state = craft({
      hands: [seat0Hand, FILLER, FILLER, FILLER],
      turn: 1, // seat 0 is dealer; about to be claimed
      phase: "awaiting_draw",
      dealer: 0,
      lastDiscard: { seat: 1, tile: "5p" },
    });
    // Inject the meld manually.
    const seeded: MatchState = {
      ...state,
      melds: [
        [
          {
            type: "pon",
            tiles: ["1z", "1z", "1z"],
            claimedTile: "1z",
            from: 3,
          },
        ],
        [],
        [],
        [],
      ],
    };
    const r = step(seeded, { type: "ron", seat: 0 });
    const winEv = r.events.find((e) => e.type === "win");
    expect(winEv).toBeDefined();
    if (winEv?.type !== "win") {
      throw new Error("expected win");
    }
    expect(winEv.score.isAgari).toBe(true);
    // Yaku: yakuhai East (round + seat) = 2 han for dealer
    // (round wind E + seat wind E = 2). Hand is open so no riichi/pinfu.
    expect(winEv.score.han).toBeGreaterThanOrEqual(2);
  });

  it("rejects open tsumo with no yaku (dora alone is not a yaku)", () => {
    // Open hand with chi 123m. Concealed: 234p, 78p, 567s, 99m.
    // Tsumo on 6p completes a winning shape, but the hand has no
    // yaku at all (no tanyao — has 9m/1m terminals, no yakuhai —
    // 99m is non-yakuhai, no sanshoku/ittsuu/honitsu/chanta).
    // Even with a dora indicator hitting 9m (99m = 2 dora), the
    // win must be rejected.
    const seat0Concealed = tiles("99m23478p567s"); // 10 tiles
    const winTile: Tile = "6p";
    const state = craft({
      hands: [[...seat0Concealed, winTile], FILLER, FILLER, FILLER],
      turn: 0,
      phase: "awaiting_discard",
      dealer: 0,
      lastDrawn: winTile,
    });
    const seeded: MatchState = {
      ...state,
      doraIndicators: ["8m"], // makes 9m dora; 99m would count as 2 dora
      melds: [
        [
          {
            type: "chi",
            tiles: ["1m", "2m", "3m"],
            claimedTile: "1m",
            from: 3,
          },
        ],
        [],
        [],
        [],
      ],
    };
    const r = step(seeded, { type: "tsumo", seat: 0 });
    expect(r.events).toEqual([]);
    expect(r.state.phase).toBe("awaiting_discard");
  });
});
