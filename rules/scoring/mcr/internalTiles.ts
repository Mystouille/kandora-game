/*
 * Derived from summerinsects/mahjong-algorithm at
 * 44a178af08bf11f82a8993fddbe2fe8876ddd8f3 and the SkyEye_FAST Kotlin port at
 * 7d772b66adcf0e8316123f66b350c5cb9d71a7ca. MIT licensed; see
 * THIRD_PARTY_NOTICES.md.
 */
import type { Tile } from "~/core/mahjong/rules/types";
import type { McrMeldInput } from "./types";

export const TABLE_SIZE = 0x48;
export const CHOW = 1;
export const PUNG = 2;
export const KONG = 3;
export const PAIR = 4;

export const ALL_TILES = [
  ...Array.from({ length: 9 }, (_, index) => 0x11 + index),
  ...Array.from({ length: 9 }, (_, index) => 0x21 + index),
  ...Array.from({ length: 9 }, (_, index) => 0x31 + index),
  ...Array.from({ length: 7 }, (_, index) => 0x41 + index),
] as const;

export const ORPHANS = [
  0x11, 0x19, 0x21, 0x29, 0x31, 0x39, 0x41, 0x42, 0x43, 0x44, 0x45, 0x46,
  0x47,
] as const;

export const KNITTED = [
  [0x11, 0x14, 0x17, 0x22, 0x25, 0x28, 0x33, 0x36, 0x39],
  [0x11, 0x14, 0x17, 0x23, 0x26, 0x29, 0x32, 0x35, 0x38],
  [0x12, 0x15, 0x18, 0x21, 0x24, 0x27, 0x33, 0x36, 0x39],
  [0x12, 0x15, 0x18, 0x23, 0x26, 0x29, 0x31, 0x34, 0x37],
  [0x13, 0x16, 0x19, 0x21, 0x24, 0x27, 0x32, 0x35, 0x38],
  [0x13, 0x16, 0x19, 0x22, 0x25, 0x28, 0x31, 0x34, 0x37],
] as const;

const GREEN_TILES = new Set([0x22, 0x23, 0x24, 0x26, 0x28, 0x46]);
const REVERSIBLE_TILES = new Set([
  0x22, 0x24, 0x25, 0x26, 0x28, 0x29, 0x31, 0x32, 0x33, 0x34, 0x35, 0x38,
  0x39, 0x47,
]);

export function rank(tile: number): number {
  return tile & 15;
}

export function suit(tile: number): number {
  return (tile >> 4) & 15;
}

export function isNumbered(tile: number): boolean {
  return (
    (tile >= 0x11 && tile <= 0x19) ||
    (tile >= 0x21 && tile <= 0x29) ||
    (tile >= 0x31 && tile <= 0x39)
  );
}

export function isHonor(tile: number): boolean {
  return tile >= 0x41 && tile <= 0x47;
}

export function isWind(tile: number): boolean {
  return tile >= 0x41 && tile <= 0x44;
}

export function isDragon(tile: number): boolean {
  return tile >= 0x45 && tile <= 0x47;
}

export function isTerminal(tile: number): boolean {
  return (tile & 0xc7) === 1;
}

export function isTerminalOrHonor(tile: number): boolean {
  return isTerminal(tile) || isHonor(tile);
}

export function isGreen(tile: number): boolean {
  return GREEN_TILES.has(tile);
}

export function isReversible(tile: number): boolean {
  return REVERSIBLE_TILES.has(tile);
}

export function sameSuit(first: number, second: number): boolean {
  return (first & 0xf0) === (second & 0xf0);
}

export function sameRank(first: number, second: number): boolean {
  return (first & 0xcf) === (second & 0xcf);
}

export function pack(offer: number, type: number, tile: number): number {
  return (offer << 12) | (type << 8) | tile;
}

export function packType(value: number): number {
  return (value >> 8) & 15;
}

export function packTile(value: number): number {
  return value & 255;
}

export function isMelded(value: number): boolean {
  return (value & 0x3000) !== 0;
}

export function eigen(first: number, second: number, third: number): number {
  return (first << 16) | (second << 8) | third;
}

export function mapTiles(tiles: readonly number[]): Int32Array {
  const table = new Int32Array(TABLE_SIZE);
  for (const tile of tiles) {
    table[tile]++;
  }
  return table;
}

export function mapPacks(packs: readonly number[]): Int32Array {
  const table = new Int32Array(TABLE_SIZE);
  for (const value of packs) {
    const tile = packTile(value);
    if (packType(value) === CHOW) {
      table[tile - 1]++;
      table[tile]++;
      table[tile + 1]++;
    } else if (packType(value) === PUNG) {
      table[tile] += 3;
    } else if (packType(value) === KONG) {
      table[tile] += 4;
    } else if (packType(value) === PAIR) {
      table[tile] += 2;
    } else {
      throw new Error("Invalid internal MCR pack");
    }
  }
  return table;
}

export function tileCode(tile: Tile): number {
  const match = /^([0-9])([mpsz])$/.exec(tile);
  if (!match) {
    throw new Error(`Invalid Kandora tile: ${tile}`);
  }
  let tileRank = Number(match[1]);
  const tileSuit = match[2];
  if (tileRank === 0 && tileSuit !== "z") {
    tileRank = 5;
  }
  if (tileSuit === "z") {
    if (tileRank < 1 || tileRank > 7) {
      throw new Error(`Invalid honor tile: ${tile}`);
    }
    return 0x40 + tileRank;
  }
  if (tileRank < 1 || tileRank > 9) {
    throw new Error(`Invalid suited tile: ${tile}`);
  }
  const suitCode = tileSuit === "m" ? 1 : tileSuit === "s" ? 2 : 3;
  return (suitCode << 4) | tileRank;
}

function ensureSameTiles(tiles: readonly number[], meld: McrMeldInput): number {
  if (tiles.some((tile) => tile !== tiles[0])) {
    throw new Error(`${meld.type} tiles must all match`);
  }
  return tiles[0];
}

export function packMeld(meld: McrMeldInput): number {
  const tiles = meld.tiles.map(tileCode).sort((first, second) => first - second);
  if (meld.type === "chi") {
    if (
      tiles.length !== 3 ||
      !isNumbered(tiles[0]) ||
      !sameSuit(tiles[0], tiles[2]) ||
      tiles[1] !== tiles[0] + 1 ||
      tiles[2] !== tiles[1] + 1
    ) {
      throw new Error("A chi must contain three consecutive suited tiles");
    }
    return pack(1, CHOW, tiles[1]);
  }
  if (meld.type === "pon") {
    if (tiles.length !== 3) {
      throw new Error("A pon must contain three tiles");
    }
    return pack(1, PUNG, ensureSameTiles(tiles, meld));
  }
  if (tiles.length !== 4) {
    throw new Error("A kong must contain four tiles");
  }
  return pack(
    meld.type === "ankan" ? 0 : 1,
    KONG,
    ensureSameTiles(tiles, meld)
  );
}

export function physicalCounts(
  hand: readonly Tile[],
  melds: readonly McrMeldInput[],
  winTile: Tile
): Int32Array {
  const counts = new Int32Array(TABLE_SIZE);
  for (const tile of hand) {
    counts[tileCode(tile)]++;
  }
  for (const meld of melds) {
    for (const tile of meld.tiles) {
      counts[tileCode(tile)]++;
    }
  }
  counts[tileCode(winTile)]++;
  return counts;
}

