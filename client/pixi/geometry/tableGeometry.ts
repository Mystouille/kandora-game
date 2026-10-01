import type { TableLayout, Rect } from "../tableLayout";
import type { Seat } from "../tableGeometry";
import type {
  TableRendererPresentation,
  TsumogiriTintMode,
} from "../scene/renderTypes";
import type { WebTableLayoutMode } from "../layouts/webTableLayout";
import {
  CALL_EFFECT_GAP_FRACTION,
  DISCARD_LAYER_BASE_Z,
  PLAYER_PANEL_GAP,
  PLAYER_PANEL_SIZE,
  TSUMOGIRI_FRESH_WINDOW,
} from "./renderConstants";

export interface TableRenderPolicy {
  indicatorCenter: boolean;
  perimeterWalls: boolean;
}

export function tableRenderPolicy(
  presentation: TableRendererPresentation,
  webLayoutMode: WebTableLayoutMode
): TableRenderPolicy {
  if (presentation === "mobile" || webLayoutMode === "compact") {
    return { indicatorCenter: true, perimeterWalls: false };
  }
  return { indicatorCenter: false, perimeterWalls: true };
}

export function shouldTintTsumogiri(
  wasTsumogiri: boolean,
  mode: TsumogiriTintMode,
  discardAge: number
): boolean {
  if (!wasTsumogiri || mode === "none") {
    return false;
  }
  return mode === "all" || discardAge < TSUMOGIRI_FRESH_WINDOW;
}

export function wallZIndex(seat: number): number {
  return seat === 0 ? 2 : seat === 2 ? 0 : 1;
}

export function discardContainerZIndex(seat: Seat): number {
  if (seat === 2) {
    return DISCARD_LAYER_BASE_Z;
  }
  if (seat === 1) {
    return DISCARD_LAYER_BASE_Z + 1;
  }
  if (seat === 3) {
    return DISCARD_LAYER_BASE_Z + 2;
  }
  return DISCARD_LAYER_BASE_Z + 3;
}

export type SeatRects = readonly [Rect, Rect, Rect, Rect];

export function playerIdentityCenter(
  discardPanels: SeatRects,
  seat: Seat
): { x: number; y: number } {
  const discardPanel = discardPanels[seat];
  let center: { x: number; y: number };
  if (seat === 0) {
    center = {
      x:
        discardPanel.x +
        discardPanel.w +
        PLAYER_PANEL_GAP +
        PLAYER_PANEL_SIZE / 2,
      y: discardPanel.y + discardPanel.h - PLAYER_PANEL_SIZE / 2,
    };
  } else if (seat === 1) {
    center = {
      x: discardPanel.x + discardPanel.w - PLAYER_PANEL_SIZE / 2,
      y: discardPanel.y - PLAYER_PANEL_GAP - PLAYER_PANEL_SIZE / 2,
    };
  } else if (seat === 2) {
    center = {
      x: discardPanel.x - PLAYER_PANEL_GAP - PLAYER_PANEL_SIZE / 2,
      y: discardPanel.y + PLAYER_PANEL_SIZE / 2,
    };
  } else {
    center = {
      x: discardPanel.x + PLAYER_PANEL_SIZE / 2,
      y:
        discardPanel.y +
        discardPanel.h +
        PLAYER_PANEL_GAP +
        PLAYER_PANEL_SIZE / 2,
    };
  }

  const rightDiscard = discardPanels[((seat + 1) % 4) as Seat];
  if (seat === 0) {
    const gap =
      center.y - PLAYER_PANEL_SIZE / 2 - (rightDiscard.y + rightDiscard.h);
    center.y -= Math.max(0, gap) / 2;
  } else if (seat === 1) {
    const gap =
      center.x - PLAYER_PANEL_SIZE / 2 - (rightDiscard.x + rightDiscard.w);
    center.x -= Math.max(0, gap) / 2;
  } else if (seat === 2) {
    const gap = rightDiscard.y - (center.y + PLAYER_PANEL_SIZE / 2);
    center.y += Math.max(0, gap) / 2;
  } else {
    const gap = rightDiscard.x - (center.x + PLAYER_PANEL_SIZE / 2);
    center.x += Math.max(0, gap) / 2;
  }
  return center;
}

export function callEffectAnchor(
  layout: Pick<TableLayout, "center" | "hands">,
  seat: Seat
): { x: number; y: number } {
  const center = layout.center;
  const hand = layout.hands[seat];
  const centerX = center.x + center.w / 2;
  const centerY = center.y + center.h / 2;

  if (seat === 0) {
    const centerEdge = center.y + center.h;
    return {
      x: centerX,
      y: centerEdge + (hand.y - centerEdge) * CALL_EFFECT_GAP_FRACTION,
    };
  }
  if (seat === 1) {
    const centerEdge = center.x + center.w;
    return {
      x: centerEdge + (hand.x - centerEdge) * CALL_EFFECT_GAP_FRACTION,
      y: centerY,
    };
  }
  if (seat === 2) {
    const handEdge = hand.y + hand.h;
    return {
      x: centerX,
      y: center.y - (center.y - handEdge) * CALL_EFFECT_GAP_FRACTION,
    };
  }
  const handEdge = hand.x + hand.w;
  return {
    x: center.x - (center.x - handEdge) * CALL_EFFECT_GAP_FRACTION,
    y: centerY,
  };
}
