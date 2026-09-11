import type { Seat } from "../tableGeometry";

export type WallTileKind = "live" | "dead";
export type WallTileTone = "normal" | "future-draw" | "deemphasized";

export interface WallTilePlan {
  seat: Seat;
  /** Stack index inside this tile's own live/dead section. */
  stackIndex: number;
  /** Slot inside the complete seat-band group, including intentional gaps. */
  groupSlotIndex: number;
  row: 0 | 1;
  kind: WallTileKind;
  /** Index into the matching personal queue or dead wall. */
  sourceIndex: number;
  x: number;
  y: number;
  width: number;
  height: number;
  zIndex: number;
  faceUpTile: string | null;
  tone: WallTileTone;
  castsShadow: boolean;
}

export interface WallRenderPlan {
  tiles: WallTilePlan[];
}