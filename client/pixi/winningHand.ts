export function splitWinningHandForDisplay(
  hand: string[],
  winTile: string | undefined
): { concealed: string[]; agari?: string } {
  const concealed = [...hand];

  if (!winTile) {
    return { concealed };
  }

  // Platform payloads are inconsistent: some include the agari tile in
  // `hand`, others expose it only via `winTile`. A complete concealed
  // portion has length 2 mod 3 even when open melds reduce its size.
  const handIncludesAgari = concealed.length % 3 === 2;
  if (handIncludesAgari) {
    const idx = concealed.lastIndexOf(winTile);
    if (idx >= 0) {
      concealed.splice(idx, 1);
    }
  }

  return { concealed, agari: winTile };
}
