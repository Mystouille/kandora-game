import type { GameEvent } from "~/game/protocol/messages";

export type ReplayNavigationKind = "step" | "jump";

export interface ReplaySoundTarget {
  playIndex: number;
  eventIndex: number;
}

export function replaySoundTarget(
  currentIndex: number,
  nextIndex: number,
  kind: ReplayNavigationKind
): ReplaySoundTarget | null {
  return kind === "step" && nextIndex === currentIndex + 1
    ? { playIndex: nextIndex, eventIndex: nextIndex }
    : null;
}

export function replayArrivalSoundTarget(
  nextEventCount: number,
  incomingEvents: readonly Pick<GameEvent, "type">[],
  pendingTarget: ReplaySoundTarget | null = null
): ReplaySoundTarget | null {
  if (nextEventCount <= 0 || incomingEvents.length === 0) {
    return null;
  }

  const playIndex = nextEventCount - 1;
  const firstIncomingIndex = nextEventCount - incomingEvents.length;
  const isLifecycleTail = incomingEvents.every(
    (event) => event.type === "hand_end" || event.type === "match_end"
  );
  if (isLifecycleTail) {
    return pendingTarget?.playIndex === firstIncomingIndex - 1
      ? { ...pendingTarget, playIndex }
      : null;
  }

  if (incomingEvents.length === 1) {
    return { playIndex, eventIndex: playIndex };
  }

  const winOffset = incomingEvents.findIndex((event) => event.type === "win");
  const isWinLifecycleBatch =
    winOffset >= 0 &&
    incomingEvents.every(
      (event) =>
        event.type === "win" ||
        event.type === "hand_end" ||
        event.type === "match_end"
    );
  if (!isWinLifecycleBatch) {
    return null;
  }

  return {
    playIndex,
    eventIndex: firstIncomingIndex + winOffset,
  };
}
