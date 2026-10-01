import { afterEach, describe, expect, it } from "vitest";
import { bindLiveClock, releaseLiveClock } from "../time/liveClock";
import { presentationStart } from "./presentationTimeline";
import { useMatchStore } from "../store";

const owner = {};
afterEach(() => {
  releaseLiveClock(owner);
  useMatchStore.getState().reset();
});

describe("absolute presentation scheduling", () => {
  it("shortens cosmetic work after late delivery instead of restarting it", () => {
    bindLiveClock(owner, {
      now: () => 1_100,
      quality: () => ({
        clockEpoch: "epoch-1",
        roundTripMs: 100,
        uncertaintyMs: 50,
        sampledAt: 0,
      }),
    });
    const view = {
      ...useMatchStore.getState(),
      lastSeq: 5,
      serverClock: { clockEpoch: "epoch-1", serverNow: 1_000 },
      presentation: {
        source: "player" as const,
        offsetMs: 0,
        events: [
          {
            seq: 5,
            kind: "draw" as const,
            occurredAt: 500,
            startsAt: 700,
            readyAt: 1_000,
          },
        ],
      },
    };
    expect(presentationStart(view, "draw", 100)).toBe(-300);
  });

  it("uses actual dispatch offset and never an external-source label", () => {
    bindLiveClock(owner, {
      now: () => 301_100,
      quality: () => ({
        clockEpoch: "epoch-1",
        roundTripMs: 100,
        uncertaintyMs: 50,
        sampledAt: 0,
      }),
    });
    const view = {
      ...useMatchStore.getState(),
      lastSeq: 5,
      serverClock: { clockEpoch: "epoch-1", serverNow: 301_100 },
      presentation: {
        source: "native-spectator" as const,
        offsetMs: 300_000,
        events: [
          {
            seq: 5,
            kind: "draw" as const,
            occurredAt: 500,
            startsAt: 700,
            readyAt: 1_000,
          },
        ],
      },
    };
    expect(presentationStart(view, "draw", 100)).toBe(-300);
    expect(
      presentationStart({ ...view, conn: "replay" }, "draw", 100)
    ).toBeNull();
  });
});
