/**
 * Declarative per-seat coordinate transforms.
 *
 * Each seat's tile containers (hand, discard, meld) share one
 * placement rule: rotate local content by the seat's quarter-turn and
 * anchor it at a specific corner of the seat's zone rect. Capturing
 * that once replaces the four-way `switch (seat)` blocks previously
 * duplicated across hand, discard, and meld positioning, and provides
 * the inverse mapping used for pointer hit-testing.
 *
 * Local space: origin at the container's (0, 0), +x along the strip's
 * reading direction, +y across it. `localToTable` maps a local point
 * into design-space table coordinates; `tableToLocal` is its exact
 * inverse. Pixi-free.
 */
import { isSideSeat, type Rect, type Seat } from "./tableGeometry";

export interface Vec2 {
  x: number;
  y: number;
}

export interface SeatTransform {
  seat: Seat;
  /** Container rotation in radians (as applied to the Pixi node). */
  rotation: number;
  /** Exact cosine of `rotation` (integer for a quarter turn). */
  cos: number;
  /** Exact sine of `rotation`. */
  sin: number;
  /** Corner of the zone rect the local origin anchors to. */
  origin: (rect: Rect) => Vec2;
  /** Within-row / within-hand stacking sign (side seats only): the
   * tile lower on screen sits on top. 0 for bottom/top seats, which
   * stack by row instead. */
  overlapZSign: number;
}

const HALF_PI = Math.PI / 2;

/** Normalise `-0` to `0` so transform outputs compare cleanly. */
const nz = (n: number): number => (n === 0 ? 0 : n);

/** Exact (cos, sin) per seat so round-trips carry no float drift. */
const TRIG: Record<Seat, { rotation: number; cos: number; sin: number }> = {
  0: { rotation: 0, cos: 1, sin: 0 },
  1: { rotation: -HALF_PI, cos: 0, sin: -1 },
  2: { rotation: Math.PI, cos: -1, sin: 0 },
  3: { rotation: HALF_PI, cos: 0, sin: 1 },
};

const ORIGIN: Record<Seat, (r: Rect) => Vec2> = {
  0: (r) => ({ x: r.x, y: r.y }),
  1: (r) => ({ x: r.x, y: r.y + r.h }),
  2: (r) => ({ x: r.x + r.w, y: r.y + r.h }),
  3: (r) => ({ x: r.x + r.w, y: r.y }),
};

const OVERLAP_Z_SIGN: Record<Seat, number> = { 0: 0, 1: -1, 2: 0, 3: 1 };

export const SEAT_TRANSFORMS: Record<Seat, SeatTransform> = {
  0: makeTransform(0),
  1: makeTransform(1),
  2: makeTransform(2),
  3: makeTransform(3),
};

function makeTransform(seat: Seat): SeatTransform {
  const { rotation, cos, sin } = TRIG[seat];
  return {
    seat,
    rotation,
    cos,
    sin,
    origin: ORIGIN[seat],
    overlapZSign: OVERLAP_Z_SIGN[seat],
  };
}

export function seatTransform(seat: Seat): SeatTransform {
  return SEAT_TRANSFORMS[seat];
}

/** Map a container-local point into table (design-space) coordinates. */
export function localToTable(t: SeatTransform, rect: Rect, local: Vec2): Vec2 {
  const o = t.origin(rect);
  return {
    x: nz(o.x + local.x * t.cos - local.y * t.sin),
    y: nz(o.y + local.x * t.sin + local.y * t.cos),
  };
}

/** Inverse of {@link localToTable}: table point → container-local. */
export function tableToLocal(t: SeatTransform, rect: Rect, table: Vec2): Vec2 {
  const o = t.origin(rect);
  const dx = table.x - o.x;
  const dy = table.y - o.y;
  return {
    x: nz(dx * t.cos + dy * t.sin),
    y: nz(-dx * t.sin + dy * t.cos),
  };
}

/** True for seats whose strips overlap within a row (1 and 3). */
export function overlapsWithinRow(seat: Seat): boolean {
  return isSideSeat(seat);
}
