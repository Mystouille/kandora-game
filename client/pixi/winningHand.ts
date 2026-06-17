export function splitWinningHandForDisplay(
  hand: string[],
  winTile: string | undefined,
  isTsumo: boolean
): { concealed: string[]; agari?: string } {
  const concealed = [...hand];

  if (!winTile) {
    return { concealed };
  }

  // Tsumo payloads are inconsistent across sources: some include the
  // drawn agari tile in `hand`, others expose it only via `winTile`.
  // Only strip a matching tile when the concealed length proves the
  // full self-drawn tile is already present.
  const handIncludesAgari = isTsumo && concealed.length % 3 === 2;
  if (handIncludesAgari) {
    const idx = concealed.lastIndexOf(winTile);
    if (idx >= 0) {
      concealed.splice(idx, 1);
    }
  }

  return { concealed, agari: winTile };
}
