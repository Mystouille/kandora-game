import { type SeatValues } from "~/game/protocol/seat";
import type { Seat } from "~/game/protocol/messages";
import {
  activeSeats,
  copySeatValues,
  type PlayerCount,
} from "~/game/rules/seats";

export function deterministicShuffle<T>(
  items: readonly T[],
  seed: number
): T[] {
  let s = seed >>> 0;
  const next = (): number => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function waitingRoomSeatPermutation(
  seed: number,
  playerCount: PlayerCount = 4
): SeatValues<Seat> {
  return copySeatValues(
    deterministicShuffle<Seat>(activeSeats(playerCount), seed)
  );
}
