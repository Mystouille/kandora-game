import type { TableLayout, TileDims } from "../tableLayout";
import type { TableRendererPresentation } from "../scene/renderTypes";
import type { TileDesign } from "../tiles/tileDesign";
import type { TileSpriteSpec } from "../tiles/tileSpriteFactory";
import {
  BIG_TILE_H,
  BIG_TILE_SRC,
  BIG_TILE_W,
  TSUMO_GAP,
} from "./renderConstants";

export interface FocusedHandTileMetrics {
  tile: TileDims;
  spriteW: number;
  spriteH: number;
}

export function focusedHandTileMetrics(
  layout: TableLayout,
  presentation: TableRendererPresentation
): FocusedHandTileMetrics {
  if (presentation === "standard") {
    return {
      tile: layout.tileSelf,
      spriteW: BIG_TILE_W,
      spriteH: BIG_TILE_H,
    };
  }
  const widthForFourteenTiles = (layout.hands[0].w - TSUMO_GAP) / 14;
  const widthAtHeightCap =
    layout.hands[0].h * (BIG_TILE_SRC.w / BIG_TILE_SRC.h);
  const spriteW = Math.min(widthForFourteenTiles, widthAtHeightCap);
  const spriteH = spriteW * (BIG_TILE_SRC.h / BIG_TILE_SRC.w);
  return {
    tile: { w: spriteW, h: spriteH, gap: 0 },
    spriteW,
    spriteH,
  };
}

export function focusedHandTileSpriteSpec(
  tileDesign: TileDesign,
  tile: string | null,
  metrics: FocusedHandTileMetrics
): TileSpriteSpec {
  return {
    atlasId:
      tile === null ? tileDesign.sheets.ownHandBack : tileDesign.sheets.ownHand,
    tile,
    width: metrics.spriteW,
    height: metrics.spriteH,
    anchor: 0,
  };
}

export function focusedHandLongAxisOffset(
  layout: TableLayout,
  presentation: TableRendererPresentation,
  seat: number,
  meldCount: number
): number {
  if (presentation !== "mobile" || seat !== 0 || meldCount > 0) {
    return 0;
  }
  const metrics = focusedHandTileMetrics(layout, presentation);
  const fullHandWidth =
    14 * (metrics.tile.w + metrics.tile.gap) - metrics.tile.gap + TSUMO_GAP;
  return Math.max(0, (layout.hands[0].w - fullHandWidth) / 2);
}
