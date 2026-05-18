/**
 * Buu Mahjong hand-end helpers — sinking detection, sankoro /
 * nikoro / chinmai chip distribution, immediate-sankoro-on-yakuman,
 * and the victory-legality checks (sinking-win-not-floating,
 * game-ending-win-not-first, game-ending-chinmai).
 *
 * The functions here are pure: they read a `MatchState` snapshot
 * (post-score-application) plus the hand result and return either
 * a per-seat chip delta or a legality verdict. `step.ts` is the
 * sole caller and is responsible for actually applying chip
 * deltas / reverting illegal wins.
 *
 * Every export checks `ruleSet.buuMode` (or a more specific flag)
 * before doing anything — under non-Buu rule sets all helpers are
 * no-ops so the rest of the engine is behaviorally unchanged.
 *
 * Cross-match concerns (dealer carryover, dabuken persistence
 * between matches, "winner starts dealer next game") live outside
 * the engine in the game-server orchestration layer.
 */

import type { MatchState } from "./state";
import type { RuleSet } from "./ruleSet";
import type { Seat } from "./types";

/** Per-seat chip delta. Sums to zero on a balanced sankoro/etc. */
export type ChipDelta = [number, number, number, number];

/** Result of `evaluateBuuHandEnd`. */
export interface BuuHandEndOutcome {
  /** Per-seat chip delta to add to `state.chips`. */
  chipDelta: ChipDelta;
  /** Number of seats counted as sinking (winner excluded). */
  sinkingCount: 0 | 1 | 2 | 3;
  /** Indices of sinking seats (winner excluded). */
  sinkingSeats: Seat[];
  /**
   * `true` when this hand awarded a dabuken to the winner. Granted
   * on any sankoro (three sinkers, including the yakuman-forced
   * promotion). Caller sets `state.dabuken[winner] = true`.
   */
  awardedDabuken: boolean;
  /**
   * `true` when this hand consumed the winner's dabuken (doubling
   * applied). Caller clears `state.dabuken[winner]` on consumption.
   */
  consumedDabuken: boolean;
  /**
   * `true` when this win must wipe every seat's dabuken token
   * before applying any new award. Always `true` for a legal win
   * (a seat's dabuken only survives by being re-awarded the same
   * hand). Caller resets `state.dabuken` to `[false, false, false, false]`.
   */
  clearAllDabuken: boolean;
}

const ZERO_DELTA: ChipDelta = [0, 0, 0, 0];

/**
 * Compute the chip delta for a winning hand, applying sankoro /
 * nikoro / chinmai distribution, the yakuman-immediate-sankoro
 * promotion, and the dabuken doubling. Pass the state AFTER the
 * point delta has been applied (sinking is measured on the
 * post-payment scores).
 *
 * Returns a zero outcome when `buuMode` is off so callers can
 * always invoke without a branch.
 */
export function evaluateBuuHandEnd(
  state: MatchState,
  winner: Seat,
  isYakuman: boolean
): BuuHandEndOutcome {
  const rs = state.ruleSet;
  if (!rs.buuMode) {
    return {
      chipDelta: [...ZERO_DELTA] as ChipDelta,
      sinkingCount: 0,
      sinkingSeats: [],
      awardedDabuken: false,
      consumedDabuken: false,
      clearAllDabuken: false,
    };
  }

  // Sinking detection on post-payment scores. Winner never counts
  // as sinking for chip-payout purposes (illegal-victory logic
  // handles the "winner is still sinking after winning" case).
  let sinkingSeats: Seat[];
  const yakumanForcedSankoro = isYakuman && rs.immediateSankoroOnYakuman;
  if (yakumanForcedSankoro) {
    sinkingSeats = ([0, 1, 2, 3] as Seat[]).filter((s) => s !== winner);
  } else {
    sinkingSeats = ([0, 1, 2, 3] as Seat[]).filter(
      (s) => s !== winner && state.scores[s] <= rs.sinkThreshold
    );
  }

  const sinkingCount = sinkingSeats.length as 0 | 1 | 2 | 3;
  const perSinker = chipPerSinker(rs, sinkingCount);

  const consumedDabuken = sinkingCount > 0 && state.dabuken[winner] === true;
  const multiplier = consumedDabuken ? 2 : 1;
  const payment = perSinker * multiplier;

  const chipDelta: ChipDelta = [0, 0, 0, 0];
  for (const s of sinkingSeats) {
    chipDelta[s] -= payment;
    chipDelta[winner] += payment;
  }

  // Dabuken bookkeeping. The token only survives a hand by being
  // re-awarded to the winner of that hand's sankoro; every legal
  // win therefore wipes every seat's previous token before any
  // new award is applied (so e.g. a non-winner's stale token is
  // cleared even when the winner just took a sankoro).
  const awardedDabuken = sinkingCount === 3;
  const clearAllDabuken = true;

  return {
    chipDelta,
    sinkingCount,
    sinkingSeats,
    awardedDabuken,
    consumedDabuken,
    clearAllDabuken,
  };
}

