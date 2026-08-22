export type SeatNames = [string, string, string, string];

/** Merge non-empty incoming names without erasing names learned earlier. */
export function mergeSeatNames(
  current: SeatNames,
  incoming: readonly string[]
): SeatNames {
  const next: SeatNames = [...current];
  for (let seat = 0; seat < 4; seat++) {
    const name = incoming[seat]?.trim();
    if (name) {
      next[seat] = name;
    }
  }
  return next;
}