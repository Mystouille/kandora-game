/**
 * Payment distribution — translates a `ScoreResult` from the riichi
 * lib (per-payer amounts already computed) into a per-seat delta.
 *
 * Phase 1 step 5a covers basic tsumo and ron payments only.
 * Honba (300/honba) and riichi stick transfer ship with 5b alongside
 * riichi declaration.
 *
 * Riichi lib output (`oya`, `ko`, `ten`) semantics, distilled from
 * `node_modules/riichi/index.js` lines ~310–325:
 *
 *   Tsumo (regardless of who wins):
 *     oya = [base*2, base*2, base*2]
 *     ko  = [base*2, base, base]
 *   Ron:
 *     oya = [base*6]    // (dealer-winner total)
 *     ko  = [base*4]    // (non-dealer-winner total)
 *
 *   When the dealer wins:
 *     - tsumo: each of 3 non-dealers pays `oya[0]`.
 *     - ron: the discarder pays `oya[0]`.
 *   When a non-dealer wins:
 *     - tsumo: the dealer pays `oya[0]`; the two other non-dealers
 *       pay `ko[1]` each (== `ko[2]`).
 *     - ron: the discarder pays `ko[0]`.
 */

import type { ScoreResult } from "./score";
import type { Seat } from "./types";

export interface DistributeInput {
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
 * four seats sums to zero (payments balance).
 */
export function distributePayments(
  input: DistributeInput
): [number, number, number, number] {
  const { score, winner, dealer, loser } = input;
  const delta: [number, number, number, number] = [0, 0, 0, 0];
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

  // Tsumo.
  if (winnerIsDealer) {
    // Each of the three non-dealers pays oya[0].
    const each = score.oya[0];
    for (let s = 0; s < 4; s++) {
      if (s === winner) {
        continue;
      }
      delta[s] -= each;
      delta[winner] += each;
    }
    return delta;
  }

  // Non-dealer tsumo: dealer pays oya[0], each non-dealer pays ko[1].
  const fromDealer = score.oya[0];
  const fromNonDealer = score.ko[1];
  for (let s = 0; s < 4; s++) {
    if (s === winner) {
      continue;
    }
    const seat = s as Seat;
    const owed = seat === dealer ? fromDealer : fromNonDealer;
    delta[seat] -= owed;
    delta[winner] += owed;
  }
  return delta;
}