function chipPerSinker(rs: RuleSet, sinkingCount: 0 | 1 | 2 | 3): number {
  switch (sinkingCount) {
    case 0:
      return 0;
    case 1:
      return rs.chipPayouts.chinmai;
    case 2:
      return rs.chipPayouts.nikoro;
    case 3:
      return rs.chipPayouts.sankoro;
  }
}

/** Apply a chip delta in place. */
export function applyChipDelta(chips: ChipDelta, delta: ChipDelta): void {
  for (let s = 0; s < 4; s++) {
    chips[s] += delta[s];
  }
}

/**
 * Compute the end-of-game chip payout under the Buu rules.
 *
 * Called once when a game ends (round limit reached, a player
 * busts, or a player meets/exceeds `winnerThreshold`) — NOT
 * per hand. The winner is the seat with the highest final
 * `scores[s]`, ties broken by lowest seat index (closer-to-
 * dealer). Every OTHER seat whose final score is at or below
 * `ruleSet.sinkThreshold` counts as a sinker. The per-sinker
 * chip rate scales with how many seats sank:
 *   1 sinker  → `chipPayouts.chinmai`
 *   2 sinkers → `chipPayouts.nikoro`
 *   3 sinkers → `chipPayouts.sankoro`
 *
 * Dabuken bookkeeping also moves to end-of-game (it no longer
 * fires per hand). On settlement:
 *   - If the winner is currently holding a dabuken from a
 *     prior game in this session, it is CONSUMED and every
 *     chip transferred this settlement is doubled.
 *   - If the settlement is a sankoro (3 non-winners sank), a
 *     fresh dabuken is AWARDED to the winner to carry into
 *     the next game.
 *   - All other dabuken tokens are wiped on every settlement
 *     (caller resets `state.dabuken` first, then sets
 *     `state.dabuken[winner] = true` iff `awardedDabuken`).
 *
 * Returns the all-zero delta when `buuMode` is off or no
 * non-winner sank.
 */
export function evaluateBuuEndOfGameChips(state: MatchState): {
  chipDelta: ChipDelta;
  winner: Seat;
  sinkingSeats: Seat[];
  /** Per-sinker chip rate AFTER the optional dabuken doubling. */
  perSinker: number;
  /** True when the winner consumed a carried-over dabuken. */
  consumedDabuken: boolean;
  /** True when this settlement awards a fresh dabuken to the winner. */
  awardedDabuken: boolean;
} {
  const rs = state.ruleSet;
  const delta: ChipDelta = [0, 0, 0, 0];
  if (!rs.buuMode) {
    return {
      chipDelta: delta,
      winner: 0,
      sinkingSeats: [],
      perSinker: 0,
      consumedDabuken: false,
      awardedDabuken: false,
    };
  }
  let winner: Seat = 0;
  for (let s = 1; s < 4; s++) {
    if (state.scores[s] > state.scores[winner]) {
      winner = s as Seat;
    }
  }
  const sinkingSeats: Seat[] = [];
  for (let s = 0; s < 4; s++) {
    if (s === winner) {
      continue;
    }
    if (state.scores[s] <= rs.sinkThreshold) {
      sinkingSeats.push(s as Seat);
    }
  }
  const count = sinkingSeats.length as 0 | 1 | 2 | 3;
  const base = chipPerSinker(rs, count);
  const consumedDabuken = base > 0 && state.dabuken[winner] === true;
  const perSinker = consumedDabuken ? base * 2 : base;
  if (perSinker > 0) {
    for (const s of sinkingSeats) {
      delta[s] -= perSinker;
      delta[winner] += perSinker;
    }
  }
  const awardedDabuken = count === 3;
  return {
    chipDelta: delta,
    winner,
    sinkingSeats,
    perSinker,
    consumedDabuken,
    awardedDabuken,
  };
}

