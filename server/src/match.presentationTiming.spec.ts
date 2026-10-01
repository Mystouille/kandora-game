import { afterEach, describe, expect, it } from "vitest";
import { MatchProcess, setReadyCheckMs } from "./match";
import { ephemeralMatchRepository } from "./repository";
import type { MatchRuntime } from "./runtime";

describe("default live server pacing", () => {
  afterEach(() => {
    setReadyCheckMs(5_000);
  });

  it("paces an authoritative draw by exactly 500 ms", async () => {
    let now = 1_000;
    const sleeps: number[] = [];
    const runtime: MatchRuntime = {
      now: () => now,
      random: () => 0.5,
      captureRandomState: () => 0,
      restoreRandomState: () => undefined,
      schedule: () => ({ cancel: () => undefined }),
      sleep: async (delayMs) => {
        sleeps.push(delayMs);
        now += delayMs;
      },
    };
    const match = new MatchProcess(
      "live-default-pacing",
      42,
      [0, 1, 2, 3].map((seat) => ({
        userId: `human-${seat}`,
        displayName: `Human ${seat}`,
        isBot: false,
      })),
      { repository: ephemeralMatchRepository, runtime }
    );
    setReadyCheckMs(0);

    await match.start();

    expect(sleeps).toEqual([500]);
    expect(now).toBe(1_500);
    expect(
      match.replayFromBuffer(0).some(({ event }) => event.type === "draw")
    ).toBe(true);
  });
});
