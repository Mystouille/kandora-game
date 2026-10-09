import { beforeEach, describe, expect, it } from "vitest";
import type { GameEvent, SnapshotState } from "~/game/protocol/messages";
import { useMatchStore } from "~/game/client/store";
import { dispatchServerMessage } from "~/game/client/dispatchServerMessage";
import { seatValues } from "~/game/rules/seats";
import { applyReplayEvent, initialView, replayReducer } from "./player";
import { snapshotToReplayView } from "./liveSpectate";
import { annotateWallSchedule } from "./annotateWallSchedule";
import type { ReplayLog } from "./types";
import { replayVariant } from "./variant";
import {
  replayLogToTenhou5Json,
  UnsupportedSanmaExportError,
} from "./replayLogToTenhou5Json";

const startingHands = seatValues(3, () => Array<string>(13).fill("1p"));
const start: GameEvent = {
  type: "hand_start",
  playerCount: 3,
  sanmaType: "online",
  round: 0,
  dealer: 0,
  startingHands,
  scores: [25000, 25000, 25000],
  doraIndicators: ["1z"],
  sanmaWall: {
    sanmaType: "online",
    mode: "standard",
    replacementsTaken: 0,
    kanCount: 0,
  },
};
const events: GameEvent[] = [
  {
    type: "match_start",
    playerCount: 3,
    sanmaType: "online",
    ruleSet: "m-league",
    seats: [],
  },
  start,
  { type: "draw", seat: 0, tile: "4z", wallRemaining: 54 },
  { type: "nuki", seat: 0, tile: "4z", stage: "declared" },
  { type: "nuki", seat: 0, tile: "4z", stage: "completed" },
  {
    type: "draw",
    seat: 0,
    tile: "2p",
    wallRemaining: 53,
    replacementKind: "nuki",
    fromDeadWall: true,
    sanmaWall: {
      sanmaType: "online",
      mode: "standard",
      replacementsTaken: 1,
      kanCount: 0,
    },
  },
];

function log(overrides: Partial<ReplayLog> = {}): ReplayLog {
  return {
    source: "ingame",
    sourceGameId: "sanma",
    ruleSet: "m-league",
    startedAt: 0,
    endedAt: 1,
    schemaVersion: 9,
    seats: [],
    events,
    ...overrides,
  };
}

function snapshot(): SnapshotState {
  return {
    playerCount: 3,
    sanmaType: "online",
    mySeat: null,
    hands: startingHands.map((hand) => [...hand]),
    melds: [[], [], []],
    discards: [[], [], []],
    nukiTiles: [[], [], []],
    pendingNuki: { seat: 0, tile: "4z", opening: false },
    sanmaWall: {
      sanmaType: "online",
      mode: "standard",
      replacementsTaken: 0,
      kanCount: 0,
    },
    wallRemaining: 54,
    drawsTaken: 1,
    liveDrawsTaken: 1,
    doraIndicators: ["1z"],
    scores: [25000, 25000, 25000],
    turn: 0,
    dealer: 0,
    roundWind: "E",
    roundNumber: 1,
    honba: 0,
    riichiSticks: 0,
    riichiDeclared: [false, false, false],
    lastDiscard: null,
    phase: "awaiting_chankan",
  };
}

beforeEach(() => useMatchStore.getState().reset());

