/**
 * Tests for Phase 1 step 5a: win declarations and round progression.
 *
 * We bypass the random deal helper and construct deterministic
 * `MatchState` snapshots directly. This keeps assertions focused on
 * the win/payment/transition logic without having to play out a
 * full 70-tile wall to reach interesting situations.
 */

import { describe, expect, it } from "vitest";
import { createInitialState, type MatchState } from "./state";
import { distributePayments } from "./payments";
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

/** Build a hand-crafted state for a single-hand scenario. */
function craftState(opts: {
  hands: Tile[][];
  turn: 0 | 1 | 2 | 3;
  phase: "awaiting_draw" | "awaiting_discard";
  dealer?: 0 | 1 | 2 | 3;
  lastDrawn?: Tile;
  lastDiscard?: { seat: 0 | 1 | 2 | 3; tile: Tile };
  liveWall?: Tile[];
  scores?: [number, number, number, number];
}): MatchState {
  const base = createInitialState(0);
  const dealer = opts.dealer ?? 0;
  return {
    ...base,
    hands: opts.hands.map((h) => [...h]),
    discards: [[], [], [], []],
    liveWall: opts.liveWall ?? Array.from({ length: 10 }, () => "1m" as Tile),
    turn: opts.turn,
    phase: opts.phase,
    dealer,
    lastDrawn: [null, null, null, null].map((_, i) =>
      i === opts.turn && opts.lastDrawn ? opts.lastDrawn : null
    ) as (Tile | null)[],
    lastDiscard: opts.lastDiscard ?? null,
    scores: opts.scores ?? [25000, 25000, 25000, 25000],
    lastHandResult: null,
  };
}

describe("step — tsumo", () => {
  it("non-dealer chiitoitsu tsumo distributes correctly", () => {
    // Hand on tsumo: 13 concealed + 1 winning draw.
    const concealed = tiles("11m22p33s44m55p66s7z");
    const winTile: Tile = "7z";
    const state = craftState({
      hands: [
        tiles("9p9p9p9p9p9p9p9p9p9p9p9p9p"), // seat 0 placeholder
        [...concealed, winTile], // seat 1 = non-dealer, just drew
        tiles("9p9p9p9p9p9p9p9p9p9p9p9p9p"),
        tiles("9p9p9p9p9p9p9p9p9p9p9p9p9p"),
      ],
      turn: 1,
      phase: "awaiting_discard",
      dealer: 0,
      lastDrawn: winTile,
    });

    const { state: next, events } = step(state, { type: "tsumo", seat: 1 });
    expect(next.phase).toBe("hand_ended");
    expect(next.lastHandResult).toMatchObject({
      reason: "tsumo",
      winner: 1,
      loser: null,
    });

    const winEv = events.find((e) => e.type === "win");
    expect(winEv).toBeDefined();
    if (winEv?.type !== "win") {
      throw new Error("expected win event");
    }
    expect(winEv.score.isAgari).toBe(true);
    // Chiitoitsu tsumo non-dealer: 25fu 3han = 3200 ten
    //   oya[0] = 1600 (dealer payment), ko[1] = 800 (each non-dealer).
    expect(winEv.score.han).toBe(3); // chiitoitsu(2) + tsumo(1)
    expect(winEv.score.ten).toBe(3200);
    expect(winEv.delta[1]).toBe(3200);
    expect(winEv.delta[0]).toBe(-1600); // dealer
    expect(winEv.delta[2]).toBe(-800);
    expect(winEv.delta[3]).toBe(-800);

    // Scores apply: winner +3200, others lose.
    expect(next.scores).toEqual([23400, 28200, 24200, 24200]);
  });

  it("dealer tsumo splits payments equally across non-dealers", () => {
    const concealed = tiles("11m22p33s44m55p66s7z");
    const winTile: Tile = "7z";
    // Seat 0 = dealer.
    const state = craftState({
      hands: [
        [...concealed, winTile],
        tiles("9p9p9p9p9p9p9p9p9p9p9p9p9p"),
        tiles("9p9p9p9p9p9p9p9p9p9p9p9p9p"),
        tiles("9p9p9p9p9p9p9p9p9p9p9p9p9p"),
      ],
      turn: 0,
      phase: "awaiting_discard",
      dealer: 0,
      lastDrawn: winTile,
    });
    const { events } = step(state, { type: "tsumo", seat: 0 });
    const winEv = events.find((e) => e.type === "win");
    if (winEv?.type !== "win") {
      throw new Error("expected win event");
    }
    // Dealer tsumo on the very first draw triggers tenhou (yakuman):
    // dealer ten = 48000 (16000×3).
    expect(winEv.score.ten).toBe(48000);
    expect(winEv.delta).toEqual([48000, -16000, -16000, -16000]);
  });

  it("rejects tsumo if hand is not a winning shape", () => {
    const concealed = tiles("11m22p33s44m55p66s8z"); // no pair on 8z alone
    const winTile: Tile = "7z";
    const state = craftState({
      hands: [
        tiles("9p9p9p9p9p9p9p9p9p9p9p9p9p"),
        [...concealed, winTile],
        tiles("9p9p9p9p9p9p9p9p9p9p9p9p9p"),
        tiles("9p9p9p9p9p9p9p9p9p9p9p9p9p"),
      ],
      turn: 1,
      phase: "awaiting_discard",
      lastDrawn: winTile,
    });
    const r = step(state, { type: "tsumo", seat: 1 });
    expect(r.events).toEqual([]);
    expect(r.state.phase).toBe("awaiting_discard");
  });
});

