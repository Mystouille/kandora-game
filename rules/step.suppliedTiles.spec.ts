import { describe, expect, it } from "vitest";
import { createInitialState, type MatchState, type Meld } from "./state";
import { step } from "./step";
import { dealMatch } from "./wall";
import type { Tile } from "./types";

function tiles(compact: string): Tile[] {
  const result: Tile[] = [];
  let digits = "";
  for (const character of compact) {
    if (character >= "0" && character <= "9") {
      digits += character;
      continue;
    }
    for (const digit of digits) {
      result.push(`${digit}${character}`);
    }
    digits = "";
  }
  return result;
}

const filler = tiles("9p9p9p9p9p9p9p9p9p9p9p9p9p");
const fixedDeadWall = tiles("1z2z3z4z5z6z7z1m2m3m4m5m6m7m");

function fixedWallState(overrides: Partial<MatchState>): MatchState {
  return {
    ...createInitialState(1),
    hands: [filler, filler, filler, filler].map((hand) => [...hand]),
    discards: [[], [], [], []],
    liveWall: ["8z", "9m", "8z", "8m"],
    deadWall: [...fixedDeadWall],
    doraIndicators: [fixedDeadWall[4]],
    uraDoraIndicators: [fixedDeadWall[5]],
    pendingKanDora: [],
    pendingKanUraDora: [],
    melds: [[], [], [], []],
    lastDrawn: [null, null, null, null],
    lastDiscard: null,
    ...overrides,
  };
}

describe("step supplied tile directives", () => {
  it("creates an initial state from a supplied legal deal", () => {
    const deal = dealMatch(9876);
    const state = createInitialState(1234, { deal });

    expect(state.seed).toBe(1234);
    expect(state.hands).toEqual(deal.hands);
    expect(state.liveWall).toEqual(deal.liveWall);
    expect(state.deadWall).toEqual(deal.deadWall);
  });

  it("draws a supplied tile from the live-wall inventory", () => {
    const state = createInitialState(1);
    const supplied = state.liveWall[12];
    const beforeCount = state.liveWall.filter((tile) => tile === supplied).length;

    const result = step(state, { type: "draw", seat: 0, tile: supplied });

    expect(result.events[0]).toMatchObject({
      type: "draw",
      seat: 0,
      tile: supplied,
      wallRemaining: 69,
    });
    expect(
      result.state.liveWall.filter((tile) => tile === supplied)
    ).toHaveLength(beforeCount - 1);
    expect(result.state.lastDrawn[0]).toBe(supplied);
  });

  it("rejects a supplied tile absent from the live-wall inventory", () => {
    const state = createInitialState(1);
    state.liveWall = ["1m"];

    expect(step(state, { type: "draw", seat: 0, tile: "9z" })).toEqual({
      state,
      events: [],
    });
  });

  it("can exhaust a hand while other seats still have reserved tiles", () => {
    const state = createInitialState(1);
    const remaining = [...state.liveWall];

    const result = step(state, {
      type: "draw",
      seat: 0,
      forceExhaustive: true,
    });

    expect(result.state.phase).toBe("hand_ended");
    expect(result.state.lastHandResult?.reason).toBe("exhaustive_draw");
    expect(result.state.liveWall).toEqual(remaining);
    expect(result.events).toEqual([
      expect.objectContaining({ type: "hand_end", reason: "exhaustive_draw" }),
    ]);
  });

  it("uses a supplied ankan replacement without rotating the dead wall", () => {
    const hand = tiles("4m4m4m4m1p2p3p4p5p6p7p8p9p1s");
    const state = fixedWallState({
      hands: [hand, filler, filler, filler].map((value) => [...value]),
      turn: 0,
      phase: "awaiting_discard",
      lastDrawn: ["1s", null, null, null],
    });
    const deadWallBefore = [...state.deadWall];

    const result = step(state, {
      type: "kan",
      seat: 0,
      kind: "ankan",
      tile: "4m",
      replacementTile: "8z",
    });

    expect(result.events).toContainEqual(
      expect.objectContaining({
        type: "draw",
        seat: 0,
        tile: "8z",
        fromDeadWall: true,
      })
    );
    expect(result.state.liveWall).toHaveLength(3);
    expect(result.state.deadWall).toEqual(deadWallBefore);
    expect(result.state.doraIndicators).toEqual(["5z", "7z"]);
  });

  it("uses a supplied daiminkan replacement from the caller's inventory", () => {
    const callerHand = tiles("4m4m4m1p2p3p4p5p6p7p8p9p1s");
    const state = fixedWallState({
      hands: [filler, filler, callerHand, filler].map((value) => [...value]),
      discards: [["4m"], [], [], []],
      turn: 1,
      phase: "awaiting_draw",
      lastDiscard: { seat: 0, tile: "4m" },
    });
    const deadWallBefore = [...state.deadWall];

    const result = step(state, {
      type: "kan",
      seat: 2,
      kind: "daiminkan",
      tile: "4m",
      replacementTile: "8z",
    });

    expect(result.events).toContainEqual(
      expect.objectContaining({
        type: "draw",
        seat: 2,
        tile: "8z",
        fromDeadWall: true,
      })
    );
    expect(result.state.deadWall).toEqual(deadWallBefore);
    expect(result.state.liveWall).toHaveLength(3);
  });

  it("does not consume a shouminkan replacement until completion", () => {
    const pon: Meld = {
      type: "pon",
      tiles: ["3m", "3m", "3m"],
      claimedTile: "3m",
      from: 1,
    };
    const hand = tiles("3m1p2p3p4p5p6p7p8p9p1s2s");
    const state = fixedWallState({
      hands: [hand, filler, filler, filler].map((value) => [...value]),
      turn: 0,
      phase: "awaiting_discard",
      lastDrawn: ["3m", null, null, null],
      melds: [[pon], [], [], []],
    });

    const declared = step(state, {
      type: "kan",
      seat: 0,
      kind: "shouminkan",
      tile: "3m",
    });
    expect(declared.state.liveWall).toEqual(state.liveWall);

    const completed = step(declared.state, {
      type: "complete_shouminkan",
      replacementTile: "8z",
    });
    expect(completed.events).toContainEqual(
      expect.objectContaining({
        type: "draw",
        seat: 0,
        tile: "8z",
        fromDeadWall: true,
      })
    );
    expect(completed.state.liveWall).toHaveLength(3);
    expect(completed.state.deadWall).toEqual(state.deadWall);
  });

  it("starts the next hand from a supplied deal", () => {
    const state = createInitialState(1);
    state.phase = "hand_ended";
    state.lastHandResult = {
      reason: "abort",
      winner: null,
      loser: null,
      delta: [0, 0, 0, 0],
      tenpai: null,
      abortKind: "kyuushuu",
      winHan: null,
      winYakuman: null,
    };
    const deal = dealMatch(4321);

    const result = step(state, { type: "start_next_hand", deal });

    expect(result.state.hands).toEqual(deal.hands);
    expect(result.state.liveWall).toEqual(deal.liveWall);
    expect(result.state.deadWall).toEqual(deal.deadWall);
  });
});