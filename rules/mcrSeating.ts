import type { SeatValues } from "~/game/protocol/seat";
import { copySeatValues } from "./seats";
import type { Seat, Wind } from "./types";

const ADJACENT_PAIR_SWAP: SeatValues<Seat> = [1, 0, 3, 2];
const REVERSE_SEATS: SeatValues<Seat> = [3, 2, 1, 0];

export function mcrSeatPermutationAfterRound(
  roundWind: Wind
): SeatValues<Seat> | null {
  if (roundWind === "E" || roundWind === "W") {
    return copySeatValues(ADJACENT_PAIR_SWAP);
  }
  if (roundWind === "S") {
    return copySeatValues(REVERSE_SEATS);
  }
  return null;
}
