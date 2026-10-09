import type { PlayerCount, SanmaType } from "~/game/protocol/seat";
import type { RulesFamily } from "~/game/protocol/rulesFamily";
import type { ReplayLog } from "./types";
import { seatValues } from "~/game/rules/seats";

export function replaySeatNames(log: ReplayLog) {
  return seatValues(
    replayVariant(log).playerCount,
    (seat) => log.seats.find((entry) => entry.seat === seat)?.displayName ?? ""
  );
}

/** Partial external seat listings are not evidence of native sanma. */
export function replayVariant(log: ReplayLog): {
  rulesFamily: RulesFamily;
  playerCount: PlayerCount;
  sanmaType: SanmaType;
} {
  const start = log.events.find((event) => event.type === "match_start");
  const effective = log.ruleSetDetails?.effectiveRuleSet;
  const rules =
    effective && typeof effective === "object"
      ? (effective as Record<string, unknown>)
      : log.ruleSetDetails;
  return {
    rulesFamily:
      log.rulesFamily ??
      start?.rulesFamily ??
      (rules?.rulesFamily === "mcr" ? "mcr" : "riichi"),
    playerCount:
      log.playerCount ??
      start?.playerCount ??
      (log.source === "ingame" && rules?.playerCount === 3 ? 3 : 4),
    sanmaType:
      log.sanmaType ??
      start?.sanmaType ??
      (log.source === "ingame" && rules?.sanmaType === "kansai"
        ? "kansai"
        : "online"),
  };
}
