import type { MatchPhase } from "~/game/rules/state";
import type { Seat } from "~/game/rules/types";

export type DuplicateDrawCounts = [number, number, number, number];

export interface DuplicateExhaustionForecast {
  limitingSeat: Seat;
  /** Successful draws before `limitingSeat` next attempts an empty queue. */
  estimatedDrawsRemaining: number;
}

export interface DuplicateExhaustionContext {
  phase: MatchPhase;
  turn: Seat;
  pendingReplacementSeat: Seat | null;
}

export function estimateDuplicateExhaustionFromNextDrawer(
  remaining: DuplicateDrawCounts,
  nextDrawer: Seat
): DuplicateExhaustionForecast {
  let limitingSeat: Seat = nextDrawer;
  let estimatedDrawsRemaining = Number.POSITIVE_INFINITY;
  for (let seatIndex = 0; seatIndex < 4; seatIndex++) {
    const seat = seatIndex as Seat;
    const offset = (seat - nextDrawer + 4) % 4;
    const emptyDrawAttempt = remaining[seat] * 4 + offset;
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
    context.phase === "hand_ended" ||
    context.phase === "match_ended"
  ) {
    return null;
  }
  if (context.phase === "awaiting_chankan") {
    const declarer = context.pendingReplacementSeat;
    if (declarer === null) {
      return null;
    }
    if (remaining[declarer] === 0) {
      return { limitingSeat: declarer, estimatedDrawsRemaining: 0 };
    }
    const afterReplacement = [...remaining] as DuplicateDrawCounts;
    afterReplacement[declarer] -= 1;
    const after = estimateDuplicateExhaustionFromNextDrawer(
      afterReplacement,
      ((declarer + 1) % 4) as Seat
    );
    return {
      limitingSeat: after.limitingSeat,
      estimatedDrawsRemaining: after.estimatedDrawsRemaining + 1,
    };
  }
  const nextDrawer =
    context.phase === "awaiting_draw"
      ? context.turn
      : (((context.turn + 1) % 4) as Seat);
  return estimateDuplicateExhaustionFromNextDrawer(remaining, nextDrawer);
}