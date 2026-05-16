/**
 * Wall building & dealing.
 *
 * Riichi convention:
 *   - 136 tiles total: 4 of each of 34 tile types. Red fives are an
 *     optional cosmetic substitution and live on the wire as `0m/0p/0s`;
 *     the rules engine treats them as 5s for shanten/yaku purposes.
 *   - Dead wall: 14 tiles set aside at the back of the wall.
 *       indices 0-3:  rinshan (kan replacement draws)
 *       indices 4,6,8,10,12: dora indicators (revealed progressively)
 *       indices 5,7,9,11,13: ura indicators (revealed at win for riichi)
 *     Slice convention used here matches the server: `deadWall[4]` is
 *     the first revealed dora indicator.
 *   - Live wall: everything between the dealt hands and the dead wall.
 *     For the standard 4×13-tile deal that's `136 - 52 - 14 = 70` tiles.
 *
 * Phase 1 step 1 keeps the slice's "no red fives" build. Red-five
 * substitution is a configurable wall option that lands when scoring
 * cares about it (Phase 1 step 4).
 */

import { createPRNG } from "./prng";
import { SUITS, type Seat, type Tile } from "./types";

export interface WallOptions {
  /**
   * Number of red-five substitutions per numbered suit (0–4).
   * Each entry replaces that many of the four "5X" copies with a
   * red five (`0X`). Omitted entries default to 0.
   */
  redFives?: { m?: number; p?: number; s?: number };
}

export interface DealtMatch {
  /** Initial 13-tile hands per seat. */
  hands: Tile[][];
  /** Drawable wall (front of array = next draw). */
  liveWall: Tile[];
  /** 14-tile dead wall, layout described above. */
  deadWall: Tile[];
  /** Dora indicators currently revealed (slice: just the first). */
  doraIndicators: Tile[];
}

export function buildAllTiles(opts: WallOptions = {}): Tile[] {
  const tiles: Tile[] = [];
  const redCounts = opts.redFives ?? {};
  for (const suit of SUITS) {
    const redCount = Math.max(0, Math.min(4, redCounts[suit] ?? 0));
    for (let n = 1; n <= 9; n++) {
      for (let copy = 0; copy < 4; copy++) {
        // Replace the first `redCount` copies of "5" in this suit
        // with a red five (`0X`).
        const isRedSlot = n === 5 && copy < redCount;
        tiles.push(`${isRedSlot ? 0 : n}${suit}`);
      }
    }
  }
  for (let n = 1; n <= 7; n++) {
    for (let copy = 0; copy < 4; copy++) {
      tiles.push(`${n}z`);
    }
  }
  return tiles;
}

export function dealMatch(seed: number, opts: WallOptions = {}): DealtMatch {
  const prng = createPRNG(seed);
  const tiles = prng.shuffle(buildAllTiles(opts));

  const hands: Tile[][] = [[], [], [], []];
  let cursor = 0;
  for (let s: Seat = 0; s < 4; s = ((s + 1) | 0) as Seat) {
    hands[s] = tiles.slice(cursor, cursor + 13);
    cursor += 13;
  }
  const liveWall = tiles.slice(cursor, tiles.length - 14);
  const deadWall = tiles.slice(tiles.length - 14);
  const doraIndicators = [deadWall[4]];

  return { hands, liveWall, deadWall, doraIndicators };
}
