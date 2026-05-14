import { describe, expect, it } from "vitest";
import {
  acceptanceTiles,
  chiitoitsuShanten,
  countsFromTiles,
  isTenpai,
  kokushiShanten,
  shanten,
  standardShanten,
  waits,
} from "./shanten";

/**
 * Helper: parse a tenhou-style string like "123m456p789s11122z" into
 * an array of tile strings. Stops at the next suit letter.
 */
function tiles(s: string): string[] {
  const out: string[] = [];
  let buf = "";
  for (const ch of s) {
    if (ch === "m" || ch === "p" || ch === "s" || ch === "z") {
      for (const n of buf) {
        out.push(`${n}${ch}`);
      }
      buf = "";
    } else {
      buf += ch;
    }
  }
  return out;
}

describe("standardShanten — winning and tenpai hands", () => {
  it("a complete winning hand has shanten -1", () => {
    // 123m 456p 789s 111z 22z (4 melds + pair)
    const h = tiles("123m456p789s111z22z");
    expect(h).toHaveLength(14);
    expect(standardShanten(countsFromTiles(h))).toBe(-1);
    expect(shanten(h)).toBe(-1);
  });

  it("13-tile tenpai hand has shanten 0", () => {
    // 123m 456p 789s 111z 2z  — drawing 2z completes the pair
    const h = tiles("123m456p789s111z2z");
    expect(h).toHaveLength(13);
    expect(standardShanten(countsFromTiles(h))).toBe(0);
    expect(isTenpai(h)).toBe(true);
  });

  it("1-shanten hand", () => {
    // 13-tile hand one swap from tenpai.
    // 1234m 456p 789s 11z 2z  — has 234m (meld), 4p,5p,6p (meld),
    //   7s,8s,9s (meld), 11z (pair), and 1m + 2z floating.
    // Swap one floater → tenpai.
    const h = tiles("1234m456p789s11z2z");
    expect(h).toHaveLength(13);
    expect(standardShanten(countsFromTiles(h))).toBe(1);
  });

  it("a hand with no structure approaches the 8 cap", () => {
    // 14 random terminals/honors with little overlap.
    const h = tiles("19m19p19s1234567z2z");
    expect(h).toHaveLength(14);
    const s = standardShanten(countsFromTiles(h));
    // Standard form is bad here — kokushi will dominate. Just check
    // standard alone returns a high non-negative number.
    expect(s).toBeGreaterThanOrEqual(2);
  });

  it("seven pairs counted as standard is worse than chiitoitsu", () => {
    const h = tiles("11223344556677m");
    // Two manzu = 14 tiles; standard form can't use sequences here
    // (each kind has 2). chiitoitsu wins.
    expect(h).toHaveLength(14);
    expect(chiitoitsuShanten(countsFromTiles(h))).toBe(-1);
    expect(shanten(h)).toBe(-1);
  });
});

describe("chiitoitsuShanten", () => {
  it("7 distinct pairs → -1", () => {
    expect(
      chiitoitsuShanten(countsFromTiles(tiles("11m22p33s44z55z66z77z")))
    ).toBe(-1);
  });

  it("6 pairs + 1 single → 0 (tenpai)", () => {
    expect(
      chiitoitsuShanten(countsFromTiles(tiles("11m22p33s44z55z66z7z")))
    ).toBe(0);
  });

  it("kinds deficit penalises chiitoitsu", () => {
    // Hand with only 5 distinct kinds but each appearing ≥2.
    // 11m 22m 33m 44m 55m 666m 7m → wait, 7m is single.
    // Use: 11m 22m 33m 44m 55m 66m 7m = 13 tiles, 6 pairs, 7 kinds.
    // For deficit: 11m 22m 33m 44m 55m (5 pairs, 5 kinds) + 1m 2m 3m
    // (3 singles overlapping kinds) — overlapping kinds means
    // distinct count stays 5, pairs stay 5: shanten = (6-5) + (7-5) = 3.
    const h = tiles("1122334455m123m");
    expect(h).toHaveLength(13);
    // pairs = 5 (1m,2m,3m,4m,5m), kinds = 5
    expect(chiitoitsuShanten(countsFromTiles(h))).toBe(6 - 5 + (7 - 5));
  });

  it("triplet counts as one pair", () => {
    // 11122m 33p 44s 55z 66z 7z = 14 tiles → pairs=6, kinds=7 → 0.
    const h = tiles("11122m33p44s55z66z7z");
    expect(h).toHaveLength(14);
    expect(chiitoitsuShanten(countsFromTiles(h))).toBe(0);
  });
});

describe("kokushiShanten", () => {
  it("complete kokushi → -1", () => {
    // 1m 9m 1p 9p 1s 9s 1z..7z + paired 1m
    const h = tiles("119m19p19s1234567z");
    expect(h).toHaveLength(14);
    expect(kokushiShanten(countsFromTiles(h))).toBe(-1);
    expect(shanten(h)).toBe(-1);
  });

  it("13-orphan tenpai → 0", () => {
    // All 13 unique orphans, no pair yet (any orphan completes).
    const h = tiles("19m19p19s1234567z");
    expect(h).toHaveLength(13);
    expect(kokushiShanten(countsFromTiles(h))).toBe(0);
  });

  it("missing two orphans, no pair → 2", () => {
    const h = tiles("1m9p1s1234567z11m");
    // 1m(2), 9p, 1s, 1z..7z = 10 distinct orphans + a pair.
    // 13 - 10 - 1 = 2.
    expect(kokushiShanten(countsFromTiles(h))).toBe(2);
  });
});

describe("shanten — combined minimum", () => {
  it("returns kokushi value when it dominates", () => {
    const h = tiles("19m19p19s1234567z");
    expect(shanten(h)).toBe(0);
  });

  it("returns chiitoitsu value when it dominates", () => {
    const h = tiles("11m22p33s44z55z66z7z");
    expect(shanten(h)).toBe(0);
  });

  it("returns standard value when it dominates", () => {
    const h = tiles("123m456p789s111z2z");
    expect(shanten(h)).toBe(0);
  });
});

describe("acceptanceTiles", () => {
  it("for a tenpai hand lists the winning tiles", () => {
    // 123m 456p 789s 111z 2z → needs 2z to complete the pair.
    const h = tiles("123m456p789s111z2z");
    const tiles_in = acceptanceTiles(h);
    expect(tiles_in).toEqual(["2z"]);
  });

  it("for a 1-shanten hand returns at least one tile", () => {
    const h = tiles("1234m456p789s11z2z");
    expect(acceptanceTiles(h).length).toBeGreaterThan(0);
  });
});

describe("waits — tenpai + kara-ten", () => {
  it("123m123p234s9999s reports shanten 0 but no wait (kara-ten on 9s)", () => {
    // 4 melds (123m, 123p, 234s, 999s) + 9s floater. The standard
    // formula reports tenpai (waiting on 9s for the pair), but all
    // four 9s are already in the hand. `acceptanceTiles` skips
    // tiles whose 4 copies are exhausted in-hand, so the wait set
    // is empty — and `waits()` propagates that.
    const h = tiles("123m123p234s9999s");
    expect(h).toHaveLength(13);
    expect(shanten(h)).toBe(0);
    expect(waits(h)).toEqual([]);
  });

  it("ordinary tenpai retains its wait", () => {
    const h = tiles("123m456p789s111z2z");
    expect(waits(h)).toEqual(["2z"]);
  });

  it("non-tenpai hand returns no waits", () => {
    const h = tiles("1234m456p789s11z2z"); // 1-shanten
    expect(waits(h)).toEqual([]);
  });
});
