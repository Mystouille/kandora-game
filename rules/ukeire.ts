import {
  countsFromTiles,
  standardShanten,
  type HandCounts,
} from "./shanten";
import type { Tile } from "./types";

export interface UkeireDraw {
  tile: Tile;
  remaining: number;
}

export interface UkeireDiscard {
  tile: Tile;
  draws: UkeireDraw[];
  total: number;
}

export interface StandardUkeireAnalysis {
  shanten: number;
  draws: UkeireDraw[];
  discards: UkeireDiscard[];
}

const suits = ["m", "p", "s", "z"] as const;

function cloneCounts(counts: HandCounts): HandCounts {
  return {
    m: [...counts.m],
    p: [...counts.p],
    s: [...counts.s],
    z: [...counts.z],
  };
}

function tileCount(counts: HandCounts): number {
  return suits.reduce(
    (total, suit) =>
      total + counts[suit].reduce((sum, count) => sum + count, 0),
    0
  );
}

function improvingDraws(
  counts: HandCounts,
  baseline: number,
  meldCount: number,
  discarded?: { suit: (typeof suits)[number]; index: number }
): UkeireDraw[] {
  const draws: UkeireDraw[] = [];
  for (const suit of suits) {
    for (let index = 0; index < counts[suit].length; index++) {
      if (discarded?.suit === suit && discarded.index === index) {
        continue;
      }
      const count = counts[suit][index];
      if (count >= 4 || (suit === "z" && count === 0)) {
        continue;
      }
      counts[suit][index]++;
      const improves = standardShanten(counts, meldCount) < baseline;
      counts[suit][index]--;
      if (improves) {
        draws.push({
          tile: `${index + 1}${suit}`,
          remaining: 4 - count,
        });
      }
    }
  }
  return draws;
}

/**
 * Analyze standard-form ukeire with the same discard filtering and remaining
 * tile counts as the npm `syanten.hairi()` function.
 */
export function analyzeStandardUkeire(
  input: readonly Tile[] | HandCounts,
  meldCount = 0
): StandardUkeireAnalysis {
  const counts = Array.isArray(input)
    ? countsFromTiles(input as readonly Tile[])
    : cloneCounts(input as HandCounts);
  const currentShanten = standardShanten(counts, meldCount);
  const analysis: StandardUkeireAnalysis = {
    shanten: currentShanten,
    draws: [],
    discards: [],
  };
  if (currentShanten < 0) {
    return analysis;
  }

  if (tileCount(counts) % 3 === 1) {
    analysis.draws = improvingDraws(counts, currentShanten, meldCount);
    return analysis;
  }

  for (const suit of suits) {
    for (let index = 0; index < counts[suit].length; index++) {
      if (counts[suit][index] === 0) {
        continue;
      }
      counts[suit][index]--;
      if (standardShanten(counts, meldCount) === currentShanten) {
        const draws = improvingDraws(counts, currentShanten, meldCount, {
          suit,
          index,
        });
        analysis.discards.push({
          tile: `${index + 1}${suit}`,
          draws,
          total: draws.reduce((total, draw) => total + draw.remaining, 0),
        });
      }
      counts[suit][index]++;
    }
  }
  return analysis;
}