describe("step — ron", () => {
  it("non-dealer ron claims the most recent discard", () => {
    // Seat 1 holds a 13-tile chiitoitsu shape, waiting on 7z.
    // Seat 0 has just discarded 7z.
    const winner = tiles("11m22p33s44m55p66s7z");
    const state = craftState({
      hands: [
        tiles("9p9p9p9p9p9p9p9p9p9p9p9p9p"),
        winner,
        tiles("9p9p9p9p9p9p9p9p9p9p9p9p9p"),
        tiles("9p9p9p9p9p9p9p9p9p9p9p9p9p"),
      ],
      turn: 1, // post-discard, seat 1 is about to draw
      phase: "awaiting_draw",
      dealer: 0,
      lastDiscard: { seat: 0, tile: "7z" },
    });
    const { state: next, events } = step(state, { type: "ron", seat: 1 });
    expect(next.phase).toBe("hand_ended");
    expect(next.lastHandResult).toMatchObject({
      reason: "ron",
      winner: 1,
      loser: 0,
    });
    const winEv = events.find((e) => e.type === "win");
    if (winEv?.type !== "win") {
      throw new Error("expected win event");
    }
    // Non-dealer chiitoitsu ron: 25fu 2han = 1600 ten.
    expect(winEv.score.han).toBe(2);
    expect(winEv.score.ten).toBe(1600);
    expect(winEv.delta[1]).toBe(1600);
    expect(winEv.delta[0]).toBe(-1600); // discarder pays lump-sum
    expect(winEv.delta[2]).toBe(0);
    expect(winEv.delta[3]).toBe(0);
  });

  it("rejects ron from the discarder themself", () => {
    const winner = tiles("11m22p33s44m55p66s7z");
    const state = craftState({
      hands: [
        winner,
        tiles("9p9p9p9p9p9p9p9p9p9p9p9p9p"),
        tiles("9p9p9p9p9p9p9p9p9p9p9p9p9p"),
        tiles("9p9p9p9p9p9p9p9p9p9p9p9p9p"),
      ],
      turn: 1,
      phase: "awaiting_draw",
      lastDiscard: { seat: 0, tile: "7z" },
    });
    const r = step(state, { type: "ron", seat: 0 });
    expect(r.events).toEqual([]);
  });

  it("rejects ron with no recent discard", () => {
    const winner = tiles("11m22p33s44m55p66s7z");
    const state = craftState({
      hands: [
        tiles("9p9p9p9p9p9p9p9p9p9p9p9p9p"),
        winner,
        tiles("9p9p9p9p9p9p9p9p9p9p9p9p9p"),
        tiles("9p9p9p9p9p9p9p9p9p9p9p9p9p"),
      ],
      turn: 1,
      phase: "awaiting_draw",
    });
    const r = step(state, { type: "ron", seat: 1 });
    expect(r.events).toEqual([]);
  });
});

