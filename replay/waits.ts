import type { Tile } from "~/game/protocol/messages";
import { waits } from "~/game/rules/shanten";
import type { ReplayView } from "./player";

export type ReplayViewWaits = [Tile[], Tile[], Tile[], Tile[]];

/** Compute canonical wait tiles for every fully-known, post-discard hand. */
export function waitsForReplayView(
  view: Pick<ReplayView, "hands" | "melds">
): ReplayViewWaits {
  const result: ReplayViewWaits = [[], [], [], []];
  for (let seat = 0; seat < 4; seat++) {
    const hand = view.hands[seat] ?? [];
    const meldCount = view.melds[seat]?.length ?? 0;
    // A wait belongs to the stable post-discard shape. During the
    // seat's turn its structural hand has 14 tiles and should not
    // highlight a transient acceptance set.
    if (hand.length + meldCount * 3 !== 13 || hand.some((tile) => tile === null)) {
      continue;
    }
    result[seat] = waits(hand as Tile[], meldCount);
  }
  return result;
}