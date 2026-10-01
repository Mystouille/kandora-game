import { afterEach, describe, expect, it } from "vitest";
import { MatchProcess, setReadyCheckMs } from "../match";
import { ephemeralMatchRepository } from "../repository";
import type { MatchRuntime } from "../runtime";

describe("recorded legacy session contract", () => {
  afterEach(() => setReadyCheckMs(5_000));

  it("preserves initial event ordering, seat redaction and the legacy budget", async () => {
    let now = 1_000;
    const runtime: MatchRuntime = {
      now: () => now,
      random: () => 0.5,
      captureRandomState: () => 0,
      restoreRandomState: () => undefined,
      schedule: () => ({ cancel: () => undefined }),
      sleep: async (ms) => {
        now += ms;
      },
    };
    const match = new MatchProcess(
      "legacy-compatibility",
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
    const snapshot = match.buildSnapshotForSeat(0);
    expect(snapshot.state.hands.map((hand) => hand.length)).toEqual([
      14, 13, 13, 13,
    ]);
    expect(snapshot.state.hands[0].every((tile) => tile !== null)).toBe(true);
    expect(
      snapshot.state.hands
        .slice(1)
        .every((hand) => hand.every((tile) => tile === null))
    ).toBe(true);
    expect(snapshot.deadline).toBe(now + 5_000);
    expect(snapshot.bufferMs).toBe(20_000);
    expect(snapshot.actionWindow).toBeUndefined();
    expect(match.replayFromBuffer(0).map(({ event }) => event.type)).toEqual(
      expect.arrayContaining(["match_start", "hand_start", "draw"])
    );
  });
});
