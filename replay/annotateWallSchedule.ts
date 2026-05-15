import type { GameEvent, Seat } from "~/game/protocol/messages";

/**
 * Annotate each `draw` event with a `fromDeadWall` flag (true for
 * rinshan replacement draws after a kan) and attach a
 * `liveDrawSchedule: Seat[]` to every `hand_start` listing — in
 * live-wall consumption order — the seat that will draw each
 * remaining live-wall tile during the kyoku.
 *
 * Used by the `showWalls` renderer overlay to highlight every wall
 * tile the focused seat will eventually draw (based on the
 * recorded history of the kyoku, not a forecast).
 *
 * Detection rule: a draw is rinshan iff its preceding non-discard
 * event in the same kyoku is a kan-type `call` (ankan / daiminkan
 * / shouminkan). Discards reset the flag — the next turn's draw is
 * always from the live wall.
 *
 * The function returns a NEW array with shallow-cloned `draw` and
 * `hand_start` events; other events are referenced unchanged.
 */
export function annotateWallSchedule(events: GameEvent[]): GameEvent[] {
  const out = events.slice();
  let i = 0;
  while (i < out.length) {
    const ev = out[i];
    if (ev.type !== "hand_start") {
      i++;
      continue;
    }
    const schedule: Seat[] = [];
    let nextDrawFromDead = false;
    let j = i + 1;
    for (; j < out.length; j++) {
      const e = out[j];
      if (e.type === "hand_start" || e.type === "hand_end") {
        break;
      }
      if (e.type === "call") {
        const t = e.meld.type;
        if (t === "ankan" || t === "daiminkan" || t === "shouminkan") {
          nextDrawFromDead = true;
        }
        continue;
      }
      if (e.type === "draw") {
        const fromDeadWall = nextDrawFromDead;
        out[j] = { ...e, fromDeadWall };
        if (!fromDeadWall) {
          schedule.push(e.seat);
        }
        nextDrawFromDead = false;
        continue;
      }
      // Any other event (discard, dora_reveal, …): clear the
      // pending-rinshan flag so a stray non-kan event between a
      // kan and its replacement draw doesn't desync the schedule.
      if (e.type === "discard") {
        nextDrawFromDead = false;
      }
    }
    out[i] = { ...ev, liveDrawSchedule: schedule };
    i = j;
  }
  return out;
}
