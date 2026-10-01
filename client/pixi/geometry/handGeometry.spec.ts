import { describe, expect, it } from "vitest";
import {
  focusedHandLongAxisOffset,
  focusedHandTileMetrics,
  focusedHandTileSpriteSpec,
} from "./handGeometry";
import { tableLayoutFromConfig } from "../tableLayout";
import { currentTableLayout } from "../layouts/currentTableLayout";
import { mobileTableLayout } from "../layouts/mobileTableLayout";
import { tenhouTileDesign } from "../tiles/designs/tenhouTileDesign";
import { BIG_TILE_H, BIG_TILE_W, TSUMO_GAP } from "./renderConstants";

describe("extracted focused hand geometry", () => {
  it("retains standard footprint and lighting-specific backs", () => {
    const layout = tableLayoutFromConfig(currentTableLayout);
    const metrics = focusedHandTileMetrics(layout, "standard");
    expect(metrics).toEqual({
      tile: layout.tileSelf,
      spriteW: BIG_TILE_W,
      spriteH: BIG_TILE_H,
    });
    expect(focusedHandTileSpriteSpec(tenhouTileDesign, null, metrics)).toEqual({
      atlasId: "bottomSmall",
      tile: null,
      width: BIG_TILE_W,
      height: BIG_TILE_H,
      anchor: 0,
    });
    expect(
      focusedHandTileSpriteSpec(tenhouTileDesign, "0m", metrics).atlasId
    ).toBe("ownHand");
  });

  it("reserves the full unmelded mobile strip independently of hand length", () => {
    const layout = tableLayoutFromConfig(mobileTableLayout);
    const metrics = focusedHandTileMetrics(layout, "mobile");
    const fullWidth = 14 * metrics.tile.w + TSUMO_GAP;
    expect(metrics.tile.gap).toBe(0);
    expect(metrics.spriteH).toBeLessThanOrEqual(layout.hands[0].h + 1e-10);
    expect(fullWidth).toBeLessThanOrEqual(layout.hands[0].w);
    expect(focusedHandLongAxisOffset(layout, "mobile", 0, 0)).toBe(
      Math.max(0, (layout.hands[0].w - fullWidth) / 2)
    );
    expect(focusedHandLongAxisOffset(layout, "mobile", 0, 1)).toBe(0);
    expect(focusedHandLongAxisOffset(layout, "mobile", 2, 0)).toBe(0);
    expect(focusedHandLongAxisOffset(layout, "standard", 0, 0)).toBe(0);
  });
});
