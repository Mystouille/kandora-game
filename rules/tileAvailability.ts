import type { RuleSet } from "./ruleSet";
import type { Tile } from "./types";
import { waits } from "./shanten";

export function isPlayableTile(
  tile: Tile,
  rules: Pick<RuleSet, "playerCount">
): boolean {
  if (rules.playerCount === 4 || tile[1] !== "m") {
    return true;
  }
  return tile[0] === "1" || tile[0] === "9";
}

export function waitsForRules(
  hand: readonly Tile[],
  meldCount: number,
  rules: Pick<RuleSet, "playerCount">
): Tile[] {
  return waits(hand, meldCount).filter((tile) => isPlayableTile(tile, rules));
}
