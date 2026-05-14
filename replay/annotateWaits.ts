/**
 * Server-side wait-tile pre-computation pass.
 *
 * Walks an event stream once, folds it through `applyReplayEvent`,
 * and snapshots each seat's wait tiles after every event. Result is
 * a parallel array indexed by event position: `waitsByIndex[i][seat]`
 * is the seat's wait list at the state reached by applying events
 * `[0..i]` inclusive.
 *
 * The point of this pass is to keep the shanten engine on the
 * server. The replay loader runs once per page load; the client
 * renderer then reads `view.currentWaits` directly without ever
 * importing `~/utils/waitUtils` or the underlying shanten module.
 *
 * Seats not in a discard-decision state (3N or 3N+2 size where
 * `getWaits` rejects, hands of size 14 mid-turn, empty hands)
 * yield an empty list — semantics match the previous client-side
 * `computeCurrentWaits` helper exactly.
 */
import type { GameEvent, Tile } from "~/game/protocol/messages";
import { getWaits } from "~/utils/waitUtils";
import { applyReplayEvent, initialView, type ReplayView } from "./player";

function seatWaitsFromView(view: ReplayView): Tile[][] {
  const out: Tile[][] = [[], [], [], []];
  for (let seat = 0; seat < 4; seat++) {
    const hand = view.hands[seat];
    if (!hand || hand.length === 0) {
      continue;
    }
    const handStr = hand
      .filter((t): t is Tile => typeof t === "string")
      .map((t) => (t[0] === "0" ? `5${t[1]}` : t))
      .join("");
    if (handStr.length === 0) {
      continue;
    }
    out[seat] = getWaits(handStr) as Tile[];
  }
  return out;
}

/**
 * Compute per-event wait snapshots. `waitsByIndex[i]` is the
 * length-4 array of per-seat wait tiles after applying
 * `events[i]`. The returned array always has `events.length`
 * entries — entries where the state doesn't change waits (e.g.
 * `new_dora`, `match_start`) still get a snapshot; this keeps the
 * indexing trivial for the route component.
 */
export function annotateWaits(events: GameEvent[]): Tile[][][] {
  const out: Tile[][][] = new Array(events.length);
  let view = initialView();
  for (let i = 0; i < events.length; i++) {
    view = applyReplayEvent(view, events[i]);
    out[i] = seatWaitsFromView(view);
  }
  return out;
}
