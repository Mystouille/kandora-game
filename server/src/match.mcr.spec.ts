import { afterEach, describe, expect, it } from "vitest";
import { ServerMessageSchema } from "~/game/protocol/messages";
import { presetToRuleSet, getPreset } from "~/game/rules/presets";
import { activeSeats } from "~/game/rules/seats";
import { MatchProcess, setReadyCheckMs } from "./match";
import { ephemeralMatchRepository } from "./repository";
import type { MatchRuntime } from "./runtime";

function dependencies() {
  let now = 1_000;
  const runtime: MatchRuntime = {
    clockEpoch: "mcr-session",
    now: () => now,
    random: () => 0.5,
    captureRandomState: () => 0,
    restoreRandomState: () => undefined,
    schedule: () => ({ cancel: () => undefined }),
    sleep: async (ms) => {
      now += ms;
    },
  };
  return { repository: ephemeralMatchRepository, runtime };
}

describe("MCR authoritative sessions", () => {
  afterEach(() => setReadyCheckMs(5_000));

  it("starts a four-player EMA table with flowers and zero scores", async () => {
    const match = new MatchProcess(
      "mcr-start",
      42,
      activeSeats(4).map((seat) => ({
        userId: `human-${seat}`,
        displayName: `Human ${seat}`,
        isBot: false,
      })),
      dependencies(),
      undefined,
      presetToRuleSet(getPreset("mcr-ema")),
      "mcr-ema"
    );
    for (const seat of activeSeats(4)) {
      match.attachHuman(seat, () => undefined);
    }
    setReadyCheckMs(0);
    await match.start();

    const snapshot = match.buildSnapshotForSeat(0);
    expect(snapshot.state.rulesFamily).toBe("mcr");
    expect(snapshot.state.hands.map((hand) => hand.length)).toEqual([
      14, 13, 13, 13,
    ]);
    expect(snapshot.state.scores).toEqual([0, 0, 0, 0]);
    expect(snapshot.state.doraIndicators).toEqual([]);
    expect(snapshot.state.flowerTiles).toHaveLength(4);
    expect(match.owners.roomViews.summary().rulesFamily).toBe("mcr");
    expect(ServerMessageSchema.parse(snapshot)).toMatchObject({
      state: { rulesFamily: "mcr", scores: [0, 0, 0, 0] },
    });
  });
});
