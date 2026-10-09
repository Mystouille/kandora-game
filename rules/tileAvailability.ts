import type { RuleSet } from "./ruleSet";
import type { Tile } from "./types";
import { waits } from "./shanten";
import { mcrWaits } from "~/core/mahjong/rules/mcrShanten";

export function isPlayableTile(
  tile: Tile,
  rules: Pick<RuleSet, "playerCount"> & Partial<Pick<RuleSet, "rulesFamily">>
): boolean {
  if (tile.endsWith("f")) {
    return false;
  }
  if (rules.playerCount === 4 || tile[1] !== "m") {
    return true;
  }
  return tile[0] === "1" || tile[0] === "9";
}

export function waitsForRules(
  hand: readonly Tile[],
  meldCount: number,
  rules: Pick<RuleSet, "playerCount"> & Partial<Pick<RuleSet, "rulesFamily">>
): Tile[] {
  if (rules.rulesFamily === "mcr") {
    if (hand.some((tile) => tile.endsWith("f"))) {
      return [];
    }
    return mcrWaits(hand, meldCount);
  }
  return waits(hand, meldCount).filter((tile) => isPlayableTile(tile, rules));
}
