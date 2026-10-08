import type { MatchView } from "../../store";
import type { LegalAction } from "~/game/protocol/messages";
import { findTileAction } from "../../discardActions";
import type { Rect } from "../tableLayout";
import { RIICHI_UNAVAILABLE_TINT } from "./renderConstants";

export interface TapSample {
  x: number;
  y: number;
  timeMs: number;
}

export function pointerToHandCoordinates(input: {
  point: { x: number; y: number };
  viewport: { left: number; top: number; width: number; height: number };
  screen: { width: number; height: number };
  root: {
    position: { x: number; y: number };
    scale: { x: number; y: number };
  };
  origin: { x: number; y: number };
}): { x: number; y: number } {
  const { point, viewport, screen, root, origin } = input;
  const x =
    ((point.x - viewport.left) / Math.max(1, viewport.width)) * screen.width;
  const y =
    ((point.y - viewport.top) / Math.max(1, viewport.height)) * screen.height;
  return {
    x: (x - root.position.x) / root.scale.x - origin.x,
    y: (y - root.position.y) / root.scale.y - origin.y,
  };
}

export function pointInsideRect(
  point: { x: number; y: number },
  rect: { x: number; y: number; w: number; h: number }
): boolean {
  return (
    point.x >= rect.x &&
    point.x <= rect.x + rect.w &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.h
  );
}

export function isDoubleTapGesture(
  previous: TapSample | null,
  current: TapSample,
  maxDelayMs = 320,
  maxDistancePx = 40
): boolean {
  if (previous === null) {
    return false;
  }
  const elapsed = current.timeMs - previous.timeMs;
  const dx = current.x - previous.x;
  const dy = current.y - previous.y;
  return (
    elapsed >= 0 &&
    elapsed <= maxDelayMs &&
    dx * dx + dy * dy <= maxDistancePx * maxDistancePx
  );
}

export function isMobileDoubleTapShortcutTarget(
  point: { x: number; y: number },
  center: Rect,
  focusedHand: Rect,
  actionButtons: readonly Rect[] = []
): boolean {
  return (
    !pointInsideRect(point, center) &&
    !pointInsideRect(point, focusedHand) &&
    !actionButtons.some((rect) => pointInsideRect(point, rect))
  );
}

export function genericPassOrTsumogiriAction(
  view: Pick<MatchView, "legalActions" | "mySeat" | "hands">
): LegalAction | undefined {
  const pass = view.legalActions.find((action) => action.type === "pass");
  if (pass) {
    return pass;
  }
  if (view.legalActions.some((action) => action.type === "nuki")) {
    return undefined;
  }
  if (view.mySeat === null) {
    return undefined;
  }
  const hand = view.hands[view.mySeat];
  const drawn = hand?.[hand.length - 1];
  if (drawn === null || drawn === undefined) {
    return undefined;
  }
  return findTileAction(view.legalActions, "discard", drawn, "draw");
}

export function canInteractWithFocusedHand(
  view: Pick<MatchView, "conn">
): boolean {
  return view.conn !== "replay";
}

export function canApplyFocusedHandHover(isDragging: boolean): boolean {
  return !isDragging;
}

export function focusedHandOrderPolicy(
  isDragging: boolean,
  isAutoSortOn: boolean
): { previewReorder: boolean; useDisplayOrder: boolean } {
  return {
    previewReorder: isDragging,
    useDisplayOrder: isDragging || !isAutoSortOn,
  };
}

export function isPendingDiscardDisplaySlot(
  pendingDiscard: MatchView["pendingDiscard"],
  seat: number,
  tile: string | null,
  displayIndex: number
): boolean {
  return Boolean(
    pendingDiscard &&
    pendingDiscard.seat === seat &&
    pendingDiscard.tile === tile &&
    (pendingDiscard.displayIndex === undefined ||
      pendingDiscard.displayIndex === displayIndex)
  );
}

export function topmostHandHoverTargetIndex(
  point: { x: number; y: number },
  bounds: ReadonlyArray<{ x: number; y: number; width: number; height: number }>
): number | null {
  for (let index = bounds.length - 1; index >= 0; index--) {
    const rect = bounds[index];
    if (
      point.x >= rect.x &&
      point.x <= rect.x + rect.width &&
      point.y >= rect.y &&
      point.y <= rect.y + rect.height
    ) {
      return index;
    }
  }
  return null;
}

export function riichiSelectionTileTint(
  inRiichiMode: boolean,
  canDeclareRiichi: boolean
): number | null {
  return inRiichiMode && !canDeclareRiichi ? RIICHI_UNAVAILABLE_TINT : null;
}

export function darkenTileTint(tint: number, factor: number): number {
  const channel = (shift: number): number =>
    Math.round(((tint >> shift) & 0xff) * factor);
  return (channel(16) << 16) | (channel(8) << 8) | channel(0);
}
