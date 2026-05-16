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
 *   - `mangan_end`: a win scored mangan-or-better and the rule set
 *     opts into `manganEnds` (Buu and some house rules).
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

import type { Wind } from "./types";
import type { HandResult, MatchState } from "./state";

const WINDS: readonly Wind[] = ["E", "S", "W", "N"];

export type MatchEndReason =
  | "round_limit"
  | "busted"
  | "agari_yame"
  | "tenpai_yame"
  | "mangan_end";

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

  // Busted (tobi): any seat at or below the configured threshold.
  if (rs.bustedScore !== null) {
    const threshold = rs.bustedScore;
    if (state.scores.some((s) => s <= threshold)) {
      return { ended: true, reason: "busted" };
    }
  }

  // Mangan-end: any win of mangan-or-better ends the match.
  if (rs.manganEnds && (result.reason === "tsumo" || result.reason === "ron")) {
    const isYakuman = result.winYakuman === true;
    const isMangan = (result.winHan ?? 0) >= 5;
    if (isYakuman || isMangan) {
      return { ended: true, reason: "mangan_end" };
    }
  }

  // Agari-yame: dealer wins the final hand of the final round.
  if (
    rs.agariYame &&
    isFinalHandOfMatch(state) &&
    (result.reason === "tsumo" || result.reason === "ron") &&
    result.winner === state.dealer
  ) {
    return { ended: true, reason: "agari_yame" };
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
