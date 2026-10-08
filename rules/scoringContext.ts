import type { ScoreInput } from "./score";
import type { MatchState } from "./state";
import type { Seat } from "./types";
import { isAkaDisabled } from "./ruleSet";
import { windForSeat } from "./seats";

export function handScoringContext(
  state: MatchState,
  seat: Seat
): Omit<ScoreInput, "hand" | "winTile" | "tsumo"> {
  const rules = state.ruleSet;
  return {
    playerCount: rules.playerCount,
    sanmaType: rules.sanmaType,
    nukiTiles: state.nukiTiles[seat],
    roundWind: state.roundWind,
    seatWind: windForSeat(seat, state.dealer, rules.playerCount),
    doraIndicators: state.doraIndicators,
    uraDoraIndicators:
      rules.uraDora && state.riichiDeclared[seat]
        ? state.uraDoraIndicators
        : undefined,
    riichi: state.riichiDeclared[seat],
    doubleRiichi: state.doubleRiichi[seat],
    ippatsu: state.ippatsuEligible[seat],
    melds: state.melds[seat],
    noKuitan: !rules.kuitan,
    noAka: isAkaDisabled(rules),
    kiriageMangan: rules.kiriageMangan,
    doubleWindPairFu: rules.doubleWindPairFu,
    scoreCap: rules.scoreCap,
  };
}
