/**
 * Waiting-room state machine — unit tests for the lobby API
 * (`createWaitingRoom`, `claimSeat`, `releaseSeat`, `fillBots`,
 * `buildRoomState`, `broadcastRoomState`).
 *
 * Covers:
 *   - Empty room starts in `waiting` status with 4 empty seats.
 *   - `claimSeat` assigns a stable placeholder slot, marks the seat
 *     `human` in `buildRoomState`, and is idempotent per-userId
 *     (reconnect path).
 *   - `fillBotsAndStart` randomizes final seats and keeps each
 *     human socket attached to its occupant.
 *   - `releaseSeat` clears the slot back to `empty`.
 *   - `fillBots` fills every remaining empty slot with bots and
 *     leaves humans untouched.
 *   - `broadcastRoomState` pushes a `room_state` frame to every
 *     attached human with their own `mySeat`.
 *   - `attachHuman` refuses unclaimed seats; bot seats stay
 *     unattachable as before.
 */
import { describe, expect, it } from "vitest";

import { MatchProcess, waitingRoomSeatPermutation } from "./match";
import { ephemeralMatchRepository } from "./repository";
import type { Seat, ServerMessage } from "~/game/protocol/messages";

const dependencies = { repository: ephemeralMatchRepository };

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
  it("keeps join positions stable but varies final East by match seed", () => {
    const room = MatchProcess.createWaitingRoom(
      "stable-joins",
      42,
      dependencies
    );
    expect(room.claimSeat("creator", "Creator")).toBe(0);
    expect(room.claimSeat("second", "Second")).toBe(1);

    const eastSources = new Set(
      [1, 2, 3, 4, 5, 6, 7, 8].map(
        (seed) => waitingRoomSeatPermutation(seed)[0]
      )
    );
    expect(eastSources.size).toBeGreaterThan(1);
  });

  it("moves the creator socket to its randomized final seat at start", async () => {
    const seed = [1, 2, 3, 4, 5, 6, 7, 8].find(
      (candidate) => waitingRoomSeatPermutation(candidate).indexOf(0) !== 0
    );
    if (seed === undefined) {
      throw new Error("expected a seed that moves waiting-room seat 0");
    }
    const finalSeat = waitingRoomSeatPermutation(seed).indexOf(0) as Seat;
    const room = MatchProcess.createWaitingRoom(
      "shuffle-on-start",
      seed,
      dependencies
    );
    const waitingSeat = room.claimSeat("creator", "Creator") as Seat;
    expect(waitingSeat).toBe(0);
    const sink = makeSink();
    room.attachHuman(waitingSeat, sink.send);
    sink.frames.length = 0;

    await room.fillBotsAndStart();

    expect(finalSeat).not.toBe(0);
    expect(room.humanSeatFor(sink.send)).toBe(finalSeat);
    const finalRoomState = [...sink.frames]
      .reverse()
      .find((frame) => frame.type === "room_state");
    if (finalRoomState?.type !== "room_state") {
      throw new Error("expected a final room_state frame");
    }
    expect(finalRoomState.status).toBe("playing");
    expect(finalRoomState.mySeat).toBe(finalSeat);
    const botNames = ["Bot East", "Bot South", "Bot West", "Bot North"];
    for (const { seat, occupant } of finalRoomState.seats) {
      if (seat === finalSeat) {
        expect(occupant).toMatchObject({
          kind: "human",
          userId: "creator",
        });
      } else {
        expect(occupant).toMatchObject({
          kind: "bot",
          displayName: botNames[seat],
        });
      }
    }
  });

  it("creates an empty waiting room", () => {
    const m = MatchProcess.createWaitingRoom("room-1", 42, dependencies);
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
      dependencies,
      undefined,
      undefined,
      "m-league"
    );
    expect(m.summary().presetId).toBe("m-league");
  });

  it("claimSeat assigns an empty slot and is idempotent per userId", () => {
    const m = MatchProcess.createWaitingRoom("room-2", 1, dependencies);
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
    expect(mine?.ready).toBe(false);
    expect(rs.hostSeat).toBe(seatA);
  });

  it("replaces the first waiting-room bot before claiming an empty seat", () => {
    const m = MatchProcess.createWaitingRoom(
      "replace-waiting-bot",
      11,
      dependencies
    );
    const hostSeat = m.claimSeat("host", "Host") as Seat;
    const botSeat = m.addWaitingRoomBot(hostSeat);

    const joinedSeat = m.claimSeat("guest", "Guest");

    expect(joinedSeat).toBe(botSeat);
    expect(m.buildRoomState(joinedSeat).seats[botSeat].occupant).toMatchObject({
      kind: "human",
      userId: "guest",
      displayName: "Guest",
    });
    expect(
      m.buildRoomState(joinedSeat).seats.filter(
        ({ occupant }) => occupant.kind === "empty"
      )
    ).toHaveLength(2);
    expect(
      m.buildRoomState(joinedSeat).seats.some(
        ({ occupant }) => occupant.kind === "bot"
      )
    ).toBe(false);
  });

  it("replaces the first bot when joining a match already in progress", async () => {
    const m = MatchProcess.createWaitingRoom(
      "replace-playing-bot",
      12,
      dependencies
    );
    const originalSeat = m.claimSeat("original", "Original") as Seat;
    m.attachHuman(originalSeat, makeSink().send);
    await m.fillBotsAndStart();
    const playingRoom = m.buildRoomState(null);
    const firstBotSeat = playingRoom.seats.find(
      ({ occupant }) => occupant.kind === "bot"
    )?.seat;
    if (firstBotSeat === undefined) {
      throw new Error("expected a bot seat after starting the match");
    }

    const joinedSeat = m.claimSeat("late-player", "Late Player");

    expect(joinedSeat).toBe(firstBotSeat);
    expect(m.isHumanSeat(firstBotSeat)).toBe(true);
    expect(
      m.buildRoomState(joinedSeat).seats[firstBotSeat].occupant
    ).toMatchObject({
      kind: "human",
      userId: "late-player",
      displayName: "Late Player",
    });
    const lateSink = makeSink();
    m.attachHuman(firstBotSeat, lateSink.send);
    const snapshot = m.buildSnapshotForSeat(firstBotSeat);
    if (snapshot.type !== "snapshot") {
      throw new Error("expected a private snapshot for the replacement player");
    }
    expect(snapshot.state.mySeat).toBe(firstBotSeat);
    expect(snapshot.state.seatNames?.[firstBotSeat]).toBe("Late Player");
    expect(snapshot.state.hands[firstBotSeat].some((tile) => tile !== null)).toBe(
      true
    );
  });

  it("does not replace a human in a full match already in progress", async () => {
    const m = MatchProcess.createWaitingRoom(
      "full-human-match",
      13,
      dependencies
    );
    for (let player = 0; player < 4; player++) {
      m.claimSeat(`human-${player}`, `Human ${player}`);
    }
    await m.fillBotsAndStart();

    expect(m.claimSeat("fifth-human", "Fifth Human")).toBeNull();
  });

  it("toggles readiness and only lets the first human start", async () => {
    const m = MatchProcess.createWaitingRoom("ready-room", 7, dependencies);
    const hostSeat = m.claimSeat("host", "Host") as Seat;
    const guestSeat = m.claimSeat("guest", "Guest") as Seat;
    m.attachHuman(hostSeat, makeSink().send);
    m.attachHuman(guestSeat, makeSink().send);

    expect(m.canStartWaitingRoom(hostSeat)).toBe(false);
    m.setWaitingRoomReady(hostSeat, true);
    expect(m.canStartWaitingRoom(hostSeat)).toBe(false);
    m.setWaitingRoomReady(guestSeat, true);
    expect(m.canStartWaitingRoom(hostSeat)).toBe(true);
    expect(m.canStartWaitingRoom(guestSeat)).toBe(false);
    await expect(m.startWaitingRoom(guestSeat)).rejects.toThrow(/host/i);

    m.setWaitingRoomReady(guestSeat, false);
    expect(m.canStartWaitingRoom(hostSeat)).toBe(false);
  });

  it("lets only the host add bots and kick occupants", () => {
    const m = MatchProcess.createWaitingRoom("managed-room", 8, dependencies);
    const hostSeat = m.claimSeat("host", "Host") as Seat;
    const guestSeat = m.claimSeat("guest", "Guest") as Seat;

    expect(() => m.addWaitingRoomBot(guestSeat)).toThrow(/host/i);
    const botSeat = m.addWaitingRoomBot(hostSeat);
    expect(m.buildRoomState(hostSeat).seats[botSeat].occupant.kind).toBe("bot");
    expect(m.buildRoomState(hostSeat).seats[botSeat].ready).toBe(true);

    expect(() => m.kickWaitingRoomSeat(guestSeat, botSeat)).toThrow(/host/i);
    m.kickWaitingRoomSeat(hostSeat, botSeat);
    expect(
      m.buildRoomState(hostSeat).seats.some(
        ({ occupant }) => occupant.kind === "bot"
      )
    ).toBe(false);
  });

  it("notifies a kicked human before removing their seat", () => {
    const m = MatchProcess.createWaitingRoom("kicked-human", 10, dependencies);
    const hostSeat = m.claimSeat("host", "Host") as Seat;
    const guestSeat = m.claimSeat("guest", "Guest") as Seat;
    const hostSink = makeSink();
    const guestSink = makeSink();
    m.attachHuman(hostSeat, hostSink.send);
    m.attachHuman(guestSeat, guestSink.send);
    guestSink.frames.length = 0;

    m.kickWaitingRoomSeat(hostSeat, guestSeat);

    expect(guestSink.frames).toContainEqual({
      type: "room_kicked",
      matchId: "kicked-human",
    });
    expect(m.humanSeatFor(guestSink.send)).toBeNull();
    expect(
      m.buildRoomState(hostSeat).seats.some(
        ({ occupant }) =>
          occupant.kind === "human" && occupant.userId === "guest"
      )
    ).toBe(false);
  });

  it("promotes the next human when the first human leaves", () => {
    const m = MatchProcess.createWaitingRoom("host-transfer", 9, dependencies);
    const firstSeat = m.claimSeat("first", "First") as Seat;
    const secondSeat = m.claimSeat("second", "Second") as Seat;
    const firstSink = makeSink();
    const secondSink = makeSink();
    m.attachHuman(firstSeat, firstSink.send);
    m.attachHuman(secondSeat, secondSink.send);
    m.addWaitingRoomBot(firstSeat);
    secondSink.frames.length = 0;

    m.releaseSeat(firstSeat);

    const room = m.buildRoomState(null);
    const promoted = room.seats.find(
      ({ occupant }) =>
        occupant.kind === "human" && occupant.userId === "second"
    );
    expect(promoted?.seat).toBe(0);
    expect(room.hostSeat).toBe(promoted?.seat);
    expect(room.seats[1].occupant.kind).toBe("bot");
    expect(m.humanSeatFor(secondSink.send)).toBe(0);
    expect(
      [...secondSink.frames]
        .reverse()
        .find((frame) => frame.type === "room_state")
    ).toMatchObject({
      type: "room_state",
      mySeat: 0,
      hostSeat: 0,
    });
    expect(m.canStartWaitingRoom(secondSeat)).toBe(false);
    expect(m.canStartWaitingRoom(promoted?.seat as Seat)).toBe(false);
    m.setWaitingRoomReady(0, true);
    expect(m.canStartWaitingRoom(0)).toBe(true);
  });

  it("releaseSeat clears the slot back to empty", () => {
    const m = MatchProcess.createWaitingRoom("room-3", 2, dependencies);
    const seat = m.claimSeat("user-1", "Alice");
    expect(seat).not.toBeNull();
    m.releaseSeat(seat as Seat);
    const rs = m.buildRoomState(null);
    const slot = rs.seats.find((s) => s.seat === seat);
    expect(slot?.occupant.kind).toBe("empty");
  });

  it("fillBots populates remaining empty slots", () => {
    const m = MatchProcess.createWaitingRoom("room-4", 3, dependencies);
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
    const m = MatchProcess.createWaitingRoom("room-5", 4, dependencies);
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
    const m = MatchProcess.createWaitingRoom("room-6", 5, dependencies);
    const sink = makeSink();
    expect(() => m.attachHuman(0, sink.send)).toThrow(/unclaimed/);
  });

  it("claimSeat returns null when the room is full", () => {
    const m = MatchProcess.createWaitingRoom("room-7", 6, dependencies);
    expect(m.claimSeat("u1", "A")).not.toBeNull();
    expect(m.claimSeat("u2", "B")).not.toBeNull();
    expect(m.claimSeat("u3", "C")).not.toBeNull();
    expect(m.claimSeat("u4", "D")).not.toBeNull();
    expect(m.claimSeat("u5", "E")).toBeNull();
  });
});
