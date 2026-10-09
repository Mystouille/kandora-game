import type { PlayerCount, Seat, SeatValues } from "../protocol/seat";
import type { Wind } from "./types";

export type { PlayerCount, SeatValues } from "../protocol/seat";

const THREE_SEATS = [0, 1, 2] as const;
const FOUR_SEATS = [0, 1, 2, 3] as const;
const WINDS = ["E", "S", "W", "N"] as const;

export function activeSeats(count: PlayerCount): readonly Seat[] {
  if (count === 3) {
    return THREE_SEATS;
  }
  if (count === 4) {
    return FOUR_SEATS;
  }
  throw new Error(`A match requires 3 or 4 players, got ${count}`);
}

export function isActiveSeat(seat: number, count: PlayerCount): seat is Seat {
  return Number.isInteger(seat) && seat >= 0 && seat < count;
}

export function nextSeat(seat: Seat, count: PlayerCount): Seat {
  if (!isActiveSeat(seat, count)) {
    throw new Error(`Seat ${seat} is not active in a ${count}-player match`);
  }
  return ((seat + 1) % count) as Seat;
}

export function seatDistance(from: Seat, to: Seat, count: PlayerCount): number {
  if (!isActiveSeat(from, count) || !isActiveSeat(to, count)) {
    throw new Error(
      `Invalid seat distance ${from} -> ${to} for ${count} players`
    );
  }

  return (to - from + count) % count;
}

export function windForSeat(
  seat: Seat,
  dealer: Seat,
  count: PlayerCount
): Wind {
  return WINDS[seatDistance(dealer, seat, count)];
}

export function participantCount(values: readonly unknown[]): PlayerCount {
  if (values.length !== 3 && values.length !== 4) {
    throw new Error(`A match requires 3 or 4 players, got ${values.length}`);
  }
  return values.length;
}

export function copySeatValues<T>(values: readonly T[]): SeatValues<T> {
  return mapSeatValues(values, (value) => value);
}

export function permuteSeatValues<T>(
  values: readonly T[],
  permutation: readonly Seat[]
): SeatValues<T> {
  const count = participantCount(values);
  if (
    permutation.length !== count ||
    new Set(permutation).size !== count ||
    permutation.some((seat) => !isActiveSeat(seat, count))
  ) {
    throw new Error("Expected a complete active-seat permutation");
  }
  return seatValues(count, (seat) => values[permutation[seat]]);
}

export function seatValues<T>(
  count: PlayerCount,
  create: (seat: Seat) => T
): SeatValues<T> {
  const first: [T, T, T] = [create(0), create(1), create(2)];
  if (count === 3) {
    return first;
  }
  if (count === 4) {
    return [...first, create(3)];
  }
  throw new Error(`A match requires 3 or 4 players, got ${count}`);
}

export function mapSeatValues<T, U>(
  values: readonly T[],
  map: (value: T, seat: Seat) => U
): SeatValues<U> {
  return seatValues(participantCount(values), (seat) =>
    map(values[seat], seat)
  );
}
