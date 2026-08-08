/**
 * Relay (external event source) tests for `MatchProcess`.
 *
 * A relay match has no rules engine: events are injected by an external
 * decoder (Tenhou live spectating) and fan out to spectators through the
 * normal omniscient public projection.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("./persist", () => ({
  createMatchDoc: vi.fn(async () => undefined),
  archiveMatch: vi.fn(async () => undefined),
  archiveReplayLog: vi.fn(async () => undefined),
}));

import { MatchProcess } from "./match";
import { archiveReplayLog } from "./persist";
import {
  GameEventSchema,
  type GameEvent,
  type ServerMessage,
} from "~/game/protocol/messages";

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
      "tenhou"
    );
    expect(match.isRelay).toBe(true);
    expect(match.status).toBe("playing");
  });

  it("fans injected events out to a spectator, omnisciently", () => {
    const match = MatchProcess.createRelayMatch(
      "relay-2",
      "0E342071",
      "tenhou"
    );
    const spec = makeSpectator();
    match.attachSpectator(spec.send);
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
  });

  it("catches a late spectator up from the buffer", () => {
    const match = MatchProcess.createRelayMatch("relay-3", "0E342071");
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
      "tenhou"
    );
    for (const event of relayEvents()) {
      match.injectRelayEvent(event);
    }
    await match.closeRelay();

    expect(match.status).toBe("finished");
    expect(archiveReplayLog).toHaveBeenCalledTimes(1);
    const arg = vi.mocked(archiveReplayLog).mock.calls[0][0];
    expect(arg.source).toBe("tenhou");
    expect(arg.sourceGameId).toBe("0E342071");
    expect(arg.events).toHaveLength(relayEvents().length);
    expect(arg.seats).toHaveLength(4);
    expect(arg.seats[0].displayName).toBe("East");
  });

  it("ignores injections after close", async () => {
    const match = MatchProcess.createRelayMatch("relay-5", "g");
    match.injectRelayEvent(relayEvents()[0]);
    await match.closeRelay();
    const before = match.replaySpectatorBuffer(0).length;
    match.injectRelayEvent(relayEvents()[1]);
    expect(match.replaySpectatorBuffer(0)).toHaveLength(before);
  });
});
