/**
 * Tile-design contract: the single source of truth for how tiles
 * *look* — sprite atlases, per-category source art + scale, the
 * semantic atlas each board role/seat reads from, and the explicit
 * overlaps/gaps/effects the artwork cannot imply on its own.
 *
 * This module is Pixi-free and asset-free. Concrete designs (which
 * import PNGs) live under `./designs`; the active selection lives in
 * `./activeTileDesign.ts`. Nothing here assumes a particular atlas
 * count or grid shape, so future designs may organise artwork
 * differently from the current Tenhou sheets.
 */
import type { Rect, Seat, Size } from "../tableGeometry";

/** Design-local atlas identifier (e.g. "bottomSmall"). Kept as a
 * bare string so designs may name atlases however they like. */
export type AtlasId = string;

/** A cell address inside a grid atlas, in cell (not pixel) units. */
export interface AtlasCell {
  row: number;
  col: number;
}

/**
 * A multi-tile grid atlas. Each tile occupies one `cols × rows`
 * cell; the concrete pixel cell size is derived from the loaded
 * texture at runtime, so only the grid shape lives here.
 */
export interface GridAtlas {
  kind: "grid";
  url: string;
  cols: number;
  rows: number;
  /** Row index per suit letter, e.g. `{ m: 0, p: 1, s: 2, z: 3 }`. */
  suitRows: Record<string, number>;
  /** Cell used for face-down / unknown tiles. */
  backCell: AtlasCell;
  /** Optional per-side texel inset to prevent neighbour bleed when
   * downscaling. Consumed by the texture store (Phase 3). */
  inset?: number;
}

/** A single-image atlas (the whole texture is one tile face). */
export interface SingleAtlas {
  kind: "single";
  url: string;
}

export type AtlasDescriptor = GridAtlas | SingleAtlas;

/** Source artwork footprint + the scale applied to reach screen
 * size. Screen size is always `source × scale`, so artwork aspect is
 * preserved by construction. */
export interface TileArt {
  source: Size;
  scale: number;
}

export function artScreen(art: TileArt): Size {
  return { w: art.source.w * art.scale, h: art.source.h * art.scale };
}

/**
 * The three tile-art categories the renderer distinguishes:
 *   - `small`: vertical-art small tile (top/bottom discards, melds,
 *     walls, seat-2 hand backs).
 *   - `side`: horizontal-art small tile (left/right seats).
 *   - `big`: the focused player's large hand tile.
 */
export interface TileCategories {
  small: TileArt;
  side: TileArt;
  big: TileArt;
}

/**
 * Optional drop-shadow stuck to the RIGHT edge of every tile, from
 * single-image atlases (one per tile category — the silhouette
 * differs for upright small, side, and big art). The shadow keeps its
 * art's natural aspect at the tile's height and is nudged by a fixed
 * screen delta, applied the same way for every seat regardless of the
 * seat container's rotation. Disabled when omitted.
 */
export interface ShadowSpec {
  /** Single-image shadow atlas for a single top/bottom small tile. */
  small: AtlasId;
  /** Single-image shadow atlas for a single left/right side tile. */
  side: AtlasId;
  /** Single-image shadow atlas for the focused player's big tiles. */
  big: AtlasId;
  /** Single-image shadow atlas for face-down upright small tiles (the
   * top opponent's concealed hand). */
  uprightSmall: AtlasId;
  /** Repeatable strip 3-sliced along a line of tiles (shared by both
   * orientations, rotated to the line direction). */
  long: AtlasId;
  /** Shadow thickness (depth) of the line strip, in design px. */
  depth: number;
  /** Each end cap of the strip as a fraction (0–0.5) of its long axis. */
  cap: number;
  /** Uniform scale for the upright blob shadows (focused hand + the
   * face-down top hand), relative to the tile height. Default 1. */
  uprightScale?: number;
  /** Extra screen-space nudge from the flush right-edge position, in
   * design px. Positive x is screen-right, positive y is screen-down. */
  offsetX: number;
  offsetY: number;
  /** Opacity multiplier for the shadow sprite. Default 1. */
  alpha?: number;
}

export interface TileEffects {
  /** Multiplicative tint on a freshly-drawn tsumogiri discard. */
  tsumogiriFreshTint: number;
  /** Discards (across all seats) the tsumogiri cue persists for. */
  tsumogiriFreshWindow: number;
  /** Tint applied to a tile the focused player is waiting on. */
  waitTint: number;
  shadow?: ShadowSpec;
}

/** Which atlas each board role reads from. Face-down and face-up
 * variants are separated where the current renderer uses distinct
 * sheets; seat-keyed maps mirror the per-seat pre-rotated artwork. */
