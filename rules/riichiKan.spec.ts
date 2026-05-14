/**
 * Ankan-during-riichi legality — unit tests for the decomposition
 * checker in `riichiKan.ts`.
 */

import { describe, expect, it } from "vitest";
import { isAnkanLegalDuringRiichi } from "./riichiKan";
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

describe("isAnkanLegalDuringRiichi", () => {
  it("forbids 1p ankan in 11122333p99m789s (kanchan reading exists)", () => {
    // The hand has two tenpai interpretations:
    //   A: 111p 22p 333p / 99m / 789s (shanpon)
    //   B: 123p 123p 13p / 99m / 789s (kanchan on 2p)
    // Reading B uses 1p in a run, so kan'ing 1p is forbidden.
    const hand = tiles("11122333p99m789s");
    expect(hand).toHaveLength(13);
    expect(isAnkanLegalDuringRiichi(hand, "1p")).toBe(false);
  });

  it("forbids 3p ankan in 11122333p99m789s (kanchan reading exists)", () => {
    const hand = tiles("11122333p99m789s");
    expect(isAnkanLegalDuringRiichi(hand, "3p")).toBe(false);
  });

  it("allows honor ankan in 111z 234m 234p 234s 5m (tanki on 5m)", () => {
    // 13 tiles: 3 east-winds + three runs + 1 tile pair-tanki.
    // No alternative reading; honors can never split.
    const hand = tiles("111z234m234p234s5m");
    expect(hand).toHaveLength(13);
    expect(isAnkanLegalDuringRiichi(hand, "1z")).toBe(true);
  });

  it("allows 9m ankan when 9m has no adjacent tiles (no alternative reading)", () => {
    // 999m + complete shapes elsewhere; wait on a separate tile.
    // Hand: 999m + 234p + 234s + 11z + 67m (waits 5m, 8m via ryanmen
    // — but for ankan-during-riichi we just need 9m to never be in a
    // run in any winning reading. 9m has only 8m,7m nearby; none in
    // the rest of the hand to form 789m, so 9m is always a triplet.
    const hand = tiles("999m234p234s11z67m");
    expect(hand).toHaveLength(13);
    expect(isAnkanLegalDuringRiichi(hand, "9m")).toBe(true);
  });

  it("forbids 7s ankan when 7s could complete a run elsewhere", () => {
    // 777s + 678s exists → reading "678s 77s ..." vs "777s ..." with
    // 8s as a tanki etc. Use 777s + 56s + complete elsewhere so
    // there's an alternative reading "567s 7s ...".
    // Hand: 777s 56s 234m 234p 234s tanki — 14 isn't right; aim for 13.
    // Hand: 777s 56s 234m 234p 11z (13 tiles). Waits: 4s/7s? 56s is
    // a ryanmen on 4s/7s. With 4 copies of 7s in our 14-tile hand
    // after drawing 7s, ankan would remove the "567s + 7s tanki"
    // reading.
    const hand = tiles("777s56s234m234p11z");
    expect(hand).toHaveLength(13);
    expect(isAnkanLegalDuringRiichi(hand, "7s")).toBe(false);
  });

  it("rejects when the hand doesn't contain exactly 3 of the kan tile", () => {
    // Only 2 of 5m present.
    const hand = tiles("55m234p234s234m11z");
    expect(isAnkanLegalDuringRiichi(hand, "5m")).toBe(false);
  });

  it("rejects when the hand is not tenpai", () => {
    // 1-shanten.
    const hand = tiles("1234m456p789s11z2z");
    expect(isAnkanLegalDuringRiichi(hand, "1m")).toBe(false);
  });
});
