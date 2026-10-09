/**
 * Wall building & dealing.
 *
 * Four-player defaults preserve the original 136-tile shuffle and deal:
 * four 13-tile hands, 70 live tiles and 14 dead tiles. The dead wall starts
 * with four replacements followed by five dora/ura pairs (first pair 4/5).
 *
 * Standard sanma starts with eight replacements followed by dora/ura
 * pairs (first pair 8/9). Online reserves 14 tiles; Kansai reserves 10.
 * Duplicate instead retains the legacy fixed 14-tile reserve for either
 * variant. Subsequent sanma reserve movement lives in wallTransitions.ts.
 *
 * Red fives substitute for ordinary fives without changing tile counts.
 * Dealing never extracts nuki tiles; the engine handles opening extraction.
 */

import type { PlayerCount, SanmaType } from "../protocol/seat";
import type { RulesFamily } from "../protocol/rulesFamily";
import { createPRNG } from "./prng";
import { SUITS, type Seat, type Tile } from "./types";
import type { SanmaWallState } from "./wallTransitions";

export type { SanmaWallState } from "./wallTransitions";

export interface WallOptions {
  /** Rules family determines the physical tile set and wall layout. */
  rulesFamily?: RulesFamily;
  /** MCR dealer receives the fourteenth opening tile. */
  dealer?: Seat;
  /** Omitted player count preserves the original four-player deal. */
  playerCount?: PlayerCount;
  /** Active only for three players; defaults to Online. */
  sanmaType?: SanmaType;
  /** Sanma Duplicate uses a fixed 14-tile reserve and personal-queue replacements. */
  duplicate?: boolean;
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
  /** Unconsumed reserve: initially 10 tiles for standard Kansai, otherwise 14. */
  deadWall: Tile[];
  /** Dora indicators currently revealed (slice: just the first). */
  doraIndicators: Tile[];
  /** Public flowers banked while normalizing the opening deal. MCR only. */
  flowerTiles?: Tile[][];
  /** Explicit replacement/indicator cursor, emitted only for three-player deals. */
  sanmaWall?: SanmaWallState;
}

export function buildAllTiles(opts: WallOptions = {}): Tile[] {
  const rulesFamily = opts.rulesFamily ?? "riichi";
  const playerCount = opts.playerCount ?? 4;
  const sanmaType = opts.sanmaType ?? "online";
  if (playerCount !== 3 && playerCount !== 4) {
    throw new Error(`A wall requires 3 or 4 players, got ${playerCount}`);
  }
  if (rulesFamily === "mcr" && playerCount !== 4) {
    throw new Error("MCR requires a four-player wall");
  }
  if (playerCount === 3 && sanmaType !== "online" && sanmaType !== "kansai") {
    throw new Error(`Unknown sanma wall variant: ${sanmaType}`);
  }
  const tiles: Tile[] = [];
  const redCounts = opts.redFives ?? {};
  for (const suit of SUITS) {
    const redCount =
      rulesFamily === "mcr"
        ? 0
        : Math.max(0, Math.min(4, redCounts[suit] ?? 0));
    for (let n = 1; n <= 9; n++) {
      if (
        playerCount === 3 &&
        suit === "m" &&
        n !== 1 &&
        n !== 9 &&
        !(sanmaType === "kansai" && n === 5)
      ) {
        continue;
      }
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
  if (rulesFamily === "mcr") {
    for (let n = 1; n <= 8; n++) {
      tiles.push(`${n}f`);
    }
  }
  return tiles;
}

export function dealMatch(seed: number, opts: WallOptions = {}): DealtMatch {
  const rulesFamily = opts.rulesFamily ?? "riichi";
  const prng = createPRNG(seed);
  const tiles = prng.shuffle(buildAllTiles(opts));
  const playerCount = opts.playerCount ?? 4;
  const sanmaType = opts.sanmaType ?? "online";
  const standardSanma = playerCount === 3 && !opts.duplicate;
  const reserveSize =
    rulesFamily === "mcr"
      ? 0
      : standardSanma && sanmaType === "kansai"
        ? 10
        : 14;

  const hands: Tile[][] = [];
  let cursor = 0;
  for (let seat = 0; seat < playerCount; seat++) {
    const handSize =
      rulesFamily === "mcr" && seat === (opts.dealer ?? 0) ? 14 : 13;
    hands.push(tiles.slice(cursor, cursor + handSize));
    cursor += handSize;
  }
  const liveWall = tiles.slice(
    cursor,
    reserveSize === 0 ? undefined : tiles.length - reserveSize
  );
  const deadWall = tiles.slice(tiles.length - reserveSize);
  const doraIndicators =
    rulesFamily === "mcr" ? [] : [deadWall[standardSanma ? 8 : 4]];

  if (rulesFamily === "mcr") {
    const flowerTiles = Array.from({ length: playerCount }, () => [] as Tile[]);
    const dealer = opts.dealer ?? 0;
    for (let offset = 0; offset < playerCount; offset++) {
      const seat = (dealer + offset) % playerCount;
      let flowerIndex = hands[seat].findIndex((tile) => tile.endsWith("f"));
      while (flowerIndex >= 0) {
        const [flower] = hands[seat].splice(flowerIndex, 1);
        flowerTiles[seat].push(flower);
        const replacement = liveWall.pop();
        if (replacement === undefined) {
          throw new Error("MCR opening flower replacement exhausted the wall");
        }
        hands[seat].push(replacement);
        flowerIndex = hands[seat].findIndex((tile) => tile.endsWith("f"));
      }
    }
    return {
      hands,
      liveWall,
      deadWall: [],
      doraIndicators: [],
      flowerTiles,
    };
  }

  const dealt: DealtMatch = { hands, liveWall, deadWall, doraIndicators };
  if (playerCount === 3) {
    dealt.sanmaWall = {
      sanmaType,
      mode: opts.duplicate ? "duplicate" : "standard",
      replacementsTaken: 0,
      kanCount: 0,
    };
  }
  return dealt;
}
