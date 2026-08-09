/**
 * Pure geometry for the Tenhou-style table layout.
 *
 * All zones are described proportionally relative to a fixed
 * design-space game zone (`DESIGN_W` × `DESIGN_H`). The renderer
 * scales the whole table to fit the canvas, so the proportions
 * carry over at any size.
 *
 * Reference design (1000 × 926):
 *
 *   focused player hand zone     w=1000  h=138
 *   top player hand zone         w=912   h=65
 *   left/right player hand zone  w=56    h=700
 *   wall zone (horizontal)       w=710   h=102
 *   wall zone (vertical)         w=135   h=621
 *   discard zone (horizontal)    w=250   h=150
 *   discard zone (vertical)      w=168   h=212
 *   center zone                  w=250   h=200
 *
 *   vertical tile                w=42    h=63
 *   horizontal tile              w=56    h=51
 *   focused-hand vertical tile   w=67    h=104
 *
 * Layout: zones stack in a symmetric cross. The bottom (focused)
 * hand is flush against the bottom edge; the centre column
 * abuts above it (bottom wall → bottom discard → centre → top
 * discard → top wall → top hand at y=0 with 19 px slack between
 * the top hand and the top wall). The left/right zones are
 * centred vertically on the centre rect's midline. Horizontal
 * slack (32 px total) is distributed as 8 px gaps between
 * side-hand/wall and side-discard/centre on each side.
 *
 * Seat indices follow the existing renderer convention:
 *
 *      seat 2 (top / toimen)
 *   seat 3                seat 1
 *   (left)               (right)
 *      seat 0 (bottom / you)
 */

import { boundingBox, type Rect, type Size } from "./tableGeometry";

export type { Rect };

export interface TileDims {
  /** Short edge of a face-up tile. */
  w: number;
  /** Long edge of a face-up tile. */
  h: number;
  /** Gap between adjacent tiles in a row. */
  gap: number;
}

export interface TableLayout {
  /** Whole table footprint (everything fits inside this rect). */
  table: Rect;
  /** Central game-info square. */
  center: Rect;
  /** Discard ponds, indexed by seat (0=bottom, 1=right, 2=top, 3=left). */
  discards: [Rect, Rect, Rect, Rect];
  /** Player-info chips. The chip for seat `s` sits at the corner
   * to the right of seat `s` (looking from `s`'s pov):
   * seat 0 → bottom-right, seat 1 → top-right, etc. */
  playerInfo: [Rect, Rect, Rect, Rect];
  /** Wall bands, indexed by seat (band in front of each seat). */
  wall: [Rect, Rect, Rect, Rect];
  /** Hand strips, indexed by seat. */
  hands: [Rect, Rect, Rect, Rect];
  /** Tile metrics used by callers that don't differentiate
   * orientation (kept for backward compatibility — defaults to
   * `tileVertical`). */
  tile: TileDims;
  /** Tile metrics for the wall stacks (defaults to
   * `tileVertical`). */
  wallTile: TileDims;
  /** Tiles whose long axis points vertically on screen — used by
   * the left/right walls, side discards and side hands. */
  tileVertical: TileDims;
  /** Tiles whose long axis points horizontally on screen — used
   * by the top/bottom walls, top/bottom discards and the top
   * hand. */
  tileHorizontal: TileDims;
  /** Larger tiles used by the focused player's (seat 0) hand. */
  tileSelf: TileDims;
  /** Tiles used in the side hands (seats 1/3). Stacked along the
   * hand's long axis with `tileSideOverlap` design pixels of
   * overlap between consecutive tiles — the lower tile (closer to
   * the centre of the table) is drawn on top of the higher one. */
  tileSide: TileDims;
  /** Overlap in design pixels between adjacent side-hand tiles
   * along the hand's long axis. Stride = `tileSide.h -
   * tileSideOverlap`. */
  tileSideOverlap: number;
}

/** Design-space dimensions. The renderer scales this rect to the
 * canvas. */
export const DESIGN_W = 1000;
export const DESIGN_H = 926;

/** Per-orientation tile metrics. */
export const TILE_VERTICAL: TileDims = { w: 42, h: 63, gap: 2 };
export const TILE_HORIZONTAL: TileDims = { w: 41, h: 63, gap: 0 };
export const TILE_SELF: TileDims = { w: 67, h: 104, gap: 0 };
/** Side-hand tiles (seats 1/3). The 30 px overlap means
 * consecutive tiles share that much of their long axis, so the
 * stride is `h - overlap = 35` px. */
export const TILE_SIDE: TileDims = { w: 29, h: 65, gap: 0 };
export const TILE_SIDE_OVERLAP = 30;

