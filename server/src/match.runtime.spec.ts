import { afterEach, describe, expect, it, vi } from "vitest";
import type { GameEvent } from "~/game/protocol/messages";
import { MatchProcess, setReadyCheckMs } from "./match";
import { ephemeralMatchRepository } from "./repository";
import type { MatchRuntime } from "./runtime";

describe("MatchProcess runtime", () => {
  afterEach(() => {
    setReadyCheckMs(5_000);
  });

  it("uses injected randomness for authoritative dice rolls", async () => {
    const randomValues = [0, 0.999];
    const runtime: MatchRuntime = {
      now: () => 1_000,
      random: () => randomValues.shift() ?? 0,
      captureRandomState: () => randomValues.length,
      restoreRandomState: () => undefined,
      schedule: () => ({ cancel: () => undefined }),
      sleep: async () => undefined,
    };
    const match = new MatchProcess(
      "runtime-dice",
      42,
      [0, 1, 2, 3].map((seat) => ({
        userId: `human-${seat}`,
        displayName: `Human ${seat}`,
        isBot: false,
      })),
      { repository: ephemeralMatchRepository, runtime },
      undefined,
      undefined,
      "tenhou-hanchan"
    );
    setReadyCheckMs(0);

    await match.start();

    const handStart = match
      .replayFromBuffer(0)
      .map(({ event }) => event)
      .find(
        (event): event is Extract<GameEvent, { type: "hand_start" }> =>
          event.type === "hand_start"
      );
    expect(handStart?.dice).toEqual([1, 6]);
  });
});