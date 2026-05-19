/**
 * End-of-match decision helper.
 *
 * Centralizes every reason the engine has for transitioning from
 * `hand_ended` straight to `match_ended` instead of starting the
 * next hand. Each branch is driven by a flag on the active
 * `RuleSet`, so different mahjong variants can opt in/out:
 *
 *   - `busted` (tobi): any seat's score is at or below
 *     `ruleSet.bustedScore`. Disabled when `bustedScore` is `null`.
 *   - `agari_yame`: dealer wins the final hand of the final round
 *     and the rule set opts into `agariYame`.
 *   - `tenpai_yame`: dealer is tenpai at the exhaustive draw of the
 *     final hand of the final round and the rule set opts into
 *     `tenpaiYame`.
 *   - `round_limit`: the configured number of round winds is
 *     exhausted and the dealer is not keeping. Always on.
 *
 * Checks are evaluated in the order above; the first match wins.
 * `start_next_hand` in `step.ts` is the sole caller.
 */

import type { Seat, Wind } from "./types";
import type { HandResult, MatchState } from "./state";

const WINDS: readonly Wind[] = ["E", "S", "W", "N"];

export type MatchEndReason =
  | "round_limit"
  | "busted"
  | "agari_yame"
  | "tenpai_yame"
  | "winner_threshold";

export type MatchEndDecision =
  | { ended: true; reason: MatchEndReason }
  | { ended: false };

/**
 * True iff the hand whose result is in `state` is the final hand of
 * the configured match (e.g. South 4 for a Tenhou hanchan).
 */
export function isFinalHandOfMatch(state: MatchState): boolean {
  const lastWindIdx = state.ruleSet.roundWindCount - 1;
  return (
    state.roundNumber === state.roundLimit &&
    WINDS.indexOf(state.roundWind) === lastWindIdx
  );
}

/**
 * Decide whether the match ends after the just-completed hand.
 *
 * Caller passes `dealerKeeps` because the engine has already
 * computed it from the rotation rules (dealer win, tenpai on
 * exhaustive draw, abort).
 */
export function shouldEndMatch(
  state: MatchState,
  result: HandResult,
  dealerKeeps: boolean
): MatchEndDecision {
  const rs = state.ruleSet;

  // Busted (tobi): any seat at or below the configured threshold
  // (or strictly below it when `bustedStrict` is on).
  if (rs.bustedScore !== null) {
    const threshold = rs.bustedScore;
    const isBusted = rs.bustedStrict
      ? (s: number) => s < threshold
      : (s: number) => s <= threshold;
    if (state.scores.some(isBusted)) {
      return { ended: true, reason: "busted" };
    }
  }

  // Winner-threshold (Buu "floating to victory"): any seat at or
  // above the configured threshold ends the match. Evaluated
  // strictly after the busted check so a single hand that both
  // floats the winner and sinks a loser ends as `busted` (which
  // happens to be the same outcome semantically, but keeps the
  // event taxonomy stable).
  if (rs.winnerThreshold !== null) {
    const wt = rs.winnerThreshold;
    if (state.scores.some((s) => s >= wt)) {
      return { ended: true, reason: "winner_threshold" };
    }
  }

  // Agari-yame: dealer wins the final hand of the final round.
  //
  // Buu Mahjong twist: when `buuMode` is on, agari-yame only fires
  // on a *sankoro* win (the three non-dealer seats all end at or
  // below `sinkThreshold` after the payment — or any yakuman win
  // under `immediateSankoroOnYakuman`, which force-promotes to a
  // sankoro). Any other dealer win on the final hand falls through,
  // so the dealer keeps (renchan) and gets another shot at a
  // sankoro instead of ending the game on a regular win.
  if (
    rs.agariYame &&
    isFinalHandOfMatch(state) &&
    (result.reason === "tsumo" || result.reason === "ron") &&
    result.winner === state.dealer
  ) {
    if (rs.buuMode) {
      const yakumanForcedSankoro =
        result.winYakuman === true && rs.immediateSankoroOnYakuman;
      const sinkerCount = yakumanForcedSankoro
        ? 3
        : ([0, 1, 2, 3] as Seat[]).filter(
            (s) => s !== result.winner && state.scores[s] <= rs.sinkThreshold
          ).length;
      if (sinkerCount === 3) {
        return { ended: true, reason: "agari_yame" };
      }
      // Not a sankoro: fall through so the dealer renchans.
    } else {
      return { ended: true, reason: "agari_yame" };
    }
  }

  // Tenpai-yame: dealer tenpai at exhaustive draw of the final hand.
  if (
    rs.tenpaiYame &&
    isFinalHandOfMatch(state) &&
    result.reason === "exhaustive_draw" &&
    result.tenpai !== null &&
    result.tenpai[state.dealer]
  ) {
    return { ended: true, reason: "tenpai_yame" };
  }

  // Round-limit: configured rounds exhausted and the dealer isn't
  // staying. Honba-only continuations on the final hand do not end
  // the match here.
  if (isFinalHandOfMatch(state) && !dealerKeeps) {
    return { ended: true, reason: "round_limit" };
  }

  return { ended: false };
}
