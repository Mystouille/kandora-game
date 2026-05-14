/**
 * Tests for nagashi mangan at exhaustive draw.
 *
 * Qualification:
 *   - Every discard in `discards[seat]` is terminal/honor.
 *   - No tile from `seat` was ever called by another player
 *     (detected by scanning all melds for `from === seat`).
 *
 * Payment: tsumo-mangan stacked on top of the regular tenpai
 * payments. Multiple seats can qualify independently.
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

function craft(opts: {
  discards: Tile[][];
  melds?: Meld[][];
  hands?: Tile[][];
  dealer?: 0 | 1 | 2 | 3;
}): MatchState {
  const base = createInitialState(0);
  const placeholder = tiles("9p9p9p9p9p9p9p9p9p9p9p9p9p");
  return {
    ...base,
    hands: opts.hands ?? [
      [...placeholder],
      [...placeholder],
      [...placeholder],
      [...placeholder],
    ],
    discards: opts.discards.map((d) => [...d]),
    melds: opts.melds ?? [[], [], [], []],
    liveWall: [], // exhaustive-draw trigger
    deadWall: Array.from({ length: 14 }, () => "1m" as Tile),
    turn: 0,
    phase: "awaiting_draw",
    dealer: opts.dealer ?? 0,
    scores: [25000, 25000, 25000, 25000],
    lastHandResult: null,
  };
}

describe("nagashi mangan", () => {
  it("non-dealer with all-yaochuhai uncalled discards collects 8000", () => {
    const noten = tiles("1m2m3m4m5m6m7m"); // mixed
    const state = craft({
      discards: [
        noten,
        tiles("1m1z2z3z4z5z"), // seat 1 has a non-terminal/honor (1m is terminal, ok actually!)
        noten,
        noten,
      ],
    });
    // Fix: seat 1 discards must be ALL terminal/honor. 1m is
    // terminal. 1z-5z are honors. ✓
    const { state: next } = step(state, { type: "draw", seat: 0 });
    expect(next.lastHandResult?.reason).toBe("exhaustive_draw");
    expect(next.lastHandResult?.nagashi).toEqual([false, true, false, false]);
    // Non-dealer nagashi: dealer pays 4000, two other non-dealers pay 2000 each.
    const delta = next.lastHandResult?.delta;
    expect(delta?.[1]).toBe(8000);
    expect(delta?.[0]).toBe(-4000); // dealer
    expect(delta?.[2]).toBe(-2000);
    expect(delta?.[3]).toBe(-2000);
  });

  it("dealer with all-yaochuhai uncalled discards collects 12000", () => {
    const ok = tiles("1m9m1p9p1s9s1z2z3z4z5z6z7z");
    const noten = tiles("2m3m4m");
    const state = craft({
      discards: [ok, noten, noten, noten],
      dealer: 0,
    });
    const { state: next } = step(state, { type: "draw", seat: 0 });
    expect(next.lastHandResult?.nagashi).toEqual([true, false, false, false]);
    const delta = next.lastHandResult?.delta;
    expect(delta?.[0]).toBe(12000);
    expect(delta?.[1]).toBe(-4000);
    expect(delta?.[2]).toBe(-4000);
    expect(delta?.[3]).toBe(-4000);
  });

  it("disqualifies a seat whose discard was called", () => {
    const ok = tiles("1z2z3z4z");
    const calledMeld: Meld = {
      type: "pon",
      tiles: ["1z", "1z", "1z"],
      claimedTile: "1z",
      from: 1, // seat 1's tile was called by seat 2
    };
    const state = craft({
      discards: [tiles("5m"), ok, tiles("5m"), tiles("5m")],
      melds: [[], [], [calledMeld], []],
    });
    const { state: next } = step(state, { type: "draw", seat: 0 });
    expect(next.lastHandResult?.nagashi).toBeNull();
  });

  it("disqualifies a seat with any non-yaochuhai discard", () => {
    const bad = tiles("1z2z3z5m"); // 5m is simple
    const state = craft({
      discards: [tiles("5m"), bad, tiles("5m"), tiles("5m")],
    });
    const { state: next } = step(state, { type: "draw", seat: 0 });
    expect(next.lastHandResult?.nagashi).toBeNull();
  });

  it("multiple nagashi winners stack", () => {
    const ok = tiles("1z2z3z");
    const state = craft({
      discards: [ok, ok, ok, ok], // all four qualify
      dealer: 0,
    });
    const { state: next } = step(state, { type: "draw", seat: 0 });
    expect(next.lastHandResult?.nagashi).toEqual([true, true, true, true]);
    // Sum is zero (everyone "wins" the same amount → nets out).
    const delta = next.lastHandResult?.delta;
    expect(delta!.reduce((a, b) => a + b, 0)).toBe(0);
  });

  it("ruleSet.nagashiMangan = false disables the bonus", () => {
    const ok = tiles("1z2z3z4z");
    const state: MatchState = {
      ...craft({
        discards: [tiles("5m"), ok, tiles("5m"), tiles("5m")],
      }),
      ruleSet: {
        ...createInitialState(0).ruleSet,
        nagashiMangan: false,
      },
    };
    const { state: next } = step(state, { type: "draw", seat: 0 });
    expect(next.lastHandResult?.nagashi).toBeNull();
  });
});