/** Re-exports for callers that don't care about orientation yet. */
export const DEFAULT_TILE: TileDims = TILE_VERTICAL;
export const DEFAULT_WALL_TILE: TileDims = TILE_VERTICAL;

// Zone sizes (design-space pixels).
const HAND_BOTTOM_W = 1000;
const HAND_BOTTOM_H = 138;
const HAND_TOP_W = 912;
const HAND_TOP_H = 65;
const HAND_SIDE_W = 56;
const HAND_SIDE_H = 700;
const WALL_HORIZ_W = 710;
const WALL_HORIZ_H = 102;
const WALL_VERT_W = 135;
const WALL_VERT_H = 621;
const DISCARD_HORIZ_W = 250;
const DISCARD_HORIZ_H = 150;
const DISCARD_VERT_W = 168;
const DISCARD_VERT_H = 212;
const CENTER_W = 250;
const CENTER_H = 200;

/**
 * Compute the table layout. Zone sizes are fixed in design space;
 * the renderer scales the resulting rects to the canvas.
 *
 * The `_width` / `_height` / tile args are kept for backward
 * compatibility but ignored — the design space is fixed at
 * `DESIGN_W` × `DESIGN_H`.
 */
export function computeTableLayout(
  _width: number = DESIGN_W,
  _height: number = DESIGN_H,
  _tile: TileDims = TILE_VERTICAL,
  _wallTile: TileDims = TILE_VERTICAL
): TableLayout {
  void _width;
  void _height;
  void _tile;
  void _wallTile;

  // Vertical column: bottom (focused) hand is flush against the
  // bottom edge; everything else stacks upward, abutting. The top
  // hand sits at y=0; the 19 px vertical slack lives between the
  // top hand and the top wall.
  const handBottom: Rect = {
    x: 0,
    y: DESIGN_H - HAND_BOTTOM_H,
    w: HAND_BOTTOM_W,
    h: HAND_BOTTOM_H,
  };
  const handTop: Rect = {
    // Shorten the top band by 40 design px on its screen-left end,
    // then shift the whole band 3 tile widths to the screen-left.
    x: (DESIGN_W - HAND_TOP_W) / 2 + 40 - 3 * TILE_VERTICAL.w,
    y: 0,
    // Shorten the top band by 40 design px on its screen-right end.
    w: HAND_TOP_W - 40 - 40,
    h: HAND_TOP_H,
  };
  // Side hands — centred vertically on the design's midline.
  const designMidY = DESIGN_H / 2;
  const handLeft: Rect = {
    x: 0,
    y: designMidY - HAND_SIDE_H / 2,
    w: HAND_SIDE_W,
    // Shorten the left band by 140 design px on its player-right end
    // (screen bottom; +x in container-local space for seat 3).
    h: HAND_SIDE_H - 140,
  };
  const handRight: Rect = {
    x: DESIGN_W - HAND_SIDE_W,
    y: designMidY - HAND_SIDE_H / 2,
    w: HAND_SIDE_W,
    // Shorten the right band by 80 design px on its player-left end
    // (screen bottom; +x in container-local space for seat 1 runs
    // bottom→top, so cutting the bottom shortens the player-left end).
    h: HAND_SIDE_H - 80,
  };

  // Walls form a pinwheel. The bottom wall sticks to the left
  // wall's right edge; the top wall sticks to the right wall's
  // left edge. The right/left walls remain flush to their
  // next-clockwise hand zones.
  //
  // Left wall x = handLeft.x + handLeft.w → bottom wall x =
  // handLeft.x + handLeft.w + WALL_VERT_W.
  // Right wall x = handRight.x - WALL_VERT_W → top wall x =
  // handRight.x - WALL_VERT_W - WALL_HORIZ_W.
  const wallBottom: Rect = {
    x: handLeft.x + handLeft.w + WALL_VERT_W,
    y: handBottom.y - WALL_HORIZ_H,
    w: WALL_HORIZ_W,
    h: WALL_HORIZ_H,
  };
  const discardBottom: Rect = {
    x: (DESIGN_W - DISCARD_HORIZ_W) / 2,
    y: wallBottom.y - DISCARD_HORIZ_H,
    w: DISCARD_HORIZ_W,
    h: DISCARD_HORIZ_H,
  };
  // The centre rect is defined first via the bottom discard so the
  // remaining three discard rects can anchor directly to it.
  const center: Rect = {
    x: (DESIGN_W - CENTER_W) / 2,
    y: discardBottom.y - CENTER_H,
    w: CENTER_W,
    h: CENTER_H,
  };
  // Recompute discardBottom's x to abut the centre rect (no-op when
  // DISCARD_HORIZ_W == CENTER_W, but makes the anchoring explicit).
  discardBottom.x = center.x + (center.w - DISCARD_HORIZ_W) / 2;
  const discardTop: Rect = {
    x: center.x + (center.w - DISCARD_HORIZ_W) / 2,
    y: center.y - DISCARD_HORIZ_H,
    w: DISCARD_HORIZ_W,
    h: DISCARD_HORIZ_H,
  };
  const wallTop: Rect = {
    x: handRight.x - WALL_VERT_W - WALL_HORIZ_W,
    y: handTop.y + handTop.h,
    w: WALL_HORIZ_W,
    h: WALL_HORIZ_H,
  };

  // Side zones — centred vertically on the centre rect's midline.
  const centerMidY = center.y + center.h / 2;
  const wallLeft: Rect = {
    x: handLeft.x + handLeft.w,
    y: handBottom.y - WALL_VERT_H,
    w: WALL_VERT_W,
    h: WALL_VERT_H,
  };
  const wallRight: Rect = {
    x: handRight.x - WALL_VERT_W,
    y: handTop.y + handTop.h,
    w: WALL_VERT_W,
    // Encroach into the bottom wall band by `2 × side-tile-overlap −
    // 8` design pixels so seat 1's bottom-end tile visually overlaps
    // the bottom wall's right-end stack at the corner (matches the
    // renderer's SIDE_TILE_OVERLAP = 16 → 27 px).
    h: WALL_VERT_H + 2 * 16 - 8,
  };
  const discardLeft: Rect = {
    x: center.x - DISCARD_VERT_W,
    y: centerMidY - DISCARD_VERT_H / 2,
    w: DISCARD_VERT_W,
    h: DISCARD_VERT_H,
  };
  const discardRight: Rect = {
    x: center.x + center.w,
    y: centerMidY - DISCARD_VERT_H / 2,
    w: DISCARD_VERT_W,
    h: DISCARD_VERT_H,
  };

  // Player-info chips: corner pockets between the centre rect,
  // side discards and top/bottom discards.
  //   seat 0 (bottom) → bottom-right pocket
  //   seat 1 (right)  → top-right
  //   seat 2 (top)    → top-left
  //   seat 3 (left)   → bottom-left
  const piBR: Rect = {
    x: discardBottom.x + discardBottom.w,
    y: discardRight.y + discardRight.h,
    w: discardRight.x - (discardBottom.x + discardBottom.w),
    h: discardBottom.y + discardBottom.h - (discardRight.y + discardRight.h),
  };
  const piTR: Rect = {
    x: discardTop.x + discardTop.w,
    y: discardTop.y,
    w: discardRight.x - (discardTop.x + discardTop.w),
    h: discardRight.y - discardTop.y,
  };
  const piTL: Rect = {
    x: discardLeft.x + discardLeft.w,
    y: discardTop.y,
    w: discardTop.x - (discardLeft.x + discardLeft.w),
    h: discardLeft.y - discardTop.y,
  };
  const piBL: Rect = {
    x: discardLeft.x + discardLeft.w,
    y: discardLeft.y + discardLeft.h,
    w: discardBottom.x - (discardLeft.x + discardLeft.w),
    h: discardBottom.y + discardBottom.h - (discardLeft.y + discardLeft.h),
  };

  const table: Rect = { x: 0, y: 0, w: DESIGN_W, h: DESIGN_H };

  return {
    table,
    center,
    discards: [discardBottom, discardRight, discardTop, discardLeft],
    playerInfo: [piBR, piTR, piTL, piBL],
    wall: [wallBottom, wallRight, wallTop, wallLeft],
    hands: [handBottom, handRight, handTop, handLeft],
    tile: TILE_VERTICAL,
    wallTile: TILE_VERTICAL,
    tileVertical: TILE_VERTICAL,
    tileHorizontal: TILE_HORIZONTAL,
    tileSelf: TILE_SELF,
    tileSide: TILE_SIDE,
    tileSideOverlap: TILE_SIDE_OVERLAP,
  };
}

