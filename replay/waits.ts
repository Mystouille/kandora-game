import type { Tile } from "~/game/protocol/messages";
import { waitsForRules } from "~/game/rules/tileAvailability";
import type { ReplayView } from "./player";
import type { SeatValues } from "~/game/protocol/seat";
import { seatValues } from "~/game/rules/seats";

export type ReplayViewWaits = SeatValues<Tile[]>;

/** Compute canonical wait tiles for every fully-known, post-discard hand. */
export function waitsForReplayView(
  view: Pick<ReplayView, "hands" | "melds" | "playerCount">
): ReplayViewWaits {
  const result = seatValues(view.playerCount ?? 4, () => [] as Tile[]);
  for (let seat = 0; seat < result.length; seat++) {
    const hand = view.hands[seat] ?? [];
    const meldCount = view.melds[seat]?.length ?? 0;
    // A wait belongs to the stable post-discard shape. During the
    // seat's turn its structural hand has 14 tiles and should not
    // highlight a transient acceptance set.
    if (
      hand.length + meldCount * 3 !== 13 ||
      hand.some((tile) => tile === null)
    ) {
      continue;
    }
    result[seat] = waitsForRules(hand as Tile[], meldCount, {
      playerCount: view.playerCount ?? 4,
    });
  }
  return result;
}
