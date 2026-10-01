import type { GameEvent } from "~/game/protocol/messages";
import type { PersistedMatchEvent } from "../repository";

export function replayProjectedEvents(
  history: readonly PersistedMatchEvent[],
  fromSeq: number,
  project: (event: GameEvent) => GameEvent | null,
  ripe: (entry: PersistedMatchEvent) => boolean = () => true
): Array<{ seq: number; event: GameEvent }> {
  const events: Array<{ seq: number; event: GameEvent }> = [];
  let nextSequence = 0;
  for (const entry of history) {
    if (!ripe(entry)) {
      break;
    }
    const projected = project(entry.event);
    if (projected === null) {
      continue;
    }
    const seq = nextSequence++;
    if (seq >= fromSeq) {
      events.push({ seq, event: projected });
    }
  }
  return events;
}