export interface DesignSheets {
  /** Seat 0 face-up hand. */
  ownHand: AtlasId;
  /** Seat 2 hand (same atlas for back and revealed faces). */
  topHand: AtlasId;
  /** Face-down side hand, keyed by side seat. */
  sideHandBack: Record<1 | 3, AtlasId>;
  /** Revealed side hand, keyed by side seat. */
  sideHandFace: Record<1 | 3, AtlasId>;
  discard: Record<Seat, AtlasId>;
  riichiDiscard: Record<Seat, AtlasId>;
  wallBack: Record<Seat, AtlasId>;
  wallFace: Record<Seat, AtlasId>;
  meld: Record<Seat, AtlasId>;
  /** Face-down meld tiles (ankan outer slots). */
  meldFaceDown: Record<Seat, AtlasId>;
}

/** Explicit spacing the artwork cannot imply. All in design px. */
export interface DesignSpacing {
  /** Row-direction overlap inside upright (top/bottom) discard rows. */
  discardRowHoriz: number;
  /** Cross-row overlap between upright discard rows. */
  discardRowVert: number;
  /** Long-axis overlap between face-down side-hand tiles. */
  sideHand: number;
  /** Long-axis overlap between side (left/right) wall tiles. */
  wallSide: number;
  /** Row-direction overlap between adjacent meld tiles (side seats). */
  meldSide: number;
  /** Gap separating the freshly-drawn 14th tile from the sorted run. */
  tsumoGap: number;
}

/** Footprints/metrics that are not a plain category × scale. */
export interface DesignMetrics {
  /** Face-down side-hand tile footprint. */
  sideHandBack: Size;
  /** Top hand (seat 2) tile footprint; its width is also the slot
   * pitch. */
  topHand: Size;
  /** Top/bottom wall tile footprint. */
  wallUpright: Size;
  /** Left/right wall tile: screen width + height/width aspect. */
  wallSide: { screenW: number; aspect: number };
  /** Width added to a small upright discard tile (height follows to
   * preserve the small-tile aspect). */
  discardUprightBump: number;
}

export interface TileDesign {
  id: string;
  displayName: string;
  attribution?: string;
  atlases: Record<AtlasId, AtlasDescriptor>;
  categories: TileCategories;
  sheets: DesignSheets;
  spacing: DesignSpacing;
  metrics: DesignMetrics;
  effects: TileEffects;
}

export const smallScreen = (d: TileDesign): Size => artScreen(d.categories.small);
export const sideScreen = (d: TileDesign): Size => artScreen(d.categories.side);
export const bigScreen = (d: TileDesign): Size => artScreen(d.categories.big);

/**
 * Resolve the atlas cell for a tile string (e.g. `"1m"`, `"0p"`
 * red-five, `"5z"`) or `null` (face-down). Returns `null` for a
 * single-image atlas (the whole texture is the frame). Falls back to
 * the atlas `backCell` for unknown suits / unparseable numbers,
 * mirroring the current renderer's defensive behaviour.
 */
export function resolveTileFrame(
  atlas: AtlasDescriptor,
  tile: string | null
): AtlasCell | null {
  if (atlas.kind === "single") {
    return null;
  }
  if (tile === null) {
    return atlas.backCell;
  }
  const suit = tile[tile.length - 1];
  const row = atlas.suitRows[suit];
  const col = Number(tile.slice(0, -1));
  if (
    row === undefined ||
    !Number.isInteger(col) ||
    col < 0 ||
    col >= atlas.cols ||
    row < 0 ||
    row >= atlas.rows
  ) {
    return atlas.backCell;
  }
  return { row, col };
}

/** Per-cell pixel size for a loaded atlas of natural size
 * `texW × texH`. Grid atlases divide by their grid; single-image
 * atlases return the whole texture size. */
export function atlasCellSize(
  atlas: AtlasDescriptor,
  texW: number,
  texH: number
): Size {
  if (atlas.kind === "grid") {
    return { w: texW / atlas.cols, h: texH / atlas.rows };
  }
  return { w: texW, h: texH };
}

/** Pixel sub-rectangle for a cell, inset on every side to keep
 * neighbouring cells from bleeding in when the sprite is downscaled. */
export function frameRect(
  cell: AtlasCell,
  cellW: number,
  cellH: number,
  inset = 0
): Rect {
  return {
    x: cell.col * cellW + inset,
    y: cell.row * cellH + inset,
    w: cellW - inset * 2,
    h: cellH - inset * 2,
  };
}

const SUITS = ["m", "p", "s", "z"] as const;
const SEAT_KEYS: readonly Seat[] = [0, 1, 2, 3];

function isRgb(n: unknown): boolean {
  return (
    typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= 0xffffff
  );
}

/**
 * Validate a tile design, returning a list of human-readable errors
 * (empty when valid). Checks atlas references resolve, grid atlases
 * are well-formed, categories/spacing/metrics are finite and
 * non-negative, and effects are in range. Precise per-area overlap
 * bounds are enforced by the area-layout tests, not here.
 */
