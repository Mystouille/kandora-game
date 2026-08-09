/**
 * Pure area-layout for tile-bearing zones. Produces plain
 * {@link TilePlacement} data (no Pixi) that the renderer materializes
 * via the sprite factory, so the geometry is unit-testable without a
 * canvas.
 *
 * First consumer: discards. `layoutDiscards` reproduces exactly the
 * geometry previously inlined in `renderSeat` — row wrapping, per-seat
 * strides/overlaps, riichi posture, and z-order — in container-local
 * coordinates. The container itself is still positioned by the caller
 * via the seat transform; tint and the last-discard animation stay in
 * the renderer.
 */
import { isSideSeat, type Seat, type Size } from "./tableGeometry";
import {
  sideScreen,
  smallScreen,
  type AtlasId,
  type TileDesign,
} from "./tiles/tileDesign";

/** Sprite transform within its wrap container (design px, radians). */
export interface SpritePlacement {
  width: number;
  height: number;
  rotation: number;
  x: number;
  y: number;
}

/** One tile's placement in an area's container-local space. */
export interface TilePlacement {
  index: number;
  tile: string | null;
  atlasId: AtlasId;
  isRiichi: boolean;
  zIndex: number;
  /** Wrap-container transform (container-local). */
  wrap: { x: number; y: number; rotation: number };
  /** Sprite transform inside the wrap. */
  sprite: SpritePlacement;
}

const CONTAINER_ROTATIONS = [0, -Math.PI / 2, Math.PI, Math.PI / 2] as const;
const DISCARD_COLS = 6;

/** Normalise `-0` to `0` so placements compare cleanly. */
const nz = (n: number): number => (n === 0 ? 0 : n);

/** Container-local footprint of one non-riichi discard tile. Row
 * stride uses its height; row-direction stride uses its width. */
export function discardCellSize(design: TileDesign, seat: Seat): Size {
  const small = smallScreen(design);
  const side = sideScreen(design);
  const bump = design.metrics.discardUprightBump;
  if (isSideSeat(seat)) {
    return { w: side.h, h: side.w };
  }
  return { w: small.w + bump, h: ((small.w + bump) * small.h) / small.w };
}

/**
 * Container-local placements for a seat's discard pond. Mirrors the
 * legacy `renderSeat` discard loop tile-for-tile; the caller applies
 * the fresh-discard nudge and animation overlay to the last tile.
 */
export function layoutDiscards(
  design: TileDesign,
  seat: Seat,
  discards: ReadonlyArray<string | null>,
  riichiIdx: number | null
): TilePlacement[] {
  const small = smallScreen(design);
  const side = sideScreen(design);
  const overlapHoriz = design.spacing.discardRowHoriz;
  const overlapVert = design.spacing.discardRowVert;
  const discardSheet = design.sheets.discard[seat];
  const riichiSheet = design.sheets.riichiDiscard[seat];
  const spriteCounterRot = nz(-CONTAINER_ROTATIONS[seat]);
  const isHoriz = isSideSeat(seat);

  const cell = discardCellSize(design, seat);
  const tileLocalW = cell.w;
  const tileLocalH = cell.h;
  const rowStride = tileLocalH - (isHoriz ? 0 : overlapVert);
  const tileStride = tileLocalW - (isHoriz ? overlapHoriz : 0);
  const riichiStride = isHoriz ? small.h - overlapHoriz : side.w;

  const out: TilePlacement[] = [];
  let cursorX = 0;
  let cursorRow = 0;
  discards.forEach((tile, i) => {
    const row = Math.min(2, Math.floor(i / DISCARD_COLS));
    if (row !== cursorRow) {
      cursorRow = row;
      cursorX = 0;
    }
    const isRiichi = i === riichiIdx;
    const withinRowZ = seat === 1 ? -i : seat === 3 ? i : 0;
    const zIndex = (seat === 2 ? -row : row) * 1000 + withinRowZ;
    const atlasId = isRiichi ? riichiSheet : discardSheet;
    const rowY = row * rowStride;

    let sprite: SpritePlacement;
    let wrap: { x: number; y: number; rotation: number };

    if (isRiichi && isHoriz) {
      sprite = {
        width: small.w,
        height: small.h,
        rotation: seat === 3 ? Math.PI : 0,
        x: tileLocalH / 2,
        y: small.h / 2,
      };
      // Nudge the sideways tile toward the shadow-side (outer) edge so
      // its outer edge sits flush with the upright neighbours' (cross
      // footprint small.w vs the upright tileLocalH). Sign flips per
      // side: screen-right maps to +local-y (seat 1) / -local-y (seat 3).
      const outerShift = ((tileLocalH - small.w) / 2) * (seat === 1 ? 1 : -1);
      wrap = {
        x: cursorX + small.h,
        y: rowY + outerShift,
        rotation: Math.PI / 2,
      };
      cursorX += riichiStride;
    } else if (isRiichi) {
      sprite = {
        width: side.w,
        height: side.h,
        rotation: spriteCounterRot,
        x: side.w / 2,
        y: tileLocalH / 2,
      };
      wrap = { x: cursorX, y: rowY, rotation: 0 };
      cursorX += riichiStride;
    } else if (isHoriz) {
      sprite = {
        width: tileLocalH,
        height: tileLocalW,
        rotation: spriteCounterRot,
        x: tileLocalW / 2,
        y: tileLocalH / 2,
      };
      wrap = { x: cursorX, y: rowY, rotation: 0 };
      cursorX += tileStride;
    } else {
      sprite = {
        width: tileLocalW,
        height: tileLocalH,
        rotation: spriteCounterRot,
        x: tileLocalW / 2,
        y: tileLocalH / 2,
      };
      wrap = { x: cursorX, y: rowY, rotation: 0 };
      cursorX += tileStride;
    }

    out.push({ index: i, tile, atlasId, isRiichi, zIndex, wrap, sprite });
  });
  return out;
}