// ---------------------------------------------------------------------------
// Switchable layout config (Phase 4)
//
// A `TableLayoutConfig` owns only *where* the semantic zones sit and
// how the overlay stack is ordered. Tile artwork/metrics live in the
// tile design; how tiles fit inside a zone is decided at area-layout
// time. Zone IDs, seat mapping, and layer names are invariant across
// presets; rectangle geometry and viewport may vary.
// ---------------------------------------------------------------------------

/** The invariant semantic zones, per seat where applicable. */
export interface TableZones {
  center: Rect;
  hands: [Rect, Rect, Rect, Rect];
  discards: [Rect, Rect, Rect, Rect];
  walls: [Rect, Rect, Rect, Rect];
  playerInfo: [Rect, Rect, Rect, Rect];
}

/** Semantic z-index tiers shared across presets. Values are the
 * legacy renderer's; a preset may override where a different
 * stacking is required. */
export interface LayerTiers {
  discardLift: number;
  handFocused: number;
  actionButtons: number;
  nameplate: number;
  resultOverlay: number;
  draggedTile: number;
}

export const DEFAULT_LAYER_TIERS: LayerTiers = {
  discardLift: 5,
  handFocused: 10,
  actionButtons: 50,
  nameplate: 100,
  resultOverlay: 1000,
  draggedTile: 1_000_000,
};

