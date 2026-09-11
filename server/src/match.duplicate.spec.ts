import { afterEach, describe, expect, it } from "vitest";
import type { DuplicateMatchModeConfig } from "~/game/protocol/matchMode";
import type { GameEvent } from "~/game/protocol/messages";
import type { Action, MatchState, Tile } from "~/game/rules";
import { getPreset, presetToRuleSet } from "~/game/rules/presets";
import { duplicateMatchSeed } from "./match-drivers/duplicatePlan";
import {
  MatchProcess,
  setDelayAfterDiscardMs,
  setNextHandDelayMs,
  setReadyCheckMs,
} from "./match";
import { ephemeralMatchRepository } from "./repository";
import { useMatchStore } from "~/game/client/store";

const mode: DuplicateMatchModeConfig = {
  type: "duplicate",
  seed: "Integration-A",
  generationVersion: 1,
};

function players() {
  return [0, 1, 2, 3].map((seat) => ({
    userId: `human-${seat}`,
    displayName: `Human ${seat}`,
    isBot: false,
  }));
}

function tiles(compact: string): Tile[] {
  const result: Tile[] = [];
  let digits = "";
  for (const character of compact) {
    if (character >= "0" && character <= "9") {
      digits += character;
      continue;
    }
    for (const digit of digits) {
      result.push(`${digit}${character}` as Tile);
    }
    digits = "";
  }
  return result;
}

function internals(match: MatchProcess): {
  state: MatchState;
  applyEngineAction(action: Action): Promise<void>;
  afterHandEnd(): Promise<void>;
} {
  return match as unknown as {
    state: MatchState;
    applyEngineAction(action: Action): Promise<void>;
    afterHandEnd(): Promise<void>;
  };
}