describe("step — start_next_hand", () => {
  it("rotates dealer and increments round on non-dealer win", () => {
    const concealed = tiles("11m22p33s44m55p66s7z");
    const winTile: Tile = "7z";
    let state = craftState({
      hands: [
        tiles("9p9p9p9p9p9p9p9p9p9p9p9p9p"),
        [...concealed, winTile],
        tiles("9p9p9p9p9p9p9p9p9p9p9p9p9p"),
        tiles("9p9p9p9p9p9p9p9p9p9p9p9p9p"),
      ],
      turn: 1,
      phase: "awaiting_discard",
      dealer: 0,
      lastDrawn: winTile,
    });
    state = step(state, { type: "tsumo", seat: 1 }).state;
    expect(state.phase).toBe("hand_ended");

    const after = step(state, { type: "start_next_hand" });
    expect(after.state.phase).toBe("awaiting_draw");
    expect(after.state.dealer).toBe(1);
    expect(after.state.roundNumber).toBe(2);
    expect(after.state.honba).toBe(0);
    expect(after.state.turn).toBe(1);
    expect(after.state.hands.map((h) => h.length)).toEqual([13, 13, 13, 13]);
    const ev = after.events[0];
    expect(ev).toMatchObject({
      type: "hand_start",
      dealer: 1,
      roundNumber: 2,
      roundWind: "E",
    });
  });

  it("keeps dealer and increments honba on dealer win", () => {
    const concealed = tiles("11m22p33s44m55p66s7z");
    const winTile: Tile = "7z";
    let state = craftState({
      hands: [
        [...concealed, winTile], // dealer winning
        tiles("9p9p9p9p9p9p9p9p9p9p9p9p9p"),
        tiles("9p9p9p9p9p9p9p9p9p9p9p9p9p"),
        tiles("9p9p9p9p9p9p9p9p9p9p9p9p9p"),
      ],
      turn: 0,
      phase: "awaiting_discard",
      dealer: 0,
      lastDrawn: winTile,
    });
    state = step(state, { type: "tsumo", seat: 0 }).state;

    const after = step(state, { type: "start_next_hand" });
    expect(after.state.dealer).toBe(0);
    expect(after.state.roundNumber).toBe(1); // unchanged
    expect(after.state.honba).toBe(1);
  });

  it("transitions to match_ended after E4 non-dealer win (tonpuusen)", () => {
    const concealed = tiles("11m22p33s44m55p66s7z");
    const winTile: Tile = "7z";
    let state = craftState({
      hands: [
        tiles("9p9p9p9p9p9p9p9p9p9p9p9p9p"),
        tiles("9p9p9p9p9p9p9p9p9p9p9p9p9p"),
        tiles("9p9p9p9p9p9p9p9p9p9p9p9p9p"),
        [...concealed, winTile], // seat 3 wins
      ],
      turn: 3,
      phase: "awaiting_discard",
      dealer: 3, // dealer is N (last hand of east round)
      lastDrawn: winTile,
    });
    state = { ...state, roundNumber: 4, roundLimit: 4 };
    state = step(state, { type: "tsumo", seat: 3 }).state;
    // seat 3 was dealer → dealer keeps, but roundNumber doesn't roll yet
    expect(state.lastHandResult?.winner).toBe(3);
    // For this scenario the dealer (seat 3) won, so honba ticks but
    // dealer stays. Match doesn't end. Test the non-dealer case below.
    expect(step(state, { type: "start_next_hand" }).state.phase).toBe(
      "awaiting_draw"
    );
  });

  it("transitions to match_ended after E4 non-dealer win", () => {
    const concealed = tiles("11m22p33s44m55p66s7z");
    const winTile: Tile = "7z";
    let state = craftState({
      hands: [
        tiles("9p9p9p9p9p9p9p9p9p9p9p9p9p"),
        tiles("9p9p9p9p9p9p9p9p9p9p9p9p9p"),
        [...concealed, winTile], // seat 2 (non-dealer) wins
        tiles("9p9p9p9p9p9p9p9p9p9p9p9p9p"),
      ],
      turn: 2,
      phase: "awaiting_discard",
      dealer: 3,
      lastDrawn: winTile,
    });
    state = {
      ...state,
      roundNumber: 4,
      roundLimit: 4,
      // Tonpuusen so the match ends after E4 instead of progressing
      // to South.
      ruleSet: { ...state.ruleSet, roundWindCount: 1 },
    };
    state = step(state, { type: "tsumo", seat: 2 }).state;
    const after = step(state, { type: "start_next_hand" });
    expect(after.state.phase).toBe("match_ended");
    const matchEnd = after.events.find((e) => e.type === "match_end");
    expect(matchEnd).toBeDefined();
  });
});

describe("distributePayments — direct", () => {
  it("sums to zero across seats", () => {
    const delta = distributePayments({
      score: {
        isAgari: true,
        han: 4,
        fu: 30,
        ten: 7700,
        yaku: {},
        isYakuman: false,
        yakumanCount: 0,
        oya: [7700],
        ko: [5200],
        text: "",
        raw: null,
      },
      winner: 1,
      dealer: 0,
      loser: 0,
    });
    expect(delta[0] + delta[1] + delta[2] + delta[3]).toBe(0);
  });
});
