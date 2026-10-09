import type { GameEvent, Seat } from "~/game/protocol/messages";
import type { PersistedMatchPlayer } from "../repository";
import type { MatchStateView } from "./matchKernel";
import type { MatchPlayerInit } from "./roomRoster";

export function persistedRoster(
  players: ReadonlyMap<Seat, Readonly<MatchPlayerInit> | null>
): PersistedMatchPlayer[] {
  return [...players].flatMap(([seat, player]) =>
    player === null
      ? []
      : [
          {
            seat,
            userId: player.userId,
            displayName: player.displayName,
            isBot: player.isBot,
          },
        ]
  );
}

export function matchStartEvent(
  players: readonly PersistedMatchPlayer[],
  presetId: string,
  state: MatchStateView
): Extract<GameEvent, { type: "match_start" }> {
  return {
    type: "match_start",
    rulesFamily: state.ruleSet.rulesFamily,
    ...(state.ruleSet.playerCount === 3
      ? { playerCount: 3 as const, sanmaType: state.ruleSet.sanmaType }
      : {}),
    seats: players.map(({ seat, userId, displayName }) => ({
      seat,
      userId,
      displayName,
    })),
    ruleSet: presetId,
    riichiBetValue: state.ruleSet.riichiBetValue,
    uraDoraEnabled: state.ruleSet.uraDora,
    ...(state.ruleSet.scoreCap ? { scoreCap: state.ruleSet.scoreCap } : {}),
    ...(state.ruleSet.buuMode
      ? {
          chips: [
            state.chips[0],
            state.chips[1],
            state.chips[2],
            state.chips[3],
          ],
          dabuken: [
            state.dabuken[0],
            state.dabuken[1],
            state.dabuken[2],
            state.dabuken[3],
          ],
        }
      : {}),
  };
}
