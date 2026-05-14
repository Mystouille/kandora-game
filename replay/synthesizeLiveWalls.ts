import type { GameEvent } from "~/game/protocol/messages";
import type { Tile } from "~/game/rules";

/**
 * Reconstruct each hand's `liveWall` array from the event log when
 * the source didn't already supply it. Our own server-side flow
 * (`game-server/src/match.ts` → `enrichForArchive`) attaches the
 * omniscient live wall to every `hand_start`, but external-platform
 * adapters (Tenhou, Mahjong Soul, Riichi City) don't — so the
 * replay's `showWalls` overlay would have nothing to reveal.
 *
 * Strategy: for every `hand_start` lacking a `liveWall`, scan
 * forward to the next `hand_start` / `hand_end` and collect the
 * tile string from each `draw` event in order. Rinshan draws
 * (kan replacement tiles, which physically come from the dead
 * wall) are excluded — detected as any draw immediately following
 * a kan-type `call` event.
 *
 * The reconstructed array may be shorter than 70 (the wall size at
 * hand start) when the hand ended before the wall drained; the
 * renderer bounds-checks `liveWall[liveIdx]` so trailing positions
 * simply stay face-down.
 */
export function synthesizeLiveWalls(events: GameEvent[]): GameEvent[] {
  const out = events.slice();
  let i = 0;
  while (i < out.length) {
    const ev = out[i];
    if (ev.type !== "hand_start") {
      i++;
      continue;
    }
    if (ev.liveWall) {
      i++;
      continue;
    }
    const collected: Tile[] = [];
    let lastWasKan = false;
    let j = i + 1;
    for (; j < out.length; j++) {
      const e = out[j];
      if (e.type === "hand_start" || e.type === "hand_end") {
        break;
      }
      if (e.type === "call") {
        const t = e.meld.type;
        lastWasKan = t === "ankan" || t === "daiminkan" || t === "shouminkan";
        continue;
      }
      if (e.type === "draw") {
        if (!lastWasKan && e.tile) {
          collected.push(e.tile);
        }
        lastWasKan = false;
        continue;
      }
      lastWasKan = false;
    }
    if (collected.length > 0) {
      out[i] = { ...ev, liveWall: collected };
    }
    i = j;
  }
  return out;
}