/** Inputs for concealable-hand layout that depend on renderer state. */
export interface HandRevealOptions {
  /** Whether opponent tiles may be shown (showHands or a forced
   * win/tenpai reveal). Per-tile reveal also requires a known tile. */
  canReveal: boolean;
  isFreshlyDrawn: boolean;
  /** Slot left blank while its tile animates into the pond, or null. */
  hiddenSlot: number | null;
}

/**
 * Container-local placements for a side seat's concealed/revealed
 * hand (seats 1/3). Mirrors the legacy `renderSeat` side-hand loop:
 * face-down `sideHand*` art by default, or the seat's discard face
 * sheet when revealed, stacked with the matching overlap. Wait-tint
 * is applied by the caller (safe to call for the `null` back tiles).
 */
export function layoutSideHand(
  design: TileDesign,
  seat: 1 | 3,
  hand: ReadonlyArray<string | null>,
  opts: HandRevealOptions
): TilePlacement[] {
  const side = sideScreen(design);
  const back = design.metrics.sideHandBack;
  const backSheet = design.sheets.sideHandBack[seat];
  const faceSheet = design.sheets.sideHandFace[seat];
  const localRot = seat === 1 ? Math.PI / 2 : -Math.PI / 2;
  const zSign = seat === 1 ? -1 : 1;
  const stripRevealed = opts.canReveal && hand.some((t) => t !== null);
  const stride = stripRevealed
    ? side.h - design.spacing.discardRowHoriz
    : back.h - design.spacing.sideHand;
  const handGap = opts.isFreshlyDrawn ? design.spacing.tsumoGap : 0;
  const last = hand.length - 1;

  const out: TilePlacement[] = [];
  hand.forEach((tile, i) => {
    if (i === opts.hiddenSlot) {
      return;
    }
    const reveal = opts.canReveal && tile !== null;
    const extraGap = handGap > 0 && i === last ? handGap : 0;
    const wrap = { x: i * stride + extraGap, y: 0, rotation: 0 };
    const zIndex = nz(zSign * i);
    let atlasId: AtlasId;
    let placedTile: string | null;
    let sprite: SpritePlacement;
    if (reveal) {
      atlasId = faceSheet;
      placedTile = tile;
      sprite = {
        width: side.w,
        height: side.h,
        rotation: -localRot + Math.PI,
        x: side.h / 2,
        y: side.w / 2,
      };
    } else {
      atlasId = backSheet;
      placedTile = null;
      sprite = {
        width: back.w,
        height: back.h,
        rotation: localRot,
        x: back.h / 2,
        y: back.w / 2,
      };
    }
    out.push({
      index: i,
      tile: placedTile,
      atlasId,
      isRiichi: false,
      zIndex,
      wrap,
      sprite,
    });
  });
  return out;
}

/**
 * Container-local placements for the top seat's hand (seat 2):
 * face-down `topSmall` backs rotated 180°, or the face cell when
 * revealed. The slot pitch is the tile width; no interaction.
 */
export function layoutTopHand(
  design: TileDesign,
  hand: ReadonlyArray<string | null>,
  opts: HandRevealOptions
): TilePlacement[] {
  const t = design.metrics.topHand;
  const sheet = design.sheets.topHand;
  const handGap = opts.isFreshlyDrawn ? design.spacing.tsumoGap : 0;
  const last = hand.length - 1;

  const out: TilePlacement[] = [];
  hand.forEach((tile, i) => {
    if (i === opts.hiddenSlot) {
      return;
    }
    const reveal = opts.canReveal && tile !== null;
    const extraGap = handGap > 0 && i === last ? handGap : 0;
    out.push({
      index: i,
      tile: reveal ? tile : null,
      atlasId: sheet,
      isRiichi: false,
      zIndex: 0,
      wrap: { x: i * t.w + extraGap, y: 0, rotation: 0 },
      sprite: {
        width: t.w,
        height: t.h,
        rotation: Math.PI,
        x: t.w / 2,
        y: t.h / 2,
      },
    });
  });
  return out;
}

/**
 * Meld-strip-local tile footprint for a seat. Local +x is the
 * strip's reading direction; after the strip's per-seat rotation the
 * on-screen size matches the seat's discard tile. Side seats (1/3)
 * swap axes because the container rotates ±π/2.
 */
export function meldTileDims(design: TileDesign, seat: number): Size {
  if (seat === 1 || seat === 3) {
    const side = sideScreen(design);
    return { w: side.h, h: side.w };
  }
  const small = smallScreen(design);
  return { w: small.w, h: small.h };
}
