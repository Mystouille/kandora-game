import type { Vec2 } from "../seatTransform";
import type { Rect, TableLayout } from "../tableLayout";
import type { DiscardLayoutOptions } from "../tileAreaLayout";

export interface FocusedDiscardDrawingFrame {
  /** CSS-pixel geometry relative to the renderer's canvas container. */
  table: Rect;
  origin: Vec2;
  scale: number;
}

export function focusedDiscardDrawingFrame(
  layout: TableLayout,
  options: DiscardLayoutOptions | undefined,
  root: Vec2 & { scale: number }
): FocusedDiscardDrawingFrame {
  const pond = layout.discards[0];
  const frame: FocusedDiscardDrawingFrame = {
    table: {
      x: root.x,
      y: root.y,
      w: layout.table.w * root.scale,
      h: layout.table.h * root.scale,
    },
    origin: {
      x: root.x + (pond.x + (options?.offsetX ?? 0)) * root.scale,
      y: root.y + (pond.y + (options?.offsetY ?? 0)) * root.scale,
    },
    scale: root.scale * (options?.scale ?? 1),
  };
  if (
    ![
      ...Object.values(frame.table),
      frame.origin.x,
      frame.origin.y,
      frame.scale,
    ].every(Number.isFinite) ||
    frame.table.w <= 0 ||
    frame.table.h <= 0 ||
    frame.scale <= 0
  ) {
    throw new Error("Invalid focused-discard drawing geometry");
  }
  return frame;
}

export function toFocusedDiscardPoint(
  point: Vec2,
  frame: FocusedDiscardDrawingFrame
): Vec2 {
  return {
    x: (point.x - frame.origin.x) / frame.scale,
    y: (point.y - frame.origin.y) / frame.scale,
  };
}

export function fromFocusedDiscardPoint(
  point: Vec2,
  frame: FocusedDiscardDrawingFrame
): Vec2 {
  return {
    x: frame.origin.x + point.x * frame.scale,
    y: frame.origin.y + point.y * frame.scale,
  };
}

export function sameFocusedDiscardFrame(
  left: FocusedDiscardDrawingFrame | null,
  right: FocusedDiscardDrawingFrame | null
): boolean {
  return (
    left === right ||
    (left !== null &&
      right !== null &&
      left.origin.x === right.origin.x &&
      left.origin.y === right.origin.y &&
      left.scale === right.scale &&
      left.table.x === right.table.x &&
      left.table.y === right.table.y &&
      left.table.w === right.table.w &&
      left.table.h === right.table.h)
  );
}
