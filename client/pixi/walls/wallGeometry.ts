import type { TableLayout } from "../tableLayout";
import type { Seat, Size } from "../tableGeometry";

export interface WallPlanMetrics {
  upright: Size;
  side: { screenW: number; aspect: number };
  sideOverlap: number;
}

export interface WallTileGeometry {
  width: number;
  height: number;
  longDimension: number;
  crossDimension: number;
  stride: number;
}

const ROW_OFFSET_Y = 16;
const WALL_REVEAL_ROW_OVERLAP = 16;

export function wallTileGeometry(
  metrics: WallPlanMetrics,
  seat: Seat
): WallTileGeometry {
  const isHorizontal = seat % 2 === 0;
  const width = isHorizontal ? metrics.upright.w : metrics.side.screenW;
  const height = isHorizontal
    ? metrics.upright.h
    : metrics.side.screenW * metrics.side.aspect;
  return {
    width,
    height,
    longDimension: isHorizontal ? width : height,
    crossDimension: isHorizontal ? height : width,
    stride: isHorizontal ? width : height - metrics.sideOverlap,
  };
}

export function centeredWallRunOffset(
  band: TableLayout["wall"][number],
  seat: Seat,
  slotCount: number,
  geometry: WallTileGeometry
): number {
  const bandLength = seat % 2 === 0 ? band.w : band.h;
  const runLength =
    slotCount <= 0
      ? 0
      : geometry.longDimension + (slotCount - 1) * geometry.stride;
  return Math.max(0, (bandLength - runLength) / 2);
}

export function wallTilePosition(input: {
  seat: Seat;
  row: 0 | 1;
  longOffset: number;
  geometry: WallTileGeometry;
  band: TableLayout["wall"][number];
  showWalls: boolean;
}): { x: number; y: number } {
  const { seat, row, longOffset, geometry, band, showWalls } = input;
  const isHorizontal = seat % 2 === 0;
  const bandCrossDimension = isHorizontal ? band.h : band.w;
  const crossAtEnd = seat === 2 || seat === 3;
  const crossInset = crossAtEnd
    ? bandCrossDimension - geometry.crossDimension
    : 0;

  if (showWalls) {
    const rowOverlap = isHorizontal ? WALL_REVEAL_ROW_OVERLAP : 0;
    const outerOffset =
      row === 0 ? geometry.crossDimension - rowOverlap : 0;
    const sideLift = isHorizontal ? 0 : -8;
    if (seat === 0) {
      return { x: band.x + longOffset, y: band.y + outerOffset };
    }
    if (seat === 1) {
      return {
        x: band.x + outerOffset,
        y: band.y + band.h - geometry.longDimension - longOffset + sideLift,
      };
    }
    if (seat === 2) {
      return {
        x: band.x + band.w - geometry.longDimension - longOffset,
        y:
          band.y +
          bandCrossDimension -
          geometry.crossDimension -
          outerOffset,
      };
    }
    return {
      x: band.x + bandCrossDimension - geometry.crossDimension - outerOffset,
      y: band.y + longOffset + sideLift,
    };
  }

  if (seat === 0) {
    return {
      x: band.x + longOffset,
      y:
        band.y +
        16 +
        crossInset +
        (row === 0 ? ROW_OFFSET_Y / 2 : -ROW_OFFSET_Y / 2),
    };
  }
  if (seat === 1) {
    return {
      x: band.x + crossInset + 8,
      y:
        band.y +
        band.h -
        geometry.longDimension -
        longOffset -
        (row === 1 ? ROW_OFFSET_Y : 0),
    };
  }
  if (seat === 2) {
    return {
      x: band.x + band.w - geometry.longDimension - longOffset,
      y:
        band.y +
        crossInset +
        (row === 0 ? ROW_OFFSET_Y / 2 : -ROW_OFFSET_Y / 2),
    };
  }
  return {
    x: band.x + crossInset,
    y: band.y + longOffset - (row === 1 ? ROW_OFFSET_Y : 0),
  };
}

export function wallTileZIndex(
  seat: Seat,
  groupSlotIndex: number,
  maximumGroupSlotIndex: number,
  row: 0 | 1,
  showWalls: boolean
): number {
  let crossZ = 0;
  if (seat === 1) {
    crossZ = maximumGroupSlotIndex - groupSlotIndex;
  } else if (seat === 3) {
    crossZ = groupSlotIndex;
  }
  const rowZ = showWalls && seat !== 2 ? 1 - row : row;
  return rowZ * 100 + crossZ;
}