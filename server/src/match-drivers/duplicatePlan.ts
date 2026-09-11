import type { DuplicateMatchModeConfig } from "~/game/protocol/matchMode";
import { hashStringToSeed } from "~/game/rules/prng";
import {
  dealMatch,
  type DealtMatch,
  type WallOptions,
} from "~/game/rules/wall";
import type { Seat, Tile, Wind } from "~/game/rules/types";

export interface DuplicateHandKey {
  gameIndex: number;
  roundWind: Wind;
  roundNumber: number;
  honba: number;
  dealer: Seat;
}

export interface DuplicateHandPlan {
  key: DuplicateHandKey;
  deal: DealtMatch;
  drawQueues: [Tile[], Tile[], Tile[], Tile[]];
}

function domainSeed(parts: readonly (string | number)[]): number {
  return hashStringToSeed(JSON.stringify(parts));
}

export function duplicateMatchSeed(mode: DuplicateMatchModeConfig): number {
  return domainSeed([
    "kandora-duplicate-match",
    mode.generationVersion,
    mode.seed,
  ]);
}

export function duplicateHandSeed(
  mode: DuplicateMatchModeConfig,
  presetId: string,
  key: DuplicateHandKey
): number {
  return domainSeed([
    "kandora-duplicate-hand",
    mode.generationVersion,
    mode.seed,
    presetId,
    key.gameIndex,
    key.roundWind,
    key.roundNumber,
    key.honba,
  ]);
}

export function generateDuplicateHandPlan(
  mode: DuplicateMatchModeConfig,
  presetId: string,
  key: DuplicateHandKey,
  wallOptions: WallOptions
): DuplicateHandPlan {
  const deal = dealMatch(duplicateHandSeed(mode, presetId, key), wallOptions);
  const drawQueues: [Tile[], Tile[], Tile[], Tile[]] = [[], [], [], []];

  deal.liveWall.forEach((tile, index) => {
    const seat = ((key.dealer + index) % 4) as Seat;
    drawQueues[seat].push(tile);
  });

  return {
    key: { ...key },
    deal,
    drawQueues,
  };
}