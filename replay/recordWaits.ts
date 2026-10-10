import type { GameEvent, Seat, Tile } from "../protocol/messages";
import { waitsForRules } from "../rules/tileAvailability";
import { applyReplayEvent, initialView, type ReplayView } from "./player";

function waitCacheKey(view: ReplayView, seat: Seat, hand: readonly Tile[]): string {
  const meldCount = view.melds[seat]?.length ?? 0;
  return [
    view.rulesFamily ?? "riichi",
    view.playerCount ?? 4,
    meldCount,
    [...hand].sort().join(","),
  ].join("|");
}

function waitsAfterDiscard(
  view: ReplayView,
  seat: Seat,
  cache: Map<string, Tile[]>
): Tile[] | null {
  const hand = view.hands[seat] ?? [];
  const meldCount = view.melds[seat]?.length ?? 0;
  if (
    hand.length + meldCount * 3 !== 13 ||
    hand.some((tile) => tile === null)
  ) {
    return null;
  }
  const knownHand = hand as Tile[];
  const key = waitCacheKey(view, seat, knownHand);
  const cached = cache.get(key);
  if (cached !== undefined) {
    return [...cached];
  }
  const waits = waitsForRules(knownHand, meldCount, {
    playerCount: view.playerCount ?? 4,
    rulesFamily: view.rulesFamily,
  });
  cache.set(key, [...waits]);
  return waits;
}

/**
 * Persist missing post-discard waits once while producing a replay log.
 * Platform-provided waits remain authoritative; incomplete spectator hands
 * stay unannotated rather than being recorded as noten.
 */
export function recordMissingDiscardWaits(
  events: readonly GameEvent[]
): GameEvent[] {
  const cache = new Map<string, Tile[]>();
  let view = initialView();
  return events.map((event) => {
    view = applyReplayEvent(view, event);
    if (event.type !== "discard" || event.waits !== undefined) {
      return event;
    }
    const waits = waitsAfterDiscard(view, event.seat, cache);
    return waits === null ? event : { ...event, waits };
  });
}
