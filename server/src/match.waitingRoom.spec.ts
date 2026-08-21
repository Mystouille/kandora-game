/**
 * Waiting-room state machine — unit tests for the lobby API
 * (`createWaitingRoom`, `claimSeat`, `releaseSeat`, `fillBots`,
 * `buildRoomState`, `broadcastRoomState`).
 *
 * Covers:
 *   - Empty room starts in `waiting` status with 4 empty seats.
 *   - `claimSeat` assigns a random empty slot, marks the seat
 *     `human` in `buildRoomState`, and is idempotent per-userId
 *     (reconnect path).
 *   - `releaseSeat` clears the slot back to `empty`.
 *   - `fillBots` fills every remaining empty slot with bots and
 *     leaves humans untouched.
 *   - `broadcastRoomState` pushes a `room_state` frame to every
 *     attached human with their own `mySeat`.
 *   - `attachHuman` refuses unclaimed seats; bot seats stay
 *     unattachable as before.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("./persist", () => ({
  createMatchDoc: vi.fn(async () => undefined),
  archiveMatch: vi.fn(async () => undefined),
  archiveReplayLog: vi.fn(async () => undefined),
}));

import { MatchProcess } from "./match";
import type { Seat, ServerMessage } from "~/game/protocol/messages";

function makeSink(): {
  send: (msg: ServerMessage) => void;
  frames: ServerMessage[];
} {
  const frames: ServerMessage[] = [];
  return {
    send: (msg) => frames.push(msg),
    frames,
  };
}

describe("MatchProcess waiting-room state machine", () => {
  it("creates an empty waiting room", () => {
    const m = MatchProcess.createWaitingRoom("room-1", 42);
    expect(m.status).toBe("waiting");
    const rs = m.buildRoomState(null);
    expect(rs.status).toBe("waiting");
    expect(rs.mySeat).toBeNull();
    expect(rs.seats).toHaveLength(4);
    for (const s of rs.seats) {
      expect(s.occupant.kind).toBe("empty");
    }
  });

  it("includes the selected preset in the lobby summary", () => {
    const m = MatchProcess.createWaitingRoom(
      "room-m-league",
      42,
      undefined,
      undefined,
      "m-league"
    );
    expect(m.summary().presetId).toBe("m-league");
  });

  it("claimSeat assigns an empty slot and is idempotent per userId", () => {
    const m = MatchProcess.createWaitingRoom("room-2", 1);
    const seatA = m.claimSeat("user-1", "Alice");
    expect(seatA).not.toBeNull();
    // Reconnect: same userId returns the same seat.
    const seatA2 = m.claimSeat("user-1", "Alice");
    expect(seatA2).toBe(seatA);

    const rs = m.buildRoomState(seatA);
    const mine = rs.seats.find((s) => s.seat === seatA);
    expect(mine?.occupant.kind).toBe("human");
    if (mine?.occupant.kind === "human") {
      expect(mine.occupant.userId).toBe("user-1");
      expect(mine.occupant.displayName).toBe("Alice");
      expect(mine.occupant.connected).toBe(false);
    }
  });

  it("releaseSeat clears the slot back to empty", () => {
    const m = MatchProcess.createWaitingRoom("room-3", 2);
    const seat = m.claimSeat("user-1", "Alice");
    expect(seat).not.toBeNull();
    m.releaseSeat(seat as Seat);
    const rs = m.buildRoomState(null);
    const slot = rs.seats.find((s) => s.seat === seat);
    expect(slot?.occupant.kind).toBe("empty");
  });

  it("fillBots populates remaining empty slots", () => {
    const m = MatchProcess.createWaitingRoom("room-4", 3);
    const humanSeat = m.claimSeat("user-1", "Alice") as Seat;
    m.fillBots();
    const rs = m.buildRoomState(humanSeat);
    let bots = 0;
    let humans = 0;
    for (const s of rs.seats) {
      if (s.occupant.kind === "bot") {
        bots++;
      } else if (s.occupant.kind === "human") {
        humans++;
      }
    }
    expect(humans).toBe(1);
    expect(bots).toBe(3);
  });

  it("broadcastRoomState pushes a per-seat frame to every attached human", () => {
    const m = MatchProcess.createWaitingRoom("room-5", 4);
    const seatA = m.claimSeat("user-1", "Alice") as Seat;
    const seatB = m.claimSeat("user-2", "Bob") as Seat;
    const sinkA = makeSink();
    const sinkB = makeSink();
    m.attachHuman(seatA, sinkA.send);
    m.attachHuman(seatB, sinkB.send);
    // Discard any frames emitted by attachHuman itself; force a
    // fresh broadcast and assert each human got exactly one.
    sinkA.frames.length = 0;
    sinkB.frames.length = 0;
    m.broadcastRoomState();
    expect(sinkA.frames).toHaveLength(1);
    expect(sinkB.frames).toHaveLength(1);
    const frameA = sinkA.frames[0];
    const frameB = sinkB.frames[0];
    if (frameA.type !== "room_state" || frameB.type !== "room_state") {
      throw new Error("expected room_state frames");
    }
    expect(frameA.mySeat).toBe(seatA);
    expect(frameB.mySeat).toBe(seatB);
    // Both humans should now show as connected.
    for (const frame of [frameA, frameB]) {
      const a = frame.seats.find((s) => s.seat === seatA)?.occupant;
      const b = frame.seats.find((s) => s.seat === seatB)?.occupant;
      if (a?.kind !== "human" || b?.kind !== "human") {
        throw new Error("expected human occupants");
      }
      expect(a.connected).toBe(true);
      expect(b.connected).toBe(true);
    }
  });

  it("attachHuman refuses unclaimed seats", () => {
    const m = MatchProcess.createWaitingRoom("room-6", 5);
    const sink = makeSink();
    expect(() => m.attachHuman(0, sink.send)).toThrow(/unclaimed/);
  });

  it("claimSeat returns null when the room is full", () => {
    const m = MatchProcess.createWaitingRoom("room-7", 6);
    expect(m.claimSeat("u1", "A")).not.toBeNull();
    expect(m.claimSeat("u2", "B")).not.toBeNull();
    expect(m.claimSeat("u3", "C")).not.toBeNull();
    expect(m.claimSeat("u4", "D")).not.toBeNull();
    expect(m.claimSeat("u5", "E")).toBeNull();
  });
});
