export type ReplayNavigationKind = "step" | "jump";

export function replaySoundTarget(
  currentIndex: number,
  nextIndex: number,
  kind: ReplayNavigationKind
): number | null {
  return kind === "step" && nextIndex === currentIndex + 1 ? nextIndex : null;
}

export function replayArrivalSoundTarget(
  nextEventCount: number,
  incomingEventCount: number
): number | null {
  return incomingEventCount === 1 && nextEventCount > 0
    ? nextEventCount - 1
    : null;
}
