import type { ReplayLog } from "./types";

export function replayHasRevealableWalls(
  replay: Pick<ReplayLog, "mode" | "events">
): boolean {
  if (replay.mode?.type !== "duplicate") {
    return true;
  }
  return replay.events.some(
    (event) =>
      event.type === "hand_start" &&
      event.duplicateDrawQueues !== undefined &&
      event.deadWall !== undefined
  );
}