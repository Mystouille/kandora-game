import type { Rect } from "../tableLayout";
import { tableLayoutFromConfig } from "../tableLayout";
import type { Seat } from "../tableGeometry";
import type { TileDesign } from "../tiles/tileDesign";
import type { TableRendererPresentation } from "../scene/renderTypes";
import { ACTIVE_TILE_DESIGN } from "../tiles/activeTileDesign";
import {
  mobileDiscardLayoutOptions,
  mobileTableLayout,
} from "../layouts/mobileTableLayout";
import { discardCellSize, type DiscardLayoutOptions } from "../tileAreaLayout";

export interface RiichiStickMetrics {
  width: number;
  height: number;
  gap: number;
  dotRadius: number;
  cornerRadius: number;
}

const WEB_RIICHI_STICK_SCALE = 1.35;

const DEFAULT_MOBILE_LAYOUT = tableLayoutFromConfig(mobileTableLayout);

export const WEB_RIICHI_STICK: RiichiStickMetrics = {
  width: discardCellSize(ACTIVE_TILE_DESIGN, 0).w * 3,
  height: 8 * WEB_RIICHI_STICK_SCALE,
  gap: 10 * WEB_RIICHI_STICK_SCALE,
  dotRadius: 2.5 * WEB_RIICHI_STICK_SCALE,
  cornerRadius: 3 * WEB_RIICHI_STICK_SCALE,
};

export const MOBILE_RIICHI_STICK: RiichiStickMetrics = {
  width:
    discardCellSize(
      ACTIVE_TILE_DESIGN,
      0,
      mobileDiscardLayoutOptions(ACTIVE_TILE_DESIGN, DEFAULT_MOBILE_LAYOUT)
    ).w * 3,
  height: 12,
  gap: 1,
  dotRadius: 3.5,
  cornerRadius: 3,
};

export function riichiStickMetrics(
  presentation: TableRendererPresentation,
  design: TileDesign,
  options?: DiscardLayoutOptions
): RiichiStickMetrics {
  const profile =
    presentation === "mobile" ? MOBILE_RIICHI_STICK : WEB_RIICHI_STICK;
  return {
    ...profile,
    width: discardCellSize(design, 0, options).w * 3,
  };
}

export interface RiichiStickPlacement {
  x: number;
  y: number;
  rotation: number;
  bounds: Rect;
}

export function mobileRiichiStickPlacement(
  discardPanel: Rect,
  center: Rect,
  seat: Seat,
  metrics: RiichiStickMetrics
): RiichiStickPlacement {
  const { width, height, gap } = metrics;
  const centerX = center.x + center.w / 2;
  const centerY = center.y + center.h / 2;
  switch (seat) {
    case 0:
      return {
        x: centerX - width / 2,
        y: discardPanel.y - gap - height,
        rotation: 0,
        bounds: {
          x: centerX - width / 2,
          y: discardPanel.y - gap - height,
          w: width,
          h: height,
        },
      };
    case 1:
      return {
        x: discardPanel.x - gap - height,
        y: centerY + width / 2,
        rotation: -Math.PI / 2,
        bounds: {
          x: discardPanel.x - gap - height,
          y: centerY - width / 2,
          w: height,
          h: width,
        },
      };
    case 2:
      return {
        x: centerX + width / 2,
        y: discardPanel.y + discardPanel.h + gap + height,
        rotation: Math.PI,
        bounds: {
          x: centerX - width / 2,
          y: discardPanel.y + discardPanel.h + gap,
          w: width,
          h: height,
        },
      };
    case 3:
      return {
        x: discardPanel.x + discardPanel.w + gap + height,
        y: centerY - width / 2,
        rotation: Math.PI / 2,
        bounds: {
          x: discardPanel.x + discardPanel.w + gap,
          y: centerY - width / 2,
          w: height,
          h: width,
        },
      };
  }
}
