export interface MeldStripGroupPlacement {
  x: number;
  y: number;
}

export interface MeldStripGroupBounds {
  minY: number;
  maxY: number;
}

export function layoutTouchingMeldColumn(
  widths: readonly number[],
  bounds: readonly MeldStripGroupBounds[]
): { placements: MeldStripGroupPlacement[]; width: number } {
  if (widths.length !== bounds.length) {
    throw new Error("Meld widths and bounds must have the same length");
  }
  const width = Math.max(0, ...widths);
  const offsets = new Array<number>(widths.length).fill(0);
  for (let index = widths.length - 2; index >= 0; index -= 1) {
    offsets[index] =
      offsets[index + 1] + bounds[index + 1].minY - bounds[index].maxY;
  }
  return {
    width,
    placements: widths.map((groupWidth, index) => ({
      x: width - groupWidth,
      y: offsets[index],
    })),
  };
}

export function layoutMeldStripGroups(
  widths: readonly number[],
  gap: number
): { placements: MeldStripGroupPlacement[]; width: number } {
  let cursor = 0;
  const placements = widths.map((groupWidth) => {
    const placement = { x: cursor, y: 0 };
    cursor += groupWidth + gap;
    return placement;
  });
  return {
    placements,
    width: widths.length > 0 ? cursor - gap : 0,
  };
}
