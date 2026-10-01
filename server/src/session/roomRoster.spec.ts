import { describe, expect, it, vi } from "vitest";
import type { Seat } from "~/game/protocol/messages";
import { RoomRoster } from "./roomRoster";

function fixture() {
  let status: "waiting" | "playing" | "finished" = "waiting";
  const connected = new Set<Seat>();
  const permuteConnections = vi.fn();
  const clearConnection = vi.fn();
  const send = vi.fn();
  const claimed = vi.fn();
  const roster = new RoomRoster(
    "room",
    [0, 1, 2, 3].map((seat) => ({
      userId: `bot-${seat}`,
      displayName: `Bot ${seat}`,
      isBot: true,
    })),
    {
      status: () => status,
      assertNotPaused: () => undefined,
      hasSender: (seat) => connected.has(seat),
      send,
      clearConnection,
      permuteConnections,
      onPlayingHumanClaimed: claimed,
      broadcastRoom: () => undefined,
      broadcastViewers: () => undefined,
      start: async () => {
        status = "playing";
      },
    }
  );
  return {
    roster,
    connected,
    permuteConnections,
    clearConnection,
    send,
    claimed,
    play: () => {
      status = "playing";
    },
  };
}

describe("RoomRoster", () => {
  it("keeps joins stable and compacts humans before bots", () => {
    const f = fixture();
    f.roster.empty();
    expect(f.roster.claimSeat("first", "First")).toBe(0);
    expect(f.roster.claimSeat("second", "Second")).toBe(1);
    expect(f.roster.claimSeat("second", "Changed")).toBe(1);
    f.roster.releaseSeat(0);
    expect(f.roster.humanSeatForUser("second")).toBe(0);
    expect(f.clearConnection).toHaveBeenCalledWith(0);
    expect(f.permuteConnections).toHaveBeenLastCalledWith([1, 0, 2, 3]);
  });

  it("requires every seated human to be ready and physically attached", () => {
    const f = fixture();
    f.roster.empty();
    f.roster.claimSeat("first", "First");
    f.roster.setReady(0, true);
    expect(f.roster.canStart(0)).toBe(false);
    f.connected.add(0);
    expect(f.roster.canStart(0)).toBe(true);
    expect(f.roster.canStart(1)).toBe(false);
  });

  it("replaces a live bot without compacting and unacks the global ready check", () => {
    const f = fixture();
    f.play();
    expect(f.roster.claimSeat("human", "Human")).toBe(0);
    expect(f.claimed).toHaveBeenCalledWith(0);
    expect(f.permuteConnections).not.toHaveBeenCalled();
    expect(f.roster.readySnapshot()[0]).toBe(false);
  });

  it("sends the kick before clearing the connection and moving occupants", () => {
    const f = fixture();
    f.roster.empty();
    f.roster.claimSeat("host", "Host");
    f.roster.claimSeat("guest", "Guest");
    f.roster.kickSeat(0, 1);
    expect(f.send).toHaveBeenCalledWith(1, {
      type: "room_kicked",
      matchId: "room",
    });
    expect(f.send.mock.invocationCallOrder[0]).toBeLessThan(
      f.clearConnection.mock.invocationCallOrder[0]
    );
    expect(f.roster.humanSeats()).toEqual([0]);
  });

  it("copies roster and readiness projections instead of exposing mutable state", () => {
    const f = fixture();
    f.roster.empty();
    f.roster.claimSeat("host", "Host");
    const ready = f.roster.readySnapshot();
    ready[0] = true;
    expect(f.roster.readySnapshot()[0]).toBe(false);
    expect(f.roster.player(0)?.userId).toBe("host");
  });
});