describe("MatchProcess duplicate mode", () => {
  afterEach(() => {
    setReadyCheckMs(5_000);
    setDelayAfterDiscardMs(350);
    setNextHandDelayMs(5_000);
    useMatchStore.getState().reset();
  });

  it("drives the first draw from the public seeded seat queue", async () => {
    const match = new MatchProcess(
      "duplicate-room",
      duplicateMatchSeed(mode),
      players(),
      { repository: ephemeralMatchRepository },
      undefined,
      presetToRuleSet(getPreset("m-league")),
      "m-league",
      mode
    );
    setReadyCheckMs(0);
    setDelayAfterDiscardMs(0);

    await match.start();

    expect(match.summary().mode).toEqual(mode);
    expect(match.buildRoomState(0).mode).toEqual(mode);
    const projectedEvents = match.replayFromBuffer(0).map(({ event }) => event);
    const projectedHandStart = projectedEvents.find(
      (event): event is Extract<GameEvent, { type: "hand_start" }> =>
        event.type === "hand_start"
    );
    const firstDraw = projectedEvents.find(
      (event): event is Extract<GameEvent, { type: "draw" }> =>
        event.type === "draw"
    );
    expect(projectedHandStart?.duplicateDrawQueues).toBeUndefined();
    expect(projectedHandStart?.duplicateWallState).toEqual({
      initial: [18, 18, 17, 17],
      remaining: [18, 18, 17, 17],
      limitingSeat: 2,
      estimatedDrawsRemaining: 70,
    });
    expect(firstDraw?.duplicateWallState).toEqual({
      initial: [18, 18, 17, 17],
      remaining: [17, 18, 17, 17],
      limitingSeat: 2,
      estimatedDrawsRemaining: 69,
    });
    const spectatorHandStart = match
      .replaySpectatorBuffer(0)
      .map(({ event }) => event)
      .find(
        (event): event is Extract<GameEvent, { type: "hand_start" }> =>
          event.type === "hand_start"
      );
    expect(spectatorHandStart?.duplicateDrawQueues).toBeUndefined();
      expect(spectatorHandStart?.duplicateWallState).toEqual(
        projectedHandStart?.duplicateWallState
      );
      const snapshot = match.buildSnapshotForSeat(0);
      expect(snapshot.type).toBe("snapshot");
      if (snapshot.type === "snapshot") {
        expect(snapshot.state.duplicateWallState).toEqual(
          firstDraw?.duplicateWallState
        );
        useMatchStore
          .getState()
          .hydrateSnapshot(snapshot.state, snapshot.seq);
        expect(useMatchStore.getState().duplicateWallState).toEqual(
          firstDraw?.duplicateWallState
        );
      }

    const checkpoint = match.createCheckpoint();
    if (checkpoint.status !== "playing") {
      throw new Error("expected a playing checkpoint");
    }
    const handStart = checkpoint.eventLog
      .map(({ event }) => event)
      .find(
        (event): event is Extract<GameEvent, { type: "hand_start" }> =>
          event.type === "hand_start"
      );
    expect(handStart?.duplicateDrawQueues).toHaveLength(4);
    expect(firstDraw?.tile).toBe(handStart?.duplicateDrawQueues?.[0][0]);

    expect(checkpoint).toMatchObject({
      schemaVersion: 2,
      mode,
      driver: {
        type: "duplicate",
        activeHand: { cursors: [1, 0, 0, 0] },
      },
    });
    const restored = MatchProcess.restoreCheckpoint(checkpoint, {
      repository: ephemeralMatchRepository,
    });
    expect(restored.createCheckpoint()).toMatchObject({
      mode,
      driver: {
        type: "duplicate",
        activeHand: { cursors: [1, 0, 0, 0] },
      },
    });
  });

  it("rejects developer overrides in duplicate mode", () => {
    expect(
      () =>
        new MatchProcess(
          "duplicate-debug",
          duplicateMatchSeed(mode),
          players(),
          { repository: ephemeralMatchRepository },
          { humanDraws: ["1m"] },
          undefined,
          "m-league",
          mode
        )
    ).toThrow(/debug/i);
  });

  it("consumes the declarer's next queue tile for ankan", async () => {
    const match = new MatchProcess(
      "duplicate-kan",
      duplicateMatchSeed(mode),
      players(),
      { repository: ephemeralMatchRepository },
      undefined,
      presetToRuleSet(getPreset("m-league")),
      "m-league",
      mode
    );
    setReadyCheckMs(0);
    setDelayAfterDiscardMs(0);
    await match.start();
    const before = match.createCheckpoint();
    if (before.status !== "playing") {
      throw new Error("expected playing checkpoint");
    }
    const handStart = before.eventLog
      .map(({ event }) => event)
      .find(
        (event): event is Extract<GameEvent, { type: "hand_start" }> =>
          event.type === "hand_start"
      );
    const replacement = handStart?.duplicateDrawQueues?.[0][1];
    if (replacement === undefined) {
      throw new Error("expected a second seat-0 draw");
    }
    const matchInternals = internals(match);
    matchInternals.state.hands[0] = tiles(
      "4m4m4m4m1p2p3p4p5p6p7p8p9p1s"
    );
    matchInternals.state.turn = 0;
    matchInternals.state.phase = "awaiting_discard";
    matchInternals.state.lastDrawn = ["1s", null, null, null];
    const deadWallBefore = [...matchInternals.state.deadWall];
    const liveWallLength = matchInternals.state.liveWall.length;

    await matchInternals.applyEngineAction({
      type: "kan",
      seat: 0,
      kind: "ankan",
      tile: "4m",
    });

    expect(matchInternals.state.lastDrawn[0]).toBe(replacement);
    expect(matchInternals.state.liveWall).toHaveLength(liveWallLength - 1);
    expect(matchInternals.state.deadWall).toEqual(deadWallBefore);
    const latestDraw = match
      .replayFromBuffer(0)
      .map(({ event }) => event)
      .filter(
        (event): event is Extract<GameEvent, { type: "draw" }> =>
          event.type === "draw"
      )
      .at(-1);
    const latestCall = match
      .replayFromBuffer(0)
      .map(({ event }) => event)
      .filter(
        (event): event is Extract<GameEvent, { type: "call" }> =>
          event.type === "call"
      )
      .at(-1);
    expect(latestCall?.duplicateWallState).toBeUndefined();
    expect(latestDraw?.duplicateWallState).toEqual({
      initial: [18, 18, 17, 17],
      remaining: [16, 18, 17, 17],
      limitingSeat: 0,
      estimatedDrawsRemaining: 67,
    });
    expect(match.createCheckpoint()).toMatchObject({
      driver: {
        type: "duplicate",
        activeHand: { cursors: [2, 0, 0, 0] },
      },
    });
  });

  it("recomputes the limiting seat after a pon changes turn order", async () => {
    const match = new MatchProcess(
      "duplicate-pon",
      duplicateMatchSeed(mode),
      players(),
      { repository: ephemeralMatchRepository },
      undefined,
      presetToRuleSet(getPreset("m-league")),
      "m-league",
      mode
    );
    setReadyCheckMs(0);
    setDelayAfterDiscardMs(0);
    await match.start();
    const matchInternals = internals(match);
    matchInternals.state.hands[2] = tiles(
      "4m4m1p2p3p4p5p6p7p8p9p1s2s"
    );
    matchInternals.state.discards = [["4m"], [], [], []];
    matchInternals.state.lastDiscard = { seat: 0, tile: "4m" };
    matchInternals.state.turn = 1;
    matchInternals.state.phase = "awaiting_draw";

    await matchInternals.applyEngineAction({
      type: "pon",
      seat: 2,
      tiles: ["4m", "4m"],
    });

    const call = match
      .replayFromBuffer(0)
      .map(({ event }) => event)
      .filter(
        (event): event is Extract<GameEvent, { type: "call" }> =>
          event.type === "call"
      )
      .at(-1);
    expect(call?.duplicateWallState).toEqual({
      initial: [18, 18, 17, 17],
      remaining: [17, 18, 17, 17],
      limitingSeat: 3,
      estimatedDrawsRemaining: 68,
    });
  });

  it("prepares the next hand from its progressed round key", async () => {
    const match = new MatchProcess(
      "duplicate-next-hand",
      duplicateMatchSeed(mode),
      players(),
      { repository: ephemeralMatchRepository },
      undefined,
      presetToRuleSet(getPreset("m-league")),
      "m-league",
      mode
    );
    setReadyCheckMs(0);
    setNextHandDelayMs(0);
    setDelayAfterDiscardMs(0);
    await match.start();
    const matchInternals = internals(match);
    matchInternals.state.phase = "hand_ended";
    matchInternals.state.lastHandResult = {
      reason: "abort",
      winner: null,
      loser: null,
      delta: [0, 0, 0, 0],
      tenpai: null,
      abortKind: "kyuushuu",
      winHan: null,
      winYakuman: null,
    };

    await matchInternals.afterHandEnd();

    const checkpoint = match.createCheckpoint();
    if (checkpoint.status !== "playing") {
      throw new Error("expected playing checkpoint");
    }
    const handStarts = checkpoint.eventLog
      .map(({ event }) => event)
      .filter(
        (event): event is Extract<GameEvent, { type: "hand_start" }> =>
          event.type === "hand_start"
      );
    const latestHand = handStarts.at(-1);
    const archivedEvents = checkpoint.eventLog.map(({ event }) => event);
    let latestHandStartIndex = -1;
    for (let index = archivedEvents.length - 1; index >= 0; index--) {
      if (archivedEvents[index].type === "hand_start") {
        latestHandStartIndex = index;
        break;
      }
    }
    const drawsAfterLatest = archivedEvents
      .slice(latestHandStartIndex + 1)
      .filter(
        (event): event is Extract<GameEvent, { type: "draw" }> =>
          event.type === "draw"
      );

    expect(latestHand).toMatchObject({
      roundWind: "E",
      roundNumber: 1,
      honba: 1,
    });
    expect(drawsAfterLatest[0]?.tile).toBe(
      latestHand?.duplicateDrawQueues?.[0][0]
    );
    expect(checkpoint).toMatchObject({
      driver: {
        type: "duplicate",
        activeHand: {
          key: { roundWind: "E", roundNumber: 1, honba: 1, dealer: 0 },
          cursors: [1, 0, 0, 0],
        },
      },
    });
  });
});