export function validateTileDesign(design: TileDesign): string[] {
  const errors: string[] = [];
  const atlasIds = new Set(Object.keys(design.atlases));

  const ref = (id: AtlasId, where: string): void => {
    if (!atlasIds.has(id)) {
      errors.push(`sheets.${where} references unknown atlas "${id}"`);
    }
  };

  for (const [id, atlas] of Object.entries(design.atlases)) {
    if (atlas.kind === "grid") {
      if (atlas.cols <= 0 || atlas.rows <= 0) {
        errors.push(`atlas "${id}" has non-positive grid dimensions`);
      }
      for (const suit of SUITS) {
        const row = atlas.suitRows[suit];
        if (row === undefined || row < 0 || row >= atlas.rows) {
          errors.push(`atlas "${id}" has no valid row for suit "${suit}"`);
        }
      }
      const { row, col } = atlas.backCell;
      if (row < 0 || row >= atlas.rows || col < 0 || col >= atlas.cols) {
        errors.push(`atlas "${id}" backCell is out of grid bounds`);
      }
    }
  }

  ref(design.sheets.ownHand, "ownHand");
  ref(design.sheets.topHand, "topHand");
  for (const s of [1, 3] as const) {
    ref(design.sheets.sideHandBack[s], `sideHandBack[${s}]`);
    ref(design.sheets.sideHandFace[s], `sideHandFace[${s}]`);
  }
  for (const s of SEAT_KEYS) {
    ref(design.sheets.discard[s], `discard[${s}]`);
    ref(design.sheets.riichiDiscard[s], `riichiDiscard[${s}]`);
    ref(design.sheets.wallBack[s], `wallBack[${s}]`);
    ref(design.sheets.wallFace[s], `wallFace[${s}]`);
    ref(design.sheets.meld[s], `meld[${s}]`);
    ref(design.sheets.meldFaceDown[s], `meldFaceDown[${s}]`);
  }

  for (const [name, art] of Object.entries(design.categories)) {
    if (art.source.w <= 0 || art.source.h <= 0) {
      errors.push(`category "${name}" has non-positive source dimensions`);
    }
    if (!(art.scale > 0) || !Number.isFinite(art.scale)) {
      errors.push(`category "${name}" has a non-positive or infinite scale`);
    }
  }

  for (const [name, value] of Object.entries(design.spacing)) {
    if (!Number.isFinite(value) || value < 0) {
      errors.push(`spacing.${name} must be finite and non-negative`);
    }
  }

  if (design.metrics.sideHandBack.w <= 0 || design.metrics.sideHandBack.h <= 0) {
    errors.push("metrics.sideHandBack has non-positive dimensions");
  }
  if (design.metrics.topHand.w <= 0 || design.metrics.topHand.h <= 0) {
    errors.push("metrics.topHand has non-positive dimensions");
  }
  if (design.metrics.wallUpright.w <= 0 || design.metrics.wallUpright.h <= 0) {
    errors.push("metrics.wallUpright has non-positive dimensions");
  }
  if (
    design.metrics.wallSide.screenW <= 0 ||
    !(design.metrics.wallSide.aspect > 0)
  ) {
    errors.push("metrics.wallSide must have positive screenW and aspect");
  }

  if (!isRgb(design.effects.tsumogiriFreshTint)) {
    errors.push("effects.tsumogiriFreshTint must be a 0xRRGGBB value");
  }
  if (!isRgb(design.effects.waitTint)) {
    errors.push("effects.waitTint must be a 0xRRGGBB value");
  }
  if (
    !Number.isInteger(design.effects.tsumogiriFreshWindow) ||
    design.effects.tsumogiriFreshWindow < 1
  ) {
    errors.push("effects.tsumogiriFreshWindow must be an integer >= 1");
  }
  const shadow = design.effects.shadow;
  if (shadow) {
    for (const cat of ["small", "side", "big", "uprightSmall", "long"] as const) {
      if (!atlasIds.has(shadow[cat])) {
        errors.push(
          `effects.shadow.${cat} references unknown atlas "${shadow[cat]}"`
        );
      }
    }
    if (!Number.isFinite(shadow.offsetX) || !Number.isFinite(shadow.offsetY)) {
      errors.push("effects.shadow offsets must be finite");
    }
    if (!(shadow.depth > 0) || !Number.isFinite(shadow.depth)) {
      errors.push("effects.shadow.depth must be a positive number");
    }
    if (!(shadow.cap > 0 && shadow.cap <= 0.5)) {
      errors.push("effects.shadow.cap must be within (0, 0.5]");
    }
    if (shadow.uprightScale !== undefined && !(shadow.uprightScale > 0)) {
      errors.push("effects.shadow.uprightScale must be a positive number");
    }
    if (shadow.alpha !== undefined && !(shadow.alpha >= 0 && shadow.alpha <= 1)) {
      errors.push("effects.shadow.alpha must be within [0, 1]");
    }
  }

  return errors;
}

/** Throwing wrapper around {@link validateTileDesign}. */
export function assertValidTileDesign(design: TileDesign): TileDesign {
  const errors = validateTileDesign(design);
  if (errors.length > 0) {
    throw new Error(
      `Invalid tile design "${design.id}":\n- ${errors.join("\n- ")}`
    );
  }
  return design;
}
