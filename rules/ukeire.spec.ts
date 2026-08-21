import { describe, expect, it } from "vitest";
import syanten from "syanten";
import { countsFromTiles } from "./shanten";
import { analyzeStandardUkeire } from "./ukeire";
import type { Tile } from "./types";

type TileMatrix = syanten.HaiArr;

function toMatrix(tiles: readonly Tile[]): TileMatrix {
  const matrix: TileMatrix = [
    [0, 0, 0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0],
  ];
  for (const tile of tiles) {
    const suit = "mpsz".indexOf(tile[tile.length - 1]);
    const number = tile[0] === "0" ? 5 : Number(tile[0]);
    matrix[suit][number - 1]++;
  }
  return matrix;
}

function toLegacyHairi(tiles: readonly Tile[]) {
  const analysis = analyzeStandardUkeire(tiles);
  const result: Record<string, number | Record<string, number>> = {
    now: analysis.shanten,
  };
  if (tiles.length % 3 === 1) {
    result.wait = Object.fromEntries(
      analysis.draws.map((draw) => [draw.tile, draw.remaining])
    );
    return result;
  }
  for (const discard of analysis.discards) {
    result[discard.tile] = Object.fromEntries(
      discard.draws.map((draw) => [draw.tile, draw.remaining])
    );
  }
  return result;
}

function createRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function randomHand(rng: () => number, size: number): Tile[] {
  const wall: Tile[] = [];
  for (const suit of ["m", "p", "s"] as const) {
    for (let number = 1; number <= 9; number++) {
      for (let copy = 0; copy < 4; copy++) {
        wall.push(`${number}${suit}`);
      }
    }
  }
  for (let number = 1; number <= 7; number++) {
    for (let copy = 0; copy < 4; copy++) {
      wall.push(`${number}z`);
    }
  }
  for (let index = wall.length - 1; index > 0; index--) {
    const swapIndex = Math.floor(rng() * (index + 1));
    [wall[index], wall[swapIndex]] = [wall[swapIndex], wall[index]];
  }
  return wall.slice(0, size);
}

describe("analyzeStandardUkeire", () => {
  it("matches npm hairi for deterministic 13- and 14-tile hands", () => {
    const rng = createRng(20260821);
    for (const size of [13, 14]) {
      for (let index = 0; index < 10; index++) {
        const hand = randomHand(rng, size);
        expect(toLegacyHairi(hand)).toEqual(syanten.hairi(toMatrix(hand)));
      }
    }
  });

  it("reports remaining copies for a tenpai draw", () => {
    const hand = [
      "1m",
      "2m",
      "3m",
      "4p",
      "5p",
      "6p",
      "7s",
      "8s",
      "9s",
      "1z",
      "1z",
      "1z",
      "2z",
    ];

    expect(analyzeStandardUkeire(hand).draws).toEqual([
      { tile: "2z", remaining: 3 },
    ]);
  });

  it("supports concealed tiles with declared melds", () => {
    const hand = ["1m", "2m", "3m", "4p", "5p", "6p", "7s", "8s", "1z", "1z"];
    const analysis = analyzeStandardUkeire(countsFromTiles(hand), 1);

    expect(analysis.shanten).toBe(0);
    expect(analysis.draws).toEqual([
      { tile: "6s", remaining: 4 },
      { tile: "9s", remaining: 4 },
    ]);
  });
});