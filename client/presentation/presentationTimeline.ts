import type { MatchView } from "../store";
import { liveClockQuality, liveServerNow } from "../time/liveClock";

export function presentationStart(
  view: MatchView,
  kind: "draw" | "discard",
  localNow: number
): number | null {
  if (view.conn === "replay" || !view.presentation || !view.serverClock) {
    return null;
  }
  const authorityNow = liveServerNow();
  if (
    authorityNow === null ||
    liveClockQuality()?.clockEpoch !== view.serverClock.clockEpoch
  ) {
    return null;
  }
  const event = view.presentation.events.find(
    (entry) => entry.seq === view.lastSeq && entry.kind === kind
  );
  return event === undefined
    ? null
    : localNow + event.startsAt + view.presentation.offsetMs - authorityNow;
}
