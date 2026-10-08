import { copySeatValues } from "~/game/rules/seats";
import { type SeatValues } from "~/game/protocol/seat";
import type { MatchPhase } from "~/game/rules/state";
import type { Seat } from "~/game/rules/types";
import { nextSeat, seatDistance } from "~/game/rules/seats";

export type DuplicateDrawCounts = SeatValues<number>;

export interface DuplicateExhaustionForecast {
  limitingSeat: Seat;
  /** Successful draws before `limitingSeat` next attempts an empty queue. */
  estimatedDrawsRemaining: number;
}

export interface DuplicateExhaustionContext {
  phase: MatchPhase;
  turn: Seat;
  pendingReplacementSeat: Seat | null;
  pendingOpeningReplacement?: boolean;
}

export function estimateDuplicateExhaustionFromNextDrawer(
  remaining: DuplicateDrawCounts,
  nextDrawer: Seat
): DuplicateExhaustionForecast {
  let limitingSeat: Seat = nextDrawer;
  let estimatedDrawsRemaining = Number.POSITIVE_INFINITY;
  for (let seatIndex = 0; seatIndex < remaining.length; seatIndex++) {
    const seat = seatIndex as Seat;
    const offset = seatDistance(nextDrawer, seat, remaining.length);
    const emptyDrawAttempt = remaining[seat] * remaining.length + offset;
    if (emptyDrawAttempt < estimatedDrawsRemaining) {
      limitingSeat = seat;
      estimatedDrawsRemaining = emptyDrawAttempt;
    }
  }
  return { limitingSeat, estimatedDrawsRemaining };
}

export function estimateDuplicateExhaustion(
  remaining: DuplicateDrawCounts,
  context: DuplicateExhaustionContext
): DuplicateExhaustionForecast | null {
  if (
    context.phase === "awaiting_ryuukyoku_declarations" ||
    context.phase === "awaiting_ryuukyoku_settlement" ||
    context.phase === "hand_ended" ||
    context.phase === "match_ended"
  ) {
    return null;
  }
  if (
    context.phase === "awaiting_chankan" ||
    context.phase === "awaiting_nuki_replacement"
  ) {
    const declarer = context.pendingReplacementSeat;
    if (declarer === null) {
      return null;
    }
    if (remaining[declarer] === 0) {
      return { limitingSeat: declarer, estimatedDrawsRemaining: 0 };
    }
    const afterReplacement = copySeatValues(remaining);
    afterReplacement[declarer] -= 1;
    const after = estimateDuplicateExhaustionFromNextDrawer(
      afterReplacement,
      context.pendingOpeningReplacement
        ? context.turn
        : nextSeat(declarer, remaining.length)
    );
    return {
      limitingSeat: after.limitingSeat,
      estimatedDrawsRemaining: after.estimatedDrawsRemaining + 1,
    };
  }
  const nextDrawer =
    context.phase === "awaiting_draw"
      ? context.turn
      : nextSeat(context.turn, remaining.length);
  return estimateDuplicateExhaustionFromNextDrawer(remaining, nextDrawer);
}
