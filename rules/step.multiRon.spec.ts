/**
 * Tests for double / triple ron — multi-winner ron resolution.
 *
 * Engine surface: `step(state, { type: "ron", seat, additionalWinners })`.
 * Per-seat deltas are summed; one `win` event per winner; a single
 * `hand_end` carries the combined delta. Riichi sticks accrue to the
 * head bumper (`seat`).
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
  discarder: 0 | 1 | 2 | 3;
  tile: Tile;
  dealer?: 0 | 1 | 2 | 3;
  riichiSticks?: number;
}): MatchState {
  const base = createInitialState(0);
  return {
    ...base,
    hands: opts.hands.map((h) => [...h]),
    discards: [[], [], [], []],
    turn: ((opts.discarder + 1) % 4) as 0 | 1 | 2 | 3,
    phase: "awaiting_draw",
    dealer: opts.dealer ?? 0,
    lastDrawn: [null, null, null, null],
    lastDiscard: { seat: opts.discarder, tile: opts.tile },
    riichiSticks: opts.riichiSticks ?? 0,
    // Clear dora so scoring is deterministic across hand shapes.
    doraIndicators: [],
    uraDoraIndicators: [],
  };
}

const FILLER = tiles("9p9p9p9p9p9p9p9p9p9p9p9p9p");
// Two distinct chiitoitsu tenpai shapes both waiting on 7z:
const TENPAI_A = tiles("11m22p33s44m55p66s7z"); // chiitoitsu A wait 7z
const TENPAI_B = tiles("11p22s33m44p55s66m7z"); // chiitoitsu B wait 7z

describe("step — multi-ron (double ron)", () => {
  it("emits one win event per winner and a single hand_end", () => {
    const state = craft({
      hands: [FILLER, TENPAI_A, FILLER, TENPAI_B],
      discarder: 0,
      tile: "7z",
    });
    const { events, state: next } = step(state, {
      type: "ron",
      seat: 1,
      additionalWinners: [3],
    });
    const wins = events.filter((e) => e.type === "win");
    const ends = events.filter((e) => e.type === "hand_end");
    expect(wins).toHaveLength(2);
    expect(ends).toHaveLength(1);
    expect(next.phase).toBe("hand_ended");
  });

  it("sums per-winner deltas: discarder pays each separately", () => {
    const state = craft({
      hands: [FILLER, TENPAI_A, FILLER, TENPAI_B],
      discarder: 0,
      tile: "7z",
    });
    const { events, state: next } = step(state, {
      type: "ron",
      seat: 1,
      additionalWinners: [3],
    });
    const handEnd = events.find((e) => e.type === "hand_end");
    if (handEnd?.type !== "hand_end") {
      throw new Error("expected hand_end");
    }
    // Each non-dealer chiitoitsu ron = 1600 from the discarder.
    expect(handEnd.delta[1]).toBe(1600);
    expect(handEnd.delta[3]).toBe(1600);
    expect(handEnd.delta[0]).toBe(-3200);
    expect(handEnd.delta[2]).toBe(0);
    // Scores reflect the combined delta.
    expect(next.scores[0]).toBe(25000 - 3200);
    expect(next.scores[1]).toBe(25000 + 1600);
    expect(next.scores[3]).toBe(25000 + 1600);
  });

  it("awards all riichi sticks to the head bumper", () => {
    const state = craft({
      hands: [FILLER, TENPAI_A, FILLER, TENPAI_B],
      discarder: 0,
      tile: "7z",
      riichiSticks: 3,
    });
    const { events, state: next } = step(state, {
      type: "ron",
      seat: 1,
      additionalWinners: [3],
    });
    expect(next.riichiSticks).toBe(0);
    const handEnd = events.find((e) => e.type === "hand_end");
    if (handEnd?.type !== "hand_end") {
      throw new Error("expected hand_end");
    }
    // Head bumper (seat 1) gets 3 sticks * 1000 on top of their ron.
    expect(handEnd.delta[1]).toBe(1600 + 3000);
    expect(handEnd.delta[3]).toBe(1600);
  });

  it("rejects multi-ron when any winner is the discarder", () => {
    const state = craft({
      hands: [TENPAI_A, FILLER, FILLER, TENPAI_B],
      discarder: 0,
      tile: "7z",
    });
    const r = step(state, {
      type: "ron",
      seat: 0, // discarder cannot win
      additionalWinners: [3],
    });
    expect(r.events).toEqual([]);
  });

  it("rejects multi-ron when any winner has no valid agari", () => {
    const state = craft({
      hands: [FILLER, TENPAI_A, FILLER, FILLER], // seat 3 isn't tenpai
      discarder: 0,
      tile: "7z",
    });
    const r = step(state, {
      type: "ron",
      seat: 1,
      additionalWinners: [3],
    });
    expect(r.events).toEqual([]);
  });

  it("rejects duplicate winners", () => {
    const state = craft({
      hands: [FILLER, TENPAI_A, FILLER, TENPAI_B],
      discarder: 0,
      tile: "7z",
    });
    const r = step(state, {
      type: "ron",
      seat: 1,
      additionalWinners: [1],
    });
    expect(r.events).toEqual([]);
  });

  it("dealer keeps when dealer is among multi-ron winners", () => {
    // seat 0 is dealer + winner; seat 2 is the other winner;
    // seat 1 is the discarder.
    const state = craft({
      hands: [TENPAI_A, FILLER, TENPAI_B, FILLER],
      discarder: 1,
      tile: "7z",
      dealer: 0,
    });
    const { state: next } = step(state, {
      type: "ron",
      seat: 2, // head bumper (closest counter-clockwise from seat 1)
      additionalWinners: [0],
    });
    // Engine should record the dealer as `winner` so the rotation
    // logic in start_next_hand keeps the dealer.
    expect(next.lastHandResult?.winner).toBe(0);
    const after = step(next, { type: "start_next_hand" });
    expect(after.state.dealer).toBe(0);
    expect(after.state.honba).toBe(1);
  });
});
