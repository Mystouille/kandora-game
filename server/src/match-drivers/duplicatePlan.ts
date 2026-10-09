import { type SeatValues } from "~/game/protocol/seat";
import type { DuplicateMatchModeConfig } from "~/game/protocol/matchMode";
import { hashStringToSeed } from "~/game/rules/prng";
import {
  dealMatch,
  type DealtMatch,
  type WallOptions,
} from "~/game/rules/wall";
import type { Seat, Tile, Wind } from "~/game/rules/types";
import { seatValues } from "~/game/rules/seats";

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
  drawQueues: SeatValues<Tile[]>;
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
  key: DuplicateHandKey,
  wallOptions: WallOptions = {}
): number {
  const legacyParts: readonly (string | number)[] = [
    "kandora-duplicate-hand",
    mode.generationVersion,
    mode.seed,
    presetId,
    key.gameIndex,
    key.roundWind,
    key.roundNumber,
    key.honba,
    ...(wallOptions.playerCount === 3
      ? ["sanma", wallOptions.sanmaType ?? "online"]
      : []),
  ];
  return domainSeed(
    mode.generationVersion === 1
      ? legacyParts
      : [...legacyParts, wallOptions.rulesFamily ?? "riichi"]
  );
}

export function generateDuplicateHandPlan(
  mode: DuplicateMatchModeConfig,
  presetId: string,
  key: DuplicateHandKey,
  wallOptions: WallOptions
): DuplicateHandPlan {
  const playerCount = wallOptions.playerCount ?? 4;
  const deal = dealMatch(duplicateHandSeed(mode, presetId, key, wallOptions), {
    ...wallOptions,
    dealer: key.dealer,
    duplicate: true,
  });
  const drawQueues = seatValues<Tile[]>(playerCount, () => []);
  const firstDrawSeat =
    wallOptions.rulesFamily === "mcr"
      ? (key.dealer + 1) % playerCount
      : key.dealer;

  deal.liveWall.forEach((tile, index) => {
    const seat = ((firstDrawSeat + index) % playerCount) as Seat;
    drawQueues[seat].push(tile);
  });

  return {
    key: { ...key },
    deal,
    drawQueues,
  };
}
