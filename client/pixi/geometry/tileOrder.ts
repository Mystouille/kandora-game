const SUIT_ORDER: Record<string, number> = { m: 0, p: 1, s: 2, z: 3 };

export function tileSortKey(tile: string): number {
  const suit = tile[tile.length - 1];
  const n = Number(tile.slice(0, -1));
  const suitWeight = (SUIT_ORDER[suit] ?? 9) * 100;
  const numWeight = n === 0 ? 5.5 : n;
  return suitWeight + numWeight;
}

export function sortTilesForDisplay(tiles: readonly string[]): string[] {
  return [...tiles].sort((a, b) => tileSortKey(a) - tileSortKey(b));
}

export function ankanTilesForDisplay(tiles: readonly string[]): string[] {
  const ordered = sortTilesForDisplay(tiles);
  const redIndex = ordered.findIndex((tile) => /^0[mps]$/.test(tile));
  if (redIndex < 0 || ordered.length < 3) {
    return ordered;
  }
  const [redFive] = ordered.splice(redIndex, 1);
  ordered.splice(1, 0, redFive);
  return ordered;
}

/** A fresh draw stays last; any redaction leaves the original strip untouched. */
export function sortHand(
  hand: Array<string | null>,
  isFreshlyDrawn: boolean
): Array<string | null> {
  if (hand.some((t) => t === null)) {
    return hand;
  }
  const tiles = hand as string[];
  if (isFreshlyDrawn && tiles.length >= 2) {
    const closed = tiles.slice(0, tiles.length - 1);
    const drawn = tiles[tiles.length - 1];
    closed.sort((a, b) => tileSortKey(a) - tileSortKey(b));
    return [...closed, drawn];
  }
  return [...tiles].sort((a, b) => tileSortKey(a) - tileSortKey(b));
}

export function tileNum(tile: string): string {
  if (tile === "0m" || tile === "0p" || tile === "0s") {
    return "5";
  }
  if (tile.endsWith("z")) {
    return tile;
  }
  return tile.slice(0, -1);
}