// ---------------------------------------------------------------------------
// Victory-legality checks
// ---------------------------------------------------------------------------

export type IllegalVictoryReason =
  | "sinking_win_not_floating"
  | "game_ending_win_not_first"
  | "game_ending_chinmai";

export interface VictoryLegalityResult {
  legal: boolean;
  reason: IllegalVictoryReason | null;
}

/**
 * Check whether a freshly-applied win is legal under the Buu
 * victory rules. Called AFTER the point delta has been applied
 * but BEFORE the chip delta. Returns `{legal: true}` immediately
 * when:
 *   - `buuMode` is off, or
 *   - this is the final hand of the match and
 *     `illegalVictoryAllLastOff` is true (all rules suspended).
 *
 * Otherwise, returns the first violated rule, in declaration order
 * matching `RuleSet.illegalVictoryRules`. The caller is expected
 * to treat a `legal: false` result as a chombo: revert the point
 * delta and apply `chipChomboPenalty`.
 *
 * Inputs:
 *   - `state`: AFTER the point delta has been applied (we read
 *     `state.scores` to compute sinking & ranking).
 *   - `winner`: seat that just won the hand.
 *   - `winnerWasSinking`: whether the winner's PRE-win score was
 *     at or below `sinkThreshold`. Caller supplies this because
 *     by the time we run, the winner's score has been credited.
 *   - `wouldEndMatch`: whether `shouldEndMatch` returns `ended:
 *     true` for this hand (computed by the caller from the same
 *     centralized helper used by `start_next_hand`).
 *   - `isFinalHand`: whether this is the last legal hand (all-last).
 */
export function checkBuuVictoryLegality(args: {
  state: MatchState;
  winner: Seat;
  winnerWasSinking: boolean;
  wouldEndMatch: boolean;
  isFinalHand: boolean;
}): VictoryLegalityResult {
  const { state, winner, winnerWasSinking, wouldEndMatch, isFinalHand } = args;
  const rs = state.ruleSet;
  if (!rs.buuMode) {
    return { legal: true, reason: null };
  }
  if (isFinalHand && rs.illegalVictoryAllLastOff) {
    return { legal: true, reason: null };
  }

  const rules = rs.illegalVictoryRules;
  const threshold = rs.sinkThreshold;
  const sinkingSeats = ([0, 1, 2, 3] as Seat[]).filter(
    (s) => state.scores[s] <= threshold
  );
  const winnerStillSinking = state.scores[winner] <= threshold;

  // Rule 1: sinking winner sinks another without floating themselves.
  // "Sinks another" means at least one non-winner is sinking post-win.
  if (rules.sinkingWinNotFloating && winnerWasSinking) {
    const otherSinkingExists = sinkingSeats.some((s) => s !== winner);
    if (otherSinkingExists && winnerStillSinking) {
      return { legal: false, reason: "sinking_win_not_floating" };
    }
  }

  // Rule 2: a win that ends the match where winner is not first.
  if (rules.gameEndingWinNotFirst && wouldEndMatch) {
    const winnerScore = state.scores[winner];
    const someoneStrictlyHigher = state.scores.some(
      (s, i) => i !== winner && s > winnerScore
    );
    if (someoneStrictlyHigher) {
      return { legal: false, reason: "game_ending_win_not_first" };
    }
  }

  // Rule 3: a win that ends the match with exactly one sinker
  // (chinmai). The winner is excluded from sinker count by the
  // very fact that they just won points, but we use the same
  // sinkingSeats filter on the post-win scores and exclude the
  // winner explicitly for symmetry with the chip-distribution
  // accounting.
  if (rules.gameEndingChinmai && wouldEndMatch) {
    const sinkersExclWinner = sinkingSeats.filter((s) => s !== winner).length;
    if (sinkersExclWinner === 1) {
      return { legal: false, reason: "game_ending_chinmai" };
    }
  }

  return { legal: true, reason: null };
}
