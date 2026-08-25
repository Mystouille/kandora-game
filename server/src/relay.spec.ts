/**
 * Relay (external event source) tests for `MatchProcess`.
 *
 * A relay match has no rules engine: events are injected by an external
 * decoder (Tenhou live spectating) and fan out to spectators through the
 * normal omniscient public projection.
 */
import { describe, expect, it, vi } from "vitest";

import { MatchProcess } from "./match";
import {
  ephemeralMatchRepository,
  type MatchRepository,
} from "./repository";
import {
  GameEventSchema,
  type GameEvent,
  type ServerMessage,
} from "~/game/protocol/messages";

const archiveReplayLogMock = vi.fn(
  async (
    _args: Parameters<MatchRepository["archiveReplayLog"]>[0]
  ): Promise<void> => undefined
);
const recordingRepository: MatchRepository = {
  createMatch: async () => undefined,
  archiveMatch: async () => undefined,
  archiveReplayLog: archiveReplayLogMock,
  saveCheckpoint: async () => undefined,
  saveCommandTransaction: async () => undefined,
  loadCheckpoint: async () => null,
  loadRecoveryRecord: async () => null,
  markCheckpointTerminal: async () => undefined,
  deleteCheckpoint: async () => undefined,
};

function relayEvents(): GameEvent[] {
  return [
    {
      type: "match_start",
      seats: [
        { seat: 0, userId: "t0", displayName: "East" },
        { seat: 1, userId: "t1", displayName: "South" },
        { seat: 2, userId: "t2", displayName: "West" },
        { seat: 3, userId: "t3", displayName: "North" },
      ],
      ruleSet: "tenhou",
    },
    {
      type: "hand_start",
      round: 0,
      dealer: 0,
      doraIndicators: ["1z"],
      startingHands: [
        Array<string>(13).fill("1m"),
        Array<string>(13).fill("2p"),
        Array<string>(13).fill("3s"),
        Array<string>(13).fill("4m"),
      ],
    },
    { type: "draw", seat: 0, tile: "5m", wallRemaining: 69 },
    { type: "discard", seat: 0, tile: "5m", tsumogiri: true },
    { type: "hand_end", reason: "exhaustive_draw", delta: [0, 0, 0, 0] },
    {
      type: "match_end",
      reason: "round_limit",
      finalScores: [
        { seat: 0, score: 25000, place: 1 },
        { seat: 1, score: 25000, place: 2 },
        { seat: 2, score: 25000, place: 3 },
        { seat: 3, score: 25000, place: 4 },
      ],
    },
  ];
}

function makeSpectator(): {
  send: (m: ServerMessage) => void;
  events: GameEvent[];
} {
  const events: GameEvent[] = [];
  return {
    send: (msg: ServerMessage): void => {
      if (msg.type === "event") {
        for (const e of msg.events) {
          events.push(e);
        }
      }
    },
    events,
  };
}

describe("MatchProcess relay", () => {
  it("uses schema-valid sample events", () => {
    for (const event of relayEvents()) {
      expect(GameEventSchema.safeParse(event).success).toBe(true);
    }
  });

  it("starts playing as a relay match", () => {
    const match = MatchProcess.createRelayMatch(
      "relay-1",
      "0E342071",
      { repository: ephemeralMatchRepository },
      "tenhou"
    );
    expect(match.isRelay).toBe(true);
    expect(match.status).toBe("playing");
  });

  it("fans injected events out to a spectator, omnisciently", () => {
    const match = MatchProcess.createRelayMatch(
      "relay-2",
      "0E342071",
      { repository: ephemeralMatchRepository },
      "tenhou"
    );
    const spec = makeSpectator();
    match.attachSpectator(spec.send, {
      userId: "viewer",
      displayName: "Viewer",
      role: "spectator",
    });
    const events = relayEvents();
    for (const event of events) {
      match.injectRelayEvent(event);
    }
    expect(spec.events.map((e) => e.type)).toEqual(events.map((e) => e.type));

    const draw = spec.events.find((e) => e.type === "draw");
    expect(draw?.type === "draw" ? draw.tile : null).toBe("5m");
    const handStart = spec.events.find((e) => e.type === "hand_start");
    expect(
      handStart?.type === "hand_start" ? handStart.startingHands?.length : 0
    ).toBe(4);
    expect(match.buildViewerState().viewers).toEqual([
      {
        userId: "viewer",
        displayName: "Viewer",
        role: "spectator",
        delayMs: 5 * 60_000,
      },
    ]);
  });

  it("does not mark external players disconnected in room state", () => {
    const match = MatchProcess.createRelayMatch(
      "relay-room-state",
      "0E342071",
      { repository: ephemeralMatchRepository },
      "tenhou"
    );
    match.injectRelayEvent(relayEvents()[0]);

    const room = match.buildRoomState(null);
    for (const { occupant } of room.seats) {
      expect(occupant.kind).toBe("human");
      if (occupant.kind === "human") {
        expect(occupant.connected).toBe(true);
      }
    }
  });

  it("catches a late spectator up from the buffer", () => {
    const match = MatchProcess.createRelayMatch(
      "relay-3",
      "0E342071",
      { repository: ephemeralMatchRepository }
    );
    for (const event of relayEvents()) {
      match.injectRelayEvent(event);
    }
    const buffered = match.replaySpectatorBuffer(0);
    expect(buffered.map((b) => b.event.type)).toEqual(
      relayEvents().map((e) => e.type)
    );
  });

  it("archives a tenhou ReplayLog on close", async () => {
    const match = MatchProcess.createRelayMatch(
      "relay-4",
      "0E342071",
      { repository: recordingRepository },
      "tenhou"
    );
    for (const event of relayEvents()) {
      match.injectRelayEvent(event);
    }
    await match.closeRelay();

    expect(match.status).toBe("finished");
    expect(archiveReplayLogMock).toHaveBeenCalledTimes(1);
    const arg = archiveReplayLogMock.mock.calls[0][0];
    expect(arg.source).toBe("tenhou");
    expect(arg.sourceGameId).toBe("0E342071");
    expect(arg.events).toHaveLength(relayEvents().length);
    expect(arg.seats).toHaveLength(4);
    expect(arg.seats[0].displayName).toBe("East");
  });

  it("ignores injections after close", async () => {
    const match = MatchProcess.createRelayMatch(
      "relay-5",
      "g",
      { repository: ephemeralMatchRepository }
    );
    match.injectRelayEvent(relayEvents()[0]);
    await match.closeRelay();
    const before = match.replaySpectatorBuffer(0).length;
    match.injectRelayEvent(relayEvents()[1]);
    expect(match.replaySpectatorBuffer(0)).toHaveLength(before);
  });
});