describe("native sanma live and replay state", () => {
  it("folds, seeks and resyncs a pending North without granting bonus or removing it twice", () => {
    const pending = replayReducer(log(), 3);
    expect(pending.hands.map((hand) => hand.length)).toEqual([13, 13, 13]);
    expect(pending.nukiTiles).toEqual([[], [], []]);
    expect(pending.pendingNuki).toEqual({
      seat: 0,
      tile: "4z",
      opening: false,
    });
    const complete = replayReducer(log(), 5);
    expect(complete.hands[0]).toHaveLength(14);
    expect(complete.nukiTiles).toEqual([["4z"], [], []]);
    expect(complete.drawsTaken).toBe(2);
    expect(complete.liveDrawsTaken).toBe(1);
    expect(complete.sanmaWall?.kanCount).toBe(0);
    expect(replayReducer(log(), 3)).toEqual(pending);
    const baseline = snapshotToReplayView(snapshot());
    expect(applyReplayEvent(baseline, events[4]).hands[0]).toHaveLength(13);
    dispatchServerMessage({
      type: "snapshot",
      state: snapshot(),
      seq: 3,
      legalActions: [],
    });
    const frame = {
      type: "event" as const,
      events: events.slice(4),
      seq: 5,
      legalActions: [],
    };
    dispatchServerMessage(frame);
    dispatchServerMessage(frame);
    const live = useMatchStore.getState();
    for (const key of [
      "hands",
      "melds",
      "nukiTiles",
      "pendingNuki",
      "scores",
      "sanmaWall",
      "drawsTaken",
      "liveDrawsTaken",
      "turn",
      "phase",
    ] as const) {
      expect(live[key]).toEqual(complete[key]);
    }
  });

  it("preserves spectator hands and player redaction during North extraction", () => {
    for (const mySeat of [null, 1] as const) {
      const store = useMatchStore.getState();
      store.setMatch("native", mySeat);
      events.forEach((event, seq) => {
        if (event.type === "draw" && mySeat !== null) {
          const { tile: _tile, ...redacted } = event;
          store.applyEvent(redacted, seq);
        } else {
          store.applyEvent(event, seq);
        }
      });
      const hand = useMatchStore.getState().hands[0];
      expect(hand).toHaveLength(14);
      expect(
        hand.every((tile) => (mySeat === null ? tile !== null : tile === null))
      ).toBe(true);
      expect(useMatchStore.getState().nukiTiles).toEqual([["4z"], [], []]);
    }
  });

  it("extracts chained automatic opening fives without turning them into a normal draw", () => {
    let view = applyReplayEvent(
      initialView({ playerCount: 3, sanmaType: "kansai" }),
      {
        ...start,
        sanmaType: "kansai",
        dealer: 2,
        startingHands: [
          ["0m", ...Array<string>(12).fill("1p")],
          startingHands[1],
          startingHands[2],
        ],
      }
    );
    for (const event of [
      { type: "nuki", seat: 0, tile: "0m", stage: "completed", opening: true },
      {
        type: "draw",
        seat: 0,
        tile: "5m",
        wallRemaining: 63,
        replacementKind: "nuki",
        fromDeadWall: true,
        opening: true,
      },
      { type: "nuki", seat: 0, tile: "5m", stage: "completed", opening: true },
      {
        type: "draw",
        seat: 0,
        tile: "2p",
        wallRemaining: 63,
        replacementKind: "nuki",
        fromDeadWall: true,
        opening: true,
      },
    ] satisfies GameEvent[]) {
      view = applyReplayEvent(view, event);
    }
    expect(view.nukiTiles).toEqual([["0m", "5m"], [], []]);
    expect(view.hands.map((hand) => hand.length)).toEqual([13, 13, 13]);
    expect(view.freshlyDrawnSeat).toBeNull();
    expect(view.dealer).toBe(2);
    expect(view.turn).toBe(2);
    expect(view.phase).toBe("awaiting_draw");
    expect(view.pendingNuki).toBeNull();
    expect(view.drawsTaken).toBe(2);
    expect(view.liveDrawsTaken).toBe(0);
  });

  it("hydrates an automatic extraction awaiting replacement without showing or removing the five twice", () => {
    const state: SnapshotState = {
      ...snapshot(),
      sanmaType: "kansai",
      dealer: 2,
      turn: 2,
      hands: [Array<string>(12).fill("1p"), startingHands[1], startingHands[2]],
      nukiTiles: [["0m"], [], []],
      pendingNuki: { seat: 0, tile: "0m", opening: true },
      phase: "awaiting_nuki_replacement",
      wallRemaining: 63,
    };
    const replacement: GameEvent = {
      type: "draw",
      seat: 0,
      tile: "1s",
      opening: true,
      replacementKind: "nuki",
      fromDeadWall: true,
      wallRemaining: 63,
    };
    const replay = applyReplayEvent(snapshotToReplayView(state), replacement);
    useMatchStore.getState().hydrateSnapshot(state, 9);
    useMatchStore.getState().applyEvent(replacement, 10);
    expect(replay.hands[0]).toHaveLength(13);
    expect(replay.nukiTiles).toEqual([["0m"], [], []]);
    expect(replay.pendingNuki).toBeNull();
    expect(useMatchStore.getState().hands).toEqual(replay.hands);
    expect(useMatchStore.getState().pendingNuki).toBeNull();
  });

  it("clears inactive collections on 4→3→4 transitions in the same store", () => {
    const store = useMatchStore.getState();
    store.setMatch("switch");
    store.applyEvent(
      { ...start, playerCount: 4, startingHands: [...startingHands, ["9s"]] },
      0
    );
    store.applyEvent(start, 1);
    for (const key of [
      "hands",
      "melds",
      "discards",
      "nukiTiles",
      "scores",
      "furiten",
      "riichiDeclared",
      "ryuukyokuDeclarations",
      "chips",
      "riichiTileIdx",
    ] as const) {
      expect(useMatchStore.getState()[key]).toHaveLength(3);
    }
    store.applyEvent(
      { type: "match_start", ruleSet: "m-league", seats: [] },
      2
    );
    expect(useMatchStore.getState().hands).toEqual([[], [], [], []]);
    expect(useMatchStore.getState().nukiTiles).toEqual([[], [], [], []]);
  });

  it("does not erase a running legacy four-player hand on a roster refresh", () => {
    const store = useMatchStore.getState();
    store.applyEvent(
      { ...start, playerCount: 4, startingHands: [...startingHands, ["9s"]] },
      0
    );
    const before = useMatchStore.getState().hands;
    store.setRoomState({
      type: "room_state",
      matchId: "legacy",
      status: "playing",
      mySeat: 0,
      hostSeat: 0,
      canStart: false,
      seats: seatValues(4, (seat) => ({
        seat,
        ready: true,
        occupant: {
          kind: "bot",
          userId: `bot-${seat}`,
          displayName: `P${seat}`,
        },
      })),
    });
    expect(useMatchStore.getState().hands).toBe(before);
  });

  it("resets the previous fourth dealer when a new three-player room attaches", () => {
    const store = useMatchStore.getState();
    store.applyEvent(
      {
        ...start,
        playerCount: 4,
        dealer: 3,
        startingHands: [...startingHands, ["9s"]],
      },
      0
    );
    store.setRoomState({
      type: "room_state",
      playerCount: 3,
      sanmaType: "kansai",
      matchId: "sanma-room",
      status: "waiting",
      mySeat: 0,
      hostSeat: 0,
      canStart: false,
      seats: seatValues(3, (seat) => ({
        seat,
        ready: false,
        occupant: { kind: "empty" },
      })),
    });
    expect(useMatchStore.getState().dealer).toBe(0);
    expect(useMatchStore.getState().hands).toEqual([[], [], []]);
    expect(useMatchStore.getState().seatNames).toHaveLength(3);
  });

  it("keeps status and settlement arrays three-player and wraps the logical turn after West", () => {
    const store = useMatchStore.getState();
    store.applyEvent(start, 0);
    const update: GameEvent = {
      type: "sinking_update",
      sinking: [false, false, false],
    };
    store.applyEvent(update, 1);
    const discard: GameEvent = {
      type: "discard",
      seat: 2,
      tile: "1p",
      tsumogiri: false,
    };
    store.applyEvent(discard, 2);
    let view = applyReplayEvent(applyReplayEvent(initialView(), start), update);
    view = applyReplayEvent(view, discard);
    expect(view.turn).toBe(0);
    expect(useMatchStore.getState().turn).toBe(0);
    expect(view.sinking).toHaveLength(3);
    expect(useMatchStore.getState().sinking).toHaveLength(3);
    const result: GameEvent = {
      type: "hand_end",
      reason: "exhaustive_draw",
      delta: [3000, -1500, -1500],
      declarations: [
        { seat: 0, tenpai: true },
        { seat: 1, tenpai: false },
        { seat: 2, tenpai: false },
      ],
      tenpai: [true, false, false],
      scores: [28000, 23500, 23500],
    };
    view = applyReplayEvent(view, result);
    store.applyEvent(result, 3);
    expect(view.ryuukyokuDeclarations).toEqual([true, false, false]);
    expect(view.lastHandResult?.delta).toHaveLength(3);
    expect(useMatchStore.getState().lastHandResult?.delta).toHaveLength(3);
  });

  it("reads effective native metadata but never guesses from partial legacy external seating", () => {
    const native = log({
      events: [],
      ruleSetDetails: {
        effectiveRuleSet: { playerCount: 3, sanmaType: "kansai" },
      },
    });
    expect(replayReducer(native, -1).scores).toHaveLength(3);
    expect(replayVariant(native)).toEqual({
      rulesFamily: "riichi",
      playerCount: 3,
      sanmaType: "kansai",
    });
    expect(() => replayLogToTenhou5Json(native)).toThrow(
      UnsupportedSanmaExportError
    );
    const external = log({
      events: [],
      source: "tenhou",
      seats: [0, 1, 2].map((seat) => ({
        seat: seat as 0 | 1 | 2,
        displayName: `P${seat}`,
        finalScore: 25000,
        place: (seat + 1) as 1 | 2 | 3,
      })),
    });
    expect(replayVariant(external).playerCount).toBe(4);
    expect(replayLogToTenhou5Json(external).name).toHaveLength(4);
    expect(
      replayReducer(JSON.parse(JSON.stringify(native)) as ReplayLog, -1).scores
    ).toHaveLength(3);
  });

  it("does not rewrite explicit Duplicate replacement sources as dead-wall draws", () => {
    const annotated = annotateWallSchedule([
      {
        ...start,
        sanmaWall: {
          sanmaType: "online",
          mode: "duplicate",
          replacementsTaken: 0,
          kanCount: 0,
        },
      },
      events[3],
      events[4],
      {
        type: "draw",
        seat: 2,
        tile: "1p",
        wallRemaining: 54,
        fromDeadWall: false,
        replacementKind: "nuki",
      },
    ]);
    expect(annotated[3]).toMatchObject({
      fromDeadWall: false,
      replacementKind: "nuki",
    });
    const normal = annotateWallSchedule(events);
    expect(normal[1]).toMatchObject({ liveDrawSchedule: [0] });
    expect(normal[5]).toMatchObject({
      fromDeadWall: true,
      replacementKind: "nuki",
    });
  });

  it("counts Duplicate nuki/kan as replacements, matching resynced snapshot counters", () => {
    for (const replacementKind of ["kan", "nuki"] as const) {
      const state = {
        ...snapshot(),
        pendingNuki: null,
        drawsTaken: 0,
        liveDrawsTaken: 0,
      };
      const draw: GameEvent = {
        type: "draw",
        seat: 1,
        tile: "2s",
        wallRemaining: 53,
        replacementKind,
        fromDeadWall: false,
        sanmaWall: {
          sanmaType: "online",
          mode: "duplicate",
          replacementsTaken: 1,
          kanCount: replacementKind === "kan" ? 1 : 0,
        },
      };
      useMatchStore.getState().hydrateSnapshot(state, 4);
      useMatchStore.getState().applyEvent(draw, 5);
      const replay = applyReplayEvent(snapshotToReplayView(state), draw);
      expect(replay.drawsTaken).toBe(1);
      expect(replay.liveDrawsTaken).toBe(0);
      expect(useMatchStore.getState().drawsTaken).toBe(1);
      expect(useMatchStore.getState().liveDrawsTaken).toBe(0);
      useMatchStore.getState().hydrateSnapshot(
        {
          ...state,
          drawsTaken: 1,
          liveDrawsTaken: 0,
          sanmaWall: draw.sanmaWall,
        },
        5
      );
      expect(useMatchStore.getState().liveDrawsTaken).toBe(
        replay.liveDrawsTaken
      );
    }
  });
});
