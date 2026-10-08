import type { PlayerCount, SeatValues } from "~/game/protocol/seat";
import { seatValues } from "~/game/rules/seats";

export type SeatNames = SeatValues<string>;

/** Merge non-empty incoming names without erasing names learned earlier. */
export function mergeSeatNames(
  current: SeatNames,
  incoming: readonly string[],
  playerCount: PlayerCount = current.length
): SeatNames {
  const next = seatValues(playerCount, (seat) => current[seat] ?? "");
  for (let seat = 0; seat < playerCount; seat++) {
    const name = incoming[seat]?.trim();
    if (name) {
      next[seat] = name;
    }
  }
  return next;
}
