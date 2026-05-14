/**
 * Cross-checks `standardShanten` against the test fixture shipped with
 * the `syanten` npm package (1001 hands), ported into a JSON file.
 *
 * Source format (per row, length 15):
 *   - indices 0..13 : 14 tile codes in 0..33
 *       * 0..8   = 1m..9m
 *       * 9..17  = 1p..9p
 *       * 18..26 = 1s..9s
 *       * 27..33 = 1z..7z
 *   - index 14      : expected standard-form shanten (the value
 *                     returned by `syanten.syanten` — NOT
 *                     `syantenAll`, so kokushi / chiitoitsu are
 *                     deliberately ignored). `-1` means the hand is
 *                     already winning.
 *
 * The fixture is generated from `node_modules/syanten/test.js`
 * (the `arr` literal). See repo notes for regeneration steps.
 */

import { describe, expect, it } from "vitest";
import type { Tile } from "./types";
import { countsFromTiles, standardShanten } from "./shanten";
import cases from "./shanten.syanten-cases.json";

function codeToTile(c: number): Tile {
  if (c < 27) {
    const suit = ["m", "p", "s"][Math.floor(c / 9)];
    const n = (c % 9) + 1;
    return `${n}${suit}` as Tile;
  }
  return `${c - 26}z` as Tile;
}

const ROWS = cases as number[][];

describe("shanten — syanten library fixture (1001 hands)", () => {
  it("fixture is well-formed", () => {
    expect(ROWS.length).toBe(1001);
    for (const row of ROWS) {
      expect(row.length).toBe(15);
      for (let i = 0; i < 14; i++) {
        expect(row[i]).toBeGreaterThanOrEqual(0);
        expect(row[i]).toBeLessThanOrEqual(33);
      }
    }
  });

  it("standardShanten matches syanten library expectation for every case", () => {
    const mismatches: Array<{
      idx: number;
      tiles: string[];
      expected: number;
      got: number;
    }> = [];

    for (let i = 0; i < ROWS.length; i++) {
      const row = ROWS[i];
      const tiles = row.slice(0, 14).map(codeToTile);
      const expected = row[14];
      const got = standardShanten(countsFromTiles(tiles));
      if (got !== expected) {
        mismatches.push({ idx: i, tiles, expected, got });
      }
    }

    if (mismatches.length > 0) {
      // Surface the first few for fast triage.
      const preview = mismatches.slice(0, 5);
      throw new Error(
        `${mismatches.length}/${ROWS.length} mismatches. First few:\n` +
          preview
            .map(
              (m) =>
                `  #${m.idx} ${m.tiles.join(" ")} → expected ${m.expected}, got ${m.got}`
            )
            .join("\n")
      );
    }

    expect(mismatches.length).toBe(0);
  });
});
