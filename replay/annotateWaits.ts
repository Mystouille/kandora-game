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
 *
 * Authoritative wait info from the platform replay log takes
 * precedence over the shanten-based fallback. Majsoul attaches
 * `tingpais` to every discard event (see `replayAdapter.ts`); when
 * present we lock that seat's waits to the platform-reported list
 * until the seat's hand changes again (draw / chi / pon / kan).
 * Tenhou and Riichi City don't expose per-discard waits, so those
 * seats keep using the local shanten compute throughout.
 */
export function annotateWaits(events: GameEvent[]): Tile[][][] {
  const out: Tile[][][] = new Array(events.length);
  let view = initialView();
  // Per-seat authoritative override. `null` means "no authoritative
  // reading available — use shanten-based compute". Cleared on
  // hand_start and on any event that mutates the seat's hand.
  let authoritative: (Tile[] | null)[] = [null, null, null, null];
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    view = applyReplayEvent(view, ev);

    switch (ev.type) {
      case "hand_start": {
        authoritative = [null, null, null, null];
        break;
      }
      case "draw": {
        // Drawing changes the seat's hand → invalidate prior override.
        authoritative[ev.seat] = null;
        break;
      }
      case "call": {
        // The caller's hand shape just changed.
        authoritative[ev.seat] = null;
        break;
      }
      case "discard": {
        if (ev.waits !== undefined) {
          authoritative[ev.seat] = [...ev.waits];
        }
        break;
      }
      default: {
        break;
      }
    }

    const computed = seatWaitsFromView(view);
    out[i] = computed.map((w, seat) => {
      const auth = authoritative[seat];
      return auth !== null ? [...auth] : w;
    });
  }
  return out;
}