export interface TableLayoutConfig {
  id: string;
  displayName: string;
  /** Design-space viewport the zones are expressed in. */
  viewport: Size;
  zones: TableZones;
  /** Explicit felt rect; when omitted it is derived (see below). */
  felt?: Rect;
  layers: LayerTiers;
}

/** Felt/background rect: explicit when set, else the bounding box of
 * every wall band and hand strip (matches the legacy renderer, which
 * derived the felt from `boundingBox([...wall, ...hands])`). */
export function resolveFelt(config: TableLayoutConfig): Rect {
  if (config.felt) {
    return config.felt;
  }
  return boundingBox([...config.zones.walls, ...config.zones.hands]);
}

function isFiniteRect(r: Rect): boolean {
  return (
    Number.isFinite(r.x) &&
    Number.isFinite(r.y) &&
    Number.isFinite(r.w) &&
    Number.isFinite(r.h)
  );
}

/**
 * Validate a layout config, returning human-readable errors (empty
 * when valid). Note: zones may legitimately extend outside the
 * viewport (the current top-hand band starts at negative x), so
 * viewport containment is intentionally not enforced here. The
 * `playerInfo` corner pockets may collapse to zero size (the current
 * preset has `DISCARD_HORIZ_W === CENTER_W`), so only the
 * tile-bearing zones are required to have positive area.
 */
export function validateTableLayoutConfig(
  config: TableLayoutConfig
): string[] {
  const errors: string[] = [];
  if (!(config.viewport.w > 0) || !(config.viewport.h > 0)) {
    errors.push("viewport must have positive dimensions");
  }
  const positiveZones: Array<[string, Rect]> = [
    ["center", config.zones.center],
  ];
  const tileBearingKeys = ["hands", "discards", "walls"] as const;
  for (const k of tileBearingKeys) {
    config.zones[k].forEach((r, i) => positiveZones.push([`${k}[${i}]`, r]));
  }
  const finiteOnlyZones: Array<[string, Rect]> = config.zones.playerInfo.map(
    (r, i) => [`playerInfo[${i}]`, r]
  );
  for (const [name, r] of [...positiveZones, ...finiteOnlyZones]) {
    if (!isFiniteRect(r)) {
      errors.push(`zone ${name} has non-finite coordinates`);
    }
  }
  for (const [name, r] of positiveZones) {
    if (!(r.w > 0) || !(r.h > 0)) {
      errors.push(`zone ${name} has non-positive size`);
    }
  }
  for (const [name, v] of Object.entries(config.layers)) {
    if (!Number.isFinite(v)) {
      errors.push(`layer tier ${name} must be finite`);
    }
  }
  return errors;
}

/** Throwing wrapper around {@link validateTableLayoutConfig}. */
export function assertValidTableLayoutConfig(
  config: TableLayoutConfig
): TableLayoutConfig {
  const errors = validateTableLayoutConfig(config);
  if (errors.length > 0) {
    throw new Error(
      `Invalid table layout "${config.id}":\n- ${errors.join("\n- ")}`
    );
  }
  return config;
}

/**
 * Build the render-time `TableLayout` from a layout config: the
 * config supplies the viewport + zone rects, while tile metrics are
 * the fixed design-space values (not yet part of the switchable
 * config). For the current preset this is byte-identical to
 * `computeTableLayout()`.
 */
export function tableLayoutFromConfig(config: TableLayoutConfig): TableLayout {
  return {
    table: { x: 0, y: 0, w: config.viewport.w, h: config.viewport.h },
    center: config.zones.center,
    discards: config.zones.discards,
    playerInfo: config.zones.playerInfo,
    wall: config.zones.walls,
    hands: config.zones.hands,
    tile: TILE_VERTICAL,
    wallTile: TILE_VERTICAL,
    tileVertical: TILE_VERTICAL,
    tileHorizontal: TILE_HORIZONTAL,
    tileSelf: TILE_SELF,
    tileSide: TILE_SIDE,
    tileSideOverlap: TILE_SIDE_OVERLAP,
  };
}
