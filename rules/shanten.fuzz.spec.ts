/**
 * Fuzz cross-check: our shanten implementation must agree with the
 * canonical `syanten` package on randomly-generated 13-tile hands.
 *
 * Kept in a separate spec from the main shanten tests so the
 * canonical-hand suite stays independent of the third-party package.
 */
import { describe, expect, it } from "vitest";
import syanten from "syanten";
import { createPRNG } from "./prng";
import { countsFromTiles, shanten } from "./shanten";

function randomHand(rng: ReturnType<typeof createPRNG>, size = 13): string[] {
  // Build a 136-tile wall, shuffle, take `size` from the front.
  const wall: string[] = [];
  const suits = ["m", "p", "s"] as const;
  for (const suit of suits) {
    for (let n = 1; n <= 9; n++) {
      for (let copy = 0; copy < 4; copy++) {
        wall.push(`${n}${suit}`);
      }
    }
  }
  for (let n = 1; n <= 7; n++) {
    for (let copy = 0; copy < 4; copy++) {
      wall.push(`${n}z`);
    }
  }
  rng.shuffle(wall);
  return wall.slice(0, size);
}

function toHaiArr(tiles: string[]): syanten.HaiArr {
  const hai: syanten.HaiArr = [
    [0, 0, 0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0],
  ];
  for (const t of tiles) {
    const ch = t[t.length - 1];
    const n = (t[0] === "0" ? 5 : Number(t[0])) - 1;
    const suit = ch === "m" ? 0 : ch === "p" ? 1 : ch === "s" ? 2 : 3;
    hai[suit][n]++;
  }
  return hai;
}

describe("shanten — fuzz vs syanten", () => {
  it("matches syantenAll on 1000 random 13-tile hands", () => {
    const rng = createPRNG(12345);
    const mismatches: Array<{ hand: string[]; ours: number; theirs: number }> =
      [];
    for (let i = 0; i < 1000; i++) {
      const hand = randomHand(rng);
      const ours = shanten(hand);
      const theirs = syanten.syantenAll(toHaiArr(hand));
      if (ours !== theirs) {
        mismatches.push({ hand, ours, theirs });
      }
    }
    expect(mismatches.slice(0, 5)).toEqual([]);
  });

  it("matches syantenAll on 200 random 14-tile hands (post-draw)", () => {
    const rng = createPRNG(67890);
    let bad = 0;
    let firstBad: { hand: string[]; ours: number; theirs: number } | null =
      null;
    for (let i = 0; i < 200; i++) {
      const hand = randomHand(rng, 14);
      const ours = shanten(hand);
      const theirs = syanten.syantenAll(toHaiArr(hand));
      if (ours !== theirs) {
        bad++;
        firstBad ??= { hand, ours, theirs };
      }
    }
    expect({ bad, firstBad }).toEqual({ bad: 0, firstBad: null });
  });

  it("countsFromTiles round-trips correctly via syanten encoding", () => {
    const hand = ["1m", "2m", "3m", "4p", "5p", "6p", "7s", "8s", "9s"];
    const ours = countsFromTiles(hand);
    const theirs = toHaiArr(hand);
    expect(ours.m).toEqual(theirs[0]);
    expect(ours.p).toEqual(theirs[1]);
    expect(ours.s).toEqual(theirs[2]);
    expect(ours.z).toEqual(theirs[3]);
  });
});
