/**
 * Shared, Pixi-free geometry primitives for the table renderer.
 *
 * This module is the single dependency-light home for the value
 * types and pure helpers that the layout config, tile design, seat
 * transforms, area layout, animator, and renderer all share. It must
 * never import `pixi.js` (or anything that transitively does) so it
 * stays unit-testable in vitest/jsdom and safe to import from
 * SSR-rendered React.
 */

/** Axis-aligned rectangle in design-space pixels. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Width/height pair in design-space pixels. */
export interface Size {
  w: number;
  h: number;
}

/** Seat index. 0 = bottom (you), 1 = right, 2 = top, 3 = left. */
export type Seat = 0 | 1 | 2 | 3;

export const SEATS: readonly Seat[] = [0, 1, 2, 3];

/**
 * On-screen orientation of a seat's zone. Bottom/top seats carry
 * "vertical" tile artwork (cap toward screen top/bottom); left/right
 * seats carry "horizontal" artwork (cap toward screen left/right).
 */
export type SeatOrientation = "bottom" | "right" | "top" | "left";

const SEAT_ORIENTATIONS: Record<Seat, SeatOrientation> = {
  0: "bottom",
  1: "right",
  2: "top",
  3: "left",
};

export function seatOrientation(seat: Seat): SeatOrientation {
  return SEAT_ORIENTATIONS[seat];
}

/** Side seats (1/3) render with horizontal-art sheets; bottom/top
 * (0/2) render with vertical-art sheets. */
export function isSideSeat(seat: Seat): boolean {
  return seat % 2 === 1;
}

export function rectRight(r: Rect): number {
  return r.x + r.w;
}

export function rectBottom(r: Rect): number {
  return r.y + r.h;
}

export function rectArea(r: Rect): number {
  return r.w * r.h;
}

/** Axis-aligned bounding box of a non-empty list of rects. Throws on
 * an empty list rather than returning a degenerate rect. */
export function boundingBox(rects: readonly Rect[]): Rect {
  if (rects.length === 0) {
    throw new Error("boundingBox: empty rect list");
  }
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const r of rects) {
    if (r.x < x0) {
      x0 = r.x;
    }
    if (r.y < y0) {
      y0 = r.y;
    }
    if (r.x + r.w > x1) {
      x1 = r.x + r.w;
    }
    if (r.y + r.h > y1) {
      y1 = r.y + r.h;
    }
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Per-edge overflow of `inner` outside `outer`, in design pixels.
 * Each field is the positive distance by which `inner` exceeds
 * `outer` on that edge, or 0 when it is within. `any` is the max of
 * the four so callers can branch on a single value. */
export interface OverflowReport {
  left: number;
  top: number;
  right: number;
  bottom: number;
  any: number;
}

export function overflowOf(outer: Rect, inner: Rect): OverflowReport {
  const left = Math.max(0, outer.x - inner.x);
  const top = Math.max(0, outer.y - inner.y);
  const right = Math.max(0, inner.x + inner.w - (outer.x + outer.w));
  const bottom = Math.max(0, inner.y + inner.h - (outer.y + outer.h));
  return { left, top, right, bottom, any: Math.max(left, top, right, bottom) };
}

/** True when `inner` sits inside `outer`. `epsilon` tolerates
 * sub-pixel overspill (e.g. a 251.7 px content row inside a 250 px
 * zone) when a caller wants to allow it explicitly. */
export function containsRect(outer: Rect, inner: Rect, epsilon = 0): boolean {
  return overflowOf(outer, inner).any <= epsilon;
}
