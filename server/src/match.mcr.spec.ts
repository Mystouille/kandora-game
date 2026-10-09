import { afterEach, describe, expect, it } from "vitest";
import {
  ServerMessageSchema,
  type ServerMessage,
} from "~/game/protocol/messages";
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

  it("keeps concealed Kong identities private on opponent wires", async () => {
    const messages = activeSeats(4).map(() => [] as ServerMessage[]);
    const match = new MatchProcess(
      "mcr-hidden-kong",
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
      match.attachHuman(seat, (message) => messages[seat].push(message));
    }
    setReadyCheckMs(0);
    await match.start();
    for (const seatMessages of messages) {
      seatMessages.length = 0;
    }
    const meld = {
      type: "ankan" as const,
      tiles: ["5m", "5m", "5m", "5m"],
      claimedTile: null,
      from: null,
    };

    await match.owners.publisher.emitEvent({ type: "call", seat: 1, meld });

    expect(messages[1].at(-1)).toMatchObject({
      type: "event",
      events: [{ type: "call", seat: 1, meld }],
    });
    for (const seat of [0, 2, 3] as const) {
      expect(messages[seat].at(-1)).toMatchObject({
        type: "event",
        events: [
          {
            type: "call",
            seat: 1,
            meld: { ...meld, tiles: [] },
          },
        ],
      });
    }
    expect(match.owners.publisher.history().at(-1)?.event).toEqual({
      type: "call",
      seat: 1,
      meld,
    });
  });

  it("changes seats with scores and connections after the East round", async () => {
    const messages = activeSeats(4).map(() => [] as ServerMessage[]);
    const match = new MatchProcess(
      "mcr-seat-change",
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
      match.attachHuman(seat, (message) => messages[seat].push(message));
    }
    setReadyCheckMs(0);
    await match.start();
    for (const playerMessages of messages) {
      playerMessages.length = 0;
    }
    match.owners.publisher.restoreSeatSequences([10, 20, 30, 40]);
    Object.assign(match.owners.kernel.view, {
      phase: "hand_ended",
      dealer: 3,
      roundWind: "E",
      roundNumber: 4,
      scores: [100, 200, 300, 400],
      lastHandResult: {
        reason: "exhaustive_draw",
        winner: null,
        loser: null,
        delta: [0, 0, 0, 0],
        tenpai: null,
        abortKind: null,
        nagashi: null,
        winHan: null,
        winYakuman: null,
      },
    });

    for (const seat of activeSeats(4)) {
      match.owners.actionWindows.clear(seat);
    }
    await match.owners.lifecycle.hand.beginNextHandAfterReady();

    expect(
      activeSeats(4).map((seat) => match.owners.roster.player(seat)?.userId)
    ).toEqual(["human-1", "human-0", "human-3", "human-2"]);
    expect(match.owners.kernel.view.scores).toEqual([200, 100, 400, 300]);
    expect(match.owners.publisher.seatSequences()).toEqual([21, 11, 41, 31]);

    const humanZeroRoom = messages[0].find(
      (message) => message.type === "room_state"
    );
    expect(humanZeroRoom).toMatchObject({ type: "room_state", mySeat: 1 });

    const humanZeroHand = messages[0].find(
      (message) =>
        message.type === "event" &&
        message.events.some((event) => event.type === "hand_start")
    );
    expect(humanZeroHand).toMatchObject({
      type: "event",
      seq: 10,
      events: [
        {
          type: "hand_start",
          roundWind: "S",
          roundNumber: 1,
          seatNames: ["Human 1", "Human 0", "Human 3", "Human 2"],
          scores: [200, 100, 400, 300],
        },
      ],
    });
  });
});
