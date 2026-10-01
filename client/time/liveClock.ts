import type { ServerClock } from "./serverClock";

let active: {
  owner: object;
  clock: Pick<ServerClock, "now" | "quality">;
} | null = null;

export function bindLiveClock(
  owner: object,
  clock: Pick<ServerClock, "now" | "quality">
): void {
  active = { owner, clock };
}

export function releaseLiveClock(owner: object): void {
  if (active?.owner === owner) {
    active = null;
  }
}

export function liveServerNow(): number | null {
  return active?.clock.now() ?? null;
}

export function liveClockQuality() {
  return active?.clock.quality() ?? null;
}
