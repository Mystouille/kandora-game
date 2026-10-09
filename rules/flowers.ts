import type { Tile } from "./types";

export const MCR_FLOWER_TILES = [
  "1f",
  "2f",
  "3f",
  "4f",
  "5f",
  "6f",
  "7f",
  "8f",
] as const satisfies readonly Tile[];

export type FlowerTile = (typeof MCR_FLOWER_TILES)[number];

export const MCR_FLOWER_NAMES: Record<FlowerTile, string> = {
  "1f": "Spring",
  "2f": "Summer",
  "3f": "Autumn",
  "4f": "Winter",
  "5f": "Plum",
  "6f": "Orchid",
  "7f": "Bamboo",
  "8f": "Chrysanthemum",
};

export function isFlowerTile(tile: Tile): tile is FlowerTile {
  return Object.hasOwn(MCR_FLOWER_NAMES, tile);
}

export function flowerTileName(tile: Tile): string | null {
  return isFlowerTile(tile) ? MCR_FLOWER_NAMES[tile] : null;
}
