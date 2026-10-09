import { afterEach, describe, expect, it } from "vitest";
import { MatchProcess, setReadyCheckMs } from "./match";
import { ephemeralMatchRepository } from "./repository";
import type { MatchRuntime } from "./runtime";
import { activeSeats } from "~/game/rules/seats";
import { ServerMessageSchema } from "~/game/protocol/messages";

function dependencies() {
  let now = 1_000;
  const runtime: MatchRuntime = {
    clockEpoch: "sanma-session",
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

describe("three-player authoritative sessions", () => {
  afterEach(() => setReadyCheckMs(5_000));

  it("admits three players and never creates a fourth waiting-room place", () => {
    const match = MatchProcess.createWaitingRoom(
      "sanma-room",
      42,
      dependencies(),
      undefined,
      { playerCount: 3 },
      "m-league"
    );
    expect(match.claimSeat("one", "One")).toBe(0);
    expect(match.claimSeat("two", "Two")).toBe(1);
    expect(match.claimSeat("three", "Three")).toBe(2);
    expect(match.claimSeat("four", "Four")).toBeNull();
    expect(match.owners.roster.players().size).toBe(3);
    expect(match.owners.roster.readySnapshot()).toHaveLength(3);
    expect(match.owners.roomViews.summary().seats).toHaveLength(3);
    const room = match.owners.roomViews.buildRoomState(0);
    expect(room.playerCount).toBe(3);
    expect(ServerMessageSchema.parse(room)).toMatchObject({ playerCount: 3 });
  });

  it("starts with three hands, clocks and score entries", async () => {
    const match = new MatchProcess(
      "sanma-start",
      42,
      activeSeats(3).map((seat) => ({
        userId: `human-${seat}`,
        displayName: `Human ${seat}`,
        isBot: false,
      })),
      dependencies(),
      undefined,
      { playerCount: 3 },
      "m-league"
    );
    for (const seat of activeSeats(3)) {
      match.attachHuman(seat, () => undefined);
    }
    setReadyCheckMs(0);
    await match.start();
    const snapshot = match.buildSnapshotForSeat(0);
    expect(snapshot.state.playerCount).toBe(3);
    expect(snapshot.state.hands.map((hand) => hand.length)).toEqual([
      14, 13, 13,
    ]);
    expect(snapshot.state.scores).toEqual([45_000, 45_000, 45_000]);
    expect(match.owners.timeBank.snapshot()).toHaveLength(3);
    expect(match.owners.actionWindows.allLegals()).toHaveLength(3);
    expect(ServerMessageSchema.parse(snapshot)).toMatchObject({
      state: { playerCount: 3 },
    });
  });
});
