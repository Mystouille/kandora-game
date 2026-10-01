import type { MatchView } from "../../store";
import type { Rect } from "../tableLayout";
import { displayedTilesRemaining } from "../panels/duplicateCounterPlan";
import { scoreCartridgeMetrics } from "./scoreGeometry";
import { SMALL_TILE_W, SMALL_TILE_H } from "./renderConstants";

export const MOBILE_DORA_INDICATOR_GAP = 0;

export function mobileDoraIndicatorSlots(
  indicators: readonly string[]
): Array<string | null> {
  return Array.from({ length: 5 }, (_, index) => indicators[index] ?? null);
}

export interface MobileDoraRowGeometry {
  x: number;
  y: number;
  width: number;
  tileW: number;
  tileH: number;
}

export function mobileCenterInnerRect(center: Rect): Rect {
  const { height: sideCartridgeW, inset } = scoreCartridgeMetrics(center);
  return {
    x: center.x + inset + sideCartridgeW,
    y: center.y + inset + sideCartridgeW,
    w: Math.max(0, center.w - 2 * (inset + sideCartridgeW)),
    h: Math.max(0, center.h - 2 * (inset + sideCartridgeW)),
  };
}

export function mobileDoraRowGeometry(
  center: Rect,
  slotCount: number
): MobileDoraRowGeometry {
  const inner = mobileCenterInnerRect(center);
  const x = inner.x;
  const width = inner.w;
  const tileW = slotCount > 0 ? width / slotCount : 0;
  return {
    x,
    y: inner.y,
    width,
    tileW,
    tileH: tileW * (SMALL_TILE_H / SMALL_TILE_W),
  };
}

export function mobileCounterCells(center: Rect, count: number): Rect[] {
  if (count <= 0) {
    return [];
  }
  const inner = mobileCenterInnerRect(center);
  const cellWidth = inner.w / count;
  return Array.from({ length: count }, (_, index) => ({
    x: inner.x + index * cellWidth,
    y: inner.y,
    w: cellWidth,
    h: inner.h,
  }));
}

export const CENTER_DORA_INDICATOR_GAP = MOBILE_DORA_INDICATOR_GAP;

export const centerDoraIndicatorSlots = mobileDoraIndicatorSlots;

export type CenterDoraRowGeometry = MobileDoraRowGeometry;

export const centerInfoInnerRect = mobileCenterInnerRect;

export const centerDoraRowGeometry = mobileDoraRowGeometry;

export const centerCounterCells = mobileCounterCells;

export interface CenterCounterSpec {
  kind: "honba" | "riichi" | "tiles";
  value: number;
  color: number;
}

export function centerCounterSpecs(
  view: Pick<MatchView, "buuMode" | "honba" | "riichiSticks" | "drawsTaken"> & {
    duplicateWallState?: MatchView["duplicateWallState"];
  }
): CenterCounterSpec[] {
  return [
    ...(view.buuMode === true
      ? []
      : [{ kind: "honba" as const, value: view.honba, color: 0xfde68a }]),
    { kind: "riichi", value: view.riichiSticks, color: 0xfca5a5 },
    {
      kind: "tiles",
      value: displayedTilesRemaining(view),
      color: 0xd1d5db,
    },
  ];
}

export function fitCounterContentInCell(
  content: { minX: number; minY: number; maxX: number; maxY: number },
  cell: Rect,
  padding: number
): { x: number; y: number; scale: number } {
  const contentWidth = Math.max(0, content.maxX - content.minX);
  const contentHeight = Math.max(0, content.maxY - content.minY);
  const availableWidth = Math.max(0, cell.w - padding * 2);
  const availableHeight = Math.max(0, cell.h - padding * 2);
  const scale = Math.min(
    1,
    contentWidth > 0 ? availableWidth / contentWidth : 1,
    contentHeight > 0 ? availableHeight / contentHeight : 1
  );
  return {
    x: cell.x + cell.w / 2 - ((content.minX + content.maxX) / 2) * scale,
    y: cell.y + cell.h - padding - content.maxY * scale,
    scale,
  };
}
