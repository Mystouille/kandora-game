/**
 * Distribute the scorer's base payments over the actual participants.
 * Honba, deposits and responsibility transfers remain the engine's concern.
 *
 * `oya` holds dealer-winner payments, `ko` non-dealer-winner payments.
 * For non-dealer tsumo, ko[0] is paid by the dealer, and ko[1] by each
 * other opponent. In Kansai ko[0] need not equal oya[0].
 */

import type { ScoreResult } from "./score";
import type { Seat } from "./types";
import type { PlayerCount, SeatValues } from "../protocol/seat";
import { activeSeats, isActiveSeat, seatValues } from "./seats";

export interface DistributeInput {
  /** Defaults to the legacy four-seat ledger. */
  playerCount?: PlayerCount;
  /** Computed score for the winning hand. */
  score: ScoreResult;
  /** Seat that won. */
  winner: Seat;
  /** Current dealer; used to determine dealer-vs-non-dealer payouts. */
  dealer: Seat;
  /** For ron: seat that discarded the winning tile. `null` for tsumo. */
  loser: Seat | null;
}

/**
 * Compute the per-seat point delta for a winning hand. Total over the
 * active seats sums to zero (payments balance).
 */
export function distributePayments(
  input: DistributeInput & { playerCount: 3 }
): [number, number, number];
// eslint-disable-next-line no-redeclare -- TypeScript overload preserves the legacy tuple return type.
export function distributePayments(
  input: DistributeInput & { playerCount?: 4 }
): [number, number, number, number];
// eslint-disable-next-line no-redeclare -- TypeScript overload for dynamic participant counts.
export function distributePayments(input: DistributeInput): SeatValues<number>;
// eslint-disable-next-line no-redeclare -- Implementation of the overloads above.
export function distributePayments(input: DistributeInput): SeatValues<number> {
  const { score, winner, dealer, loser, playerCount = 4 } = input;
  if (
    !isActiveSeat(winner, playerCount) ||
    !isActiveSeat(dealer, playerCount) ||
    (loser !== null && !isActiveSeat(loser, playerCount))
  ) {
    throw new Error(
      `Payment seats must be active in a ${playerCount}-player match`
    );
  }
  const delta = seatValues<number>(playerCount, () => 0);
  if (!score.isAgari) {
    return delta;
  }

  const winnerIsDealer = winner === dealer;

  if (loser !== null) {
    // Ron — lump-sum payment from the discarder.
    const payment = winnerIsDealer ? score.oya[0] : score.ko[0];
    delta[loser] -= payment;
    delta[winner] += payment;
    return delta;
  }

  const payments = winnerIsDealer ? score.oya : score.ko;
  for (const seat of activeSeats(playerCount)) {
    if (seat === winner) {
      continue;
    }
    const owed = winnerIsDealer || seat === dealer ? payments[0] : payments[1];
    delta[seat] -= owed;
    delta[winner] += owed;
  }
  return delta;
}
