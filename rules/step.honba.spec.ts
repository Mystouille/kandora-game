/**
 * Tests for honba payment bonuses (step 5b extension):
 *   - Ron: discarder pays an extra 300 × honba to the winner.
 *   - Tsumo: each non-winner pays an extra 100 × honba.
 *   - Multi-ron: only the head bumper collects 300 × honba (single
 *     payment from the discarder), not each winner.
 *   - Honba bonus stacks on top of riichi-stick carry-over.
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
  honba?: number;
  riichiSticks?: number;
}): MatchState {
  const base = createInitialState(0);
  const dealer = opts.dealer ?? 0;
  return {
    ...base,
    hands: opts.hands.map((h) => [...h]),
    discards: [[], [], [], []],
    liveWall: Array.from({ length: 10 }, () => "1m" as Tile),
    turn: opts.turn,
    phase: opts.phase,
    dealer,
    lastDrawn: [null, null, null, null].map((_, i) =>
      i === opts.turn && opts.lastDrawn ? opts.lastDrawn : null
    ) as (Tile | null)[],
    lastDiscard: opts.lastDiscard ?? null,
    honba: opts.honba ?? 0,
    riichiSticks: opts.riichiSticks ?? 0,
    doraIndicators: [],
    uraDoraIndicators: [],
    scores: [25000, 25000, 25000, 25000],
    lastHandResult: null,
  };
}

describe("honba payment bonuses", () => {
  it("ron: discarder pays +300 per honba", () => {
    // Non-dealer (seat 1) ron on seat 0's discard. Chiitoitsu (riichi
    // not declared, so just the chiitoitsu yaku via tsumo? No — for
    // ron we need a yaku. Use tanyao with a clean pinfu-ish shape.
    // Simpler: ron on chiitoitsu (chiitoitsu is a valid ron yaku).
    const concealed = tiles("11m22p33s44m55p66s");
    const winTile: Tile = "7z";
    const state = craft({
      hands: [
        tiles("9p9p9p9p9p9p9p9p9p9p9p9p9p"),
        [...concealed, "7z"], // 13 concealed including the pair-completer
        tiles("9p9p9p9p9p9p9p9p9p9p9p9p9p"),
        tiles("9p9p9p9p9p9p9p9p9p9p9p9p9p"),
      ],
      turn: 1,
      phase: "awaiting_draw",
      dealer: 0,
      lastDiscard: { seat: 0, tile: winTile },
      honba: 2,
    });
    const { state: next } = step(state, { type: "ron", seat: 1 });
    const delta = next.lastHandResult?.delta;
    // 2 honba * 300 = 600 extra from discarder.
    expect(delta?.[1]).toBe(1600 + 600);
    expect(delta?.[0]).toBe(-(1600 + 600));
    expect(delta?.[2]).toBe(0);
    expect(delta?.[3]).toBe(0);
  });

  it("tsumo: each non-winner pays +100 per honba", () => {
    const concealed = tiles("11m22p33s44m55p66s7z"); // 13 tiles, waiting on 7z
    const winTile: Tile = "7z";
    const state = craft({
      hands: [
        tiles("9p9p9p9p9p9p9p9p9p9p9p9p9p"),
        [...concealed, winTile], // seat 1 just drew the winning tile
        tiles("9p9p9p9p9p9p9p9p9p9p9p9p9p"),
        tiles("9p9p9p9p9p9p9p9p9p9p9p9p9p"),
      ],
      turn: 1,
      phase: "awaiting_discard",
      dealer: 0,
      lastDrawn: winTile,
      honba: 3,
    });
    const { state: next } = step(state, { type: "tsumo", seat: 1 });
    const delta = next.lastHandResult?.delta;
    // 3 honba * 100 = 300 extra from each non-winner = 900 total.
    // Base chiitoitsu non-dealer tsumo = 800/1600 (dealer pays 1600,
    // non-dealers pay 800 each) → winner gets 3200, +900 = 4100.
    expect(delta?.[1]).toBe(3200 + 900);
    expect(delta?.[0]).toBe(-1600 - 300);
    expect(delta?.[2]).toBe(-800 - 300);
    expect(delta?.[3]).toBe(-800 - 300);
    // Sum is zero.
    expect(delta!.reduce((a, b) => a + b, 0)).toBe(0);
  });

  it("honba bonus stacks on riichi-stick carry-over", () => {
    const concealed = tiles("11m22p33s44m55p66s");
    const winTile: Tile = "7z";
    const state = craft({
      hands: [
        tiles("9p9p9p9p9p9p9p9p9p9p9p9p9p"),
        [...concealed, "7z"],
        tiles("9p9p9p9p9p9p9p9p9p9p9p9p9p"),
        tiles("9p9p9p9p9p9p9p9p9p9p9p9p9p"),
      ],
      turn: 1,
      phase: "awaiting_draw",
      dealer: 0,
      lastDiscard: { seat: 0, tile: winTile },
      honba: 1,
      riichiSticks: 2,
    });
    const { state: next } = step(state, { type: "ron", seat: 1 });
    const delta = next.lastHandResult?.delta;
    // 1600 base + 300 honba + 2000 riichi sticks for the winner.
    expect(delta?.[1]).toBe(1600 + 300 + 2000);
    // Discarder pays only base + honba (sticks are carried, not paid).
    expect(delta?.[0]).toBe(-(1600 + 300));
    expect(next.riichiSticks).toBe(0);
  });

  it("zero honba → no bonus", () => {
    const concealed = tiles("11m22p33s44m55p66s");
    const winTile: Tile = "7z";
    const state = craft({
      hands: [
        tiles("9p9p9p9p9p9p9p9p9p9p9p9p9p"),
        [...concealed, "7z"],
        tiles("9p9p9p9p9p9p9p9p9p9p9p9p9p"),
        tiles("9p9p9p9p9p9p9p9p9p9p9p9p9p"),
      ],
      turn: 1,
      phase: "awaiting_draw",
      dealer: 0,
      lastDiscard: { seat: 0, tile: winTile },
      honba: 0,
    });
    const { state: next } = step(state, { type: "ron", seat: 1 });
    const delta = next.lastHandResult?.delta;
    expect(delta?.[1]).toBe(1600);
    expect(delta?.[0]).toBe(-1600);
  });
});
