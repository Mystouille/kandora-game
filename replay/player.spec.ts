/**
 * Replay reducer unit tests — Phase 4.5, step 2.
 *
 * Drives the pure reducer with hand-rolled fixture logs covering
 * each event type. End-to-end coverage against a real
 * `MatchProcess` archive lives in
 * `game-server/src/match.matchEnd.spec.ts`-adjacent territory; this
 * file isolates the reducer.
 */
import { describe, expect, it } from "vitest";
import type { GameEvent } from "~/game/protocol/messages";
import {
  applyReplayEvent,
  initialView,
  replayBounds,
  replayViewToMatchView,
  replayReducer,
  rotateHandResult,
  rotateSeatValues,
  roundBoundaries,
  type ReplayView,
} from "./player";
import type { MatchView } from "~/game/client/store";
import type { ReplayLog } from "./types";
import { REPLAY_LOG_SCHEMA_VERSION } from "./types";

function makeLog(events: GameEvent[]): ReplayLog {
  return {
    source: "ingame",
    sourceGameId: "test",
    ruleSet: "tenhou-default",
    startedAt: 0,
    endedAt: 1,
    seats: [0, 1, 2, 3].map((s) => ({
      seat: s as 0 | 1 | 2 | 3,
      displayName: `Seat ${s}`,
      finalScore: 25000,
      place: (s + 1) as 1 | 2 | 3 | 4,
    })),
    events,
    schemaVersion: REPLAY_LOG_SCHEMA_VERSION,
  };
}

describe("ruleset capabilities", () => {
  it("carries disabled ura dora from match start into the renderer view", () => {
    const replayView = applyReplayEvent(initialView(), {
      type: "match_start",
      seats: [],
      ruleSet: "jpml-hanchan",
      uraDoraEnabled: false,
    });

    expect(replayView.uraDoraEnabled).toBe(false);
    expect(replayViewToMatchView(replayView, { index: 0 }).uraDoraEnabled).toBe(
      false
    );
  });

  it("defaults legacy logs without the capability to ura dora enabled", () => {
    const replayView = applyReplayEvent(initialView(), {
      type: "match_start",
      seats: [],
      ruleSet: "tenhou-default",
    });

    expect(replayView.uraDoraEnabled).toBe(true);
  });
});

/** Reusable fixture for the omniscient `startingHands` field. */
const STARTING: [string[], string[], string[], string[]] = [
  [
    "1m",
    "2m",
    "3m",
    "4m",
    "5m",
    "6m",
    "7m",
    "8m",
    "9m",
    "1p",
    "2p",
    "3p",
    "4p",
  ],
  [
    "5p",
    "6p",
    "7p",
    "8p",
    "9p",
    "1s",
    "2s",
    "3s",
    "4s",
    "5s",
    "6s",
    "7s",
    "8s",
  ],
  [
    "9s",
    "1z",
    "1z",
    "2z",
    "2z",
    "3z",
    "3z",
    "4z",
    "4z",
    "5z",
    "5z",
    "6z",
    "6z",
  ],
  [
    "7z",
    "7z",
    "1m",
    "2m",
    "3m",
    "4m",
    "5m",
    "6m",
    "7m",
    "8m",
    "9m",
    "1p",
    "2p",
  ],
];

describe("rotateSeatValues", () => {
  it("keeps seat metadata attached when focus moves to seat 2", () => {
    expect(rotateSeatValues(["team-0", "team-1", "team-2", "team-3"], 2)).toEqual(
      ["team-2", "team-3", "team-0", "team-1"]
    );
  });
});

describe("rotateHandResult", () => {
  it("rotates score transfers and winner seats into the viewer's frame", () => {
    const result: NonNullable<MatchView["lastHandResult"]> = {
      reason: "ron",
      dealer: 2,
      delta: [8000, -8000, 0, 0],
      scores: [33000, 17000, 25000, 25000],
      declarations: [
        { seat: 0, tenpai: true },
        { seat: 1, tenpai: false },
      ],
      wins: [
        {
          seat: 0,
          loser: 1,
          han: 4,
          fu: 30,
          ten: 8000,
          melds: [
            {
              type: "pon",
              tiles: ["5p", "5p", "5p"],
              claimedTile: "5p",
              from: 2,
            },
          ],
        },
      ],
    };

    const rotated = rotateHandResult(result, 1);

    expect(rotated.delta).toEqual([-8000, 0, 0, 8000]);
    expect(rotated.scores).toEqual([17000, 25000, 25000, 33000]);
    expect(rotated.dealer).toBe(1);
    expect(rotated.declarations).toEqual([
      { seat: 3, tenpai: true },
      { seat: 0, tenpai: false },
    ]);
    expect(rotated.wins).toEqual([
      {
        seat: 3,
        loser: 0,
        han: 4,
        fu: 30,
        ten: 8000,
        melds: [
          {
            type: "pon",
            tiles: ["5p", "5p", "5p"],
            claimedTile: "5p",
            from: 1,
          },
        ],
      },
    ]);
    expect(result.delta).toEqual([8000, -8000, 0, 0]);
  });
});

describe("replayReducer", () => {
  it("returns the initial view when index is below match_start", () => {
    const log = makeLog([
      { type: "match_start", seats: [], ruleSet: "tenhou-default" },
    ]);
    const view = replayReducer(log, -1);
    expect(view.hands).toEqual([[], [], [], []]);
    expect(view.discards).toEqual([[], [], [], []]);
    expect(view.matchEnded).toBeNull();
  });

  it("hand_start seeds the omniscient starting hands per seat", () => {
    const log = makeLog([
      { type: "match_start", seats: [], ruleSet: "tenhou-default" },
      {
        type: "hand_start",
        round: 0,
        dealer: 0,
        roundWind: "E",
        roundNumber: 1,
        honba: 0,
        riichiSticks: 0,
        scores: [25000, 25000, 25000, 25000],
        startingHands: STARTING,
        doraIndicators: ["3m"],
        deadWall: [
          "1m",
          "2m",
          "3m",
          "4m",
          "5m",
          "6m",
          "7m",
          "8m",
          "9m",
          "1p",
          "2p",
          "3p",
          "4p",
          "5p",
        ],
      },
    ]);
    const view = replayReducer(log, 1);
    expect(view.hands.map((h) => h.length)).toEqual([13, 13, 13, 13]);
    expect(view.hands[0]).toEqual(STARTING[0]);
    expect(view.hands[2]).toEqual(STARTING[2]);
    expect(view.doraIndicators).toEqual(["3m"]);
    expect(view.deadWall).toEqual([
      "1m",
      "2m",
      "3m",
      "4m",
      "5m",
      "6m",
      "7m",
      "8m",
      "9m",
      "1p",
      "2p",
      "3p",
      "4p",
      "5p",
    ]);
    expect(view.dealer).toBe(0);
    expect(view.roundWind).toBe("E");
  });

  it("applies live declarations immutably and reveals only Tenpai hands", () => {
    const initial = {
      ...initialView(),
      hands: STARTING.map((hand) => [...hand]),
    };
    const tenpai = applyReplayEvent(initial, {
      type: "ryuukyoku_declaration",
      seat: 1,
      tenpai: true,
      hand: STARTING[1],
    });
    const noten = applyReplayEvent(tenpai, {
      type: "ryuukyoku_declaration",
      seat: 2,
      tenpai: false,
    });

    expect(initial.ryuukyokuDeclarations).toEqual([null, null, null, null]);
    expect(initial.ryuukyokuTenpaiHands).toEqual([null, null, null, null]);
    expect(noten.ryuukyokuDeclarations).toEqual([null, true, false, null]);
    expect(noten.ryuukyokuTenpaiHands[1]).toEqual(STARTING[1]);
    expect(noten.ryuukyokuTenpaiHands[1]).not.toBe(STARTING[1]);
    expect(noten.ryuukyokuTenpaiHands[2]).toBeNull();
  });

  it("resets declaration state on hand_start", () => {
    const declared = applyReplayEvent(initialView(), {
      type: "ryuukyoku_declaration",
      seat: 0,
      tenpai: true,
      hand: STARTING[0],
    });

    const nextHand = applyReplayEvent(declared, {
      type: "hand_start",
      round: 1,
      dealer: 1,
      startingHands: STARTING,
      doraIndicators: ["6p"],
    });

    expect(nextHand.ryuukyokuDeclarations).toEqual([
      null,
      null,
      null,
      null,
    ]);
    expect(nextHand.ryuukyokuTenpaiHands).toEqual([
      null,
      null,
      null,
      null,
    ]);
  });

  it("resets declaration state on a new Buu match_start", () => {
    const declared = applyReplayEvent(initialView(), {
      type: "ryuukyoku_declaration",
      seat: 0,
      tenpai: true,
      hand: STARTING[0],
    });

    const reset = applyReplayEvent(declared, {
      type: "match_start",
      seats: [],
      ruleSet: "buu-east",
    });

    expect(reset.ryuukyokuDeclarations).toEqual([null, null, null, null]);
    expect(reset.ryuukyokuTenpaiHands).toEqual([null, null, null, null]);
  });

  it("applies merged archived declarations immediately at hand_end", () => {
    const before = {
      ...initialView(),
      hands: STARTING.map((hand) => [...hand]),
    };
    const after = applyReplayEvent(before, {
      type: "hand_end",
      reason: "exhaustive_draw",
      declarations: [
        { seat: 0, tenpai: true },
        { seat: 1, tenpai: false },
        { seat: 2, tenpai: true },
        { seat: 3, tenpai: false },
      ],
      tenpai: [true, false, true, false],
      tenpaiHands: [STARTING[0], null, STARTING[2], null],
    });

    expect(after.ryuukyokuDeclarations).toEqual([true, false, true, false]);
    expect(after.ryuukyokuTenpaiHands).toEqual([
      STARTING[0],
      null,
      STARTING[2],
      null,
    ]);
    expect(after.lastHandResult?.declarations).toEqual([
      { seat: 0, tenpai: true },
      { seat: 1, tenpai: false },
      { seat: 2, tenpai: true },
      { seat: 3, tenpai: false },
    ]);
  });

  it("leaves declaration state unchanged for legacy hand_end events", () => {
    const declared = applyReplayEvent(initialView(), {
      type: "ryuukyoku_declaration",
      seat: 3,
      tenpai: false,
    });
    const after = applyReplayEvent(declared, {
      type: "hand_end",
      reason: "exhaustive_draw",
      tenpai: [true, false, true, false],
      tenpaiHands: [STARTING[0], null, STARTING[2], null],
    });

    expect(after.ryuukyokuDeclarations).toBe(
      declared.ryuukyokuDeclarations
    );
    expect(after.ryuukyokuTenpaiHands).toBe(
      declared.ryuukyokuTenpaiHands
    );
    expect(after.lastHandResult?.declarations).toBeUndefined();
  });

  it("rotates declaration state with replay focus", () => {
    const replayView = {
      ...initialView(),
      ryuukyokuDeclarations: [true, false, null, true],
      ryuukyokuTenpaiHands: [
        STARTING[0],
        null,
        null,
        STARTING[3],
      ],
    } as ReplayView;

    const focused = replayViewToMatchView(replayView, {
      index: 4,
      mySeat: 2,
    });

    expect(focused.ryuukyokuDeclarations).toEqual([null, true, true, false]);
    expect(focused.ryuukyokuTenpaiHands).toEqual([
      null,
      STARTING[3],
      STARTING[0],
      null,
    ]);
  });

  it("draw appends the drawn tile to the drawing seat's hand", () => {
    const log = makeLog([
      { type: "match_start", seats: [], ruleSet: "tenhou-default" },
      {
        type: "hand_start",
        round: 0,
        dealer: 0,
        roundWind: "E",
        roundNumber: 1,
        startingHands: STARTING,
        doraIndicators: ["3m"],
      },
      { type: "draw", seat: 0, tile: "5m", wallRemaining: 69 },
    ]);
    const view = replayReducer(log, 2);
    expect(view.hands[0].length).toBe(14);
    expect(view.hands[0][13]).toBe("5m");
    expect(view.wallRemaining).toBe(69);
  });

  it("retains duplicate walls and rotates the limiting player with focus", () => {
    const queues = [
      new Array(18).fill("1m"),
      new Array(18).fill("2m"),
      new Array(17).fill("3m"),
      new Array(17).fill("4m"),
    ] as [string[], string[], string[], string[]];
    const log = makeLog([
      { type: "match_start", seats: [], ruleSet: "tenhou-default" },
      {
        type: "hand_start",
        round: 0,
        dealer: 0,
        startingHands: STARTING,
        doraIndicators: ["3m"],
        duplicateDrawQueues: queues,
        duplicateWallState: {
          initial: [18, 18, 17, 17],
          remaining: [18, 18, 17, 17],
          limitingSeat: 2,
          estimatedDrawsRemaining: 70,
        },
      },
      {
        type: "draw",
        seat: 0,
        tile: "1m",
        wallRemaining: 69,
        duplicateWallState: {
          initial: [18, 18, 17, 17],
          remaining: [17, 18, 17, 17],
          limitingSeat: 2,
          estimatedDrawsRemaining: 69,
        },
      },
    ]);

    const replayView = replayReducer(log, 2);
    expect(replayView.duplicateDrawQueues).toEqual(queues);
    expect(replayView.duplicateWallState).toEqual({
      initial: [18, 18, 17, 17],
      remaining: [17, 18, 17, 17],
      limitingSeat: 2,
      estimatedDrawsRemaining: 69,
    });

    const matchView = replayViewToMatchView(replayView, {
      index: 2,
      mySeat: 2,
    });
    expect(matchView.duplicateDrawQueues?.map((queue) => queue[0])).toEqual([
      "3m",
      "4m",
      "1m",
      "2m",
    ]);
    expect(matchView.duplicateWallState).toEqual({
      initial: [17, 17, 18, 18],
      remaining: [17, 17, 17, 18],
      limitingSeat: 0,
      estimatedDrawsRemaining: 69,
    });
  });

  it("reconstructs duplicate counts for archives recorded before wall-state events", () => {
    const queues = [
      new Array(18).fill("1m"),
      new Array(18).fill("2m"),
      new Array(17).fill("3m"),
      new Array(17).fill("4m"),
    ] as [string[], string[], string[], string[]];
    const log = makeLog([
      { type: "match_start", seats: [], ruleSet: "tenhou-default" },
      {
        type: "hand_start",
        round: 0,
        dealer: 0,
        startingHands: STARTING,
        doraIndicators: ["3m"],
        duplicateDrawQueues: queues,
      },
      { type: "draw", seat: 0, tile: "1m", wallRemaining: 69 },
      {
        type: "discard",
        seat: 0,
        tile: "1m",
        tsumogiri: true,
        discardSource: "draw",
      },
      {
        type: "call",
        seat: 2,
        meld: {
          type: "pon",
          tiles: ["1m", "1m", "1m"],
          claimedTile: "1m",
          from: 0,
        },
      },
    ]);

    expect(replayReducer(log, 4).duplicateWallState).toEqual({
      initial: [18, 18, 17, 17],
      remaining: [17, 18, 17, 17],
      limitingSeat: 3,
      estimatedDrawsRemaining: 68,
    });
  });

  it("clears the duplicate forecast when a replay ends without hand_end", () => {
    const log = makeLog([
      { type: "match_start", seats: [], ruleSet: "tenhou-default" },
      {
        type: "hand_start",
        round: 0,
        dealer: 0,
        startingHands: STARTING,
        doraIndicators: ["3m"],
        duplicateWallState: {
          initial: [18, 18, 17, 17],
          remaining: [18, 18, 17, 17],
          limitingSeat: 2,
          estimatedDrawsRemaining: 70,
        },
      },
      {
        type: "match_end",
        reason: "round_limit",
        finalScores: [],
      },
    ]);

    expect(replayReducer(log, 2).duplicateWallState).toEqual({
      initial: [18, 18, 17, 17],
      remaining: [18, 18, 17, 17],
      limitingSeat: null,
      estimatedDrawsRemaining: null,
    });
  });

  it("discard removes a real tile from hand and lands it in the pile", () => {
    const events: GameEvent[] = [
      { type: "match_start", seats: [], ruleSet: "tenhou-default" },
      {
        type: "hand_start",
        round: 0,
        dealer: 0,
        roundWind: "E",
        roundNumber: 1,
        startingHands: STARTING,
        doraIndicators: ["3m"],
      },
      { type: "draw", seat: 0, tile: "9p", wallRemaining: 69 },
      { type: "discard", seat: 0, tile: "9p", tsumogiri: true },
    ];
    const view = replayReducer(makeLog(events), 3);
    expect(view.hands[0].length).toBe(13);
    expect(view.discards[0]).toEqual(["9p"]);
  });

  it("preserves the drawn copy when an identical hand tile is discarded", () => {
    const tile = STARTING[0][0];
    const events: GameEvent[] = [
      { type: "match_start", seats: [], ruleSet: "tenhou-default" },
      {
        type: "hand_start",
        round: 0,
        dealer: 0,
        startingHands: STARTING,
        doraIndicators: ["3m"],
      },
      { type: "draw", seat: 0, tile, wallRemaining: 69 },
      {
        type: "discard",
        seat: 0,
        tile,
        tsumogiri: false,
        discardSource: "hand",
      },
    ];

    const view = replayReducer(makeLog(events), 3);

    expect(view.hands[0]).toEqual([...STARTING[0].slice(1), tile]);
    expect(view.discardSources?.[0]).toEqual(["hand"]);
  });

  it("riichi discard flips the seat's flag and records the tile index", () => {
    const events: GameEvent[] = [
      { type: "match_start", seats: [], ruleSet: "tenhou-default" },
      {
        type: "hand_start",
        round: 0,
        dealer: 0,
        roundWind: "E",
        roundNumber: 1,
        startingHands: STARTING,
        doraIndicators: ["3m"],
      },
      { type: "draw", seat: 1, tile: "1z", wallRemaining: 69 },
      { type: "discard", seat: 1, tile: "1z", tsumogiri: false, riichi: true },
    ];
    const view = replayReducer(makeLog(events), 3);
    expect(view.riichiDeclared[1]).toBe(true);
    expect(view.riichiTileIdx[1]).toBe(0);
  });

  it("kyuushuu abort reveals only the declaring seat's hand", () => {
    // Seat 2 draws its 14th tile and declares kyuushuu kyuuhai
    // without discarding, so `freshlyDrawnSeat` points at it. The
    // reducer must reveal that seat's full 14-tile hand through
    // `tenpaiHands` and leave every other seat null.
    const events: GameEvent[] = [
      { type: "match_start", seats: [], ruleSet: "tenhou-default" },
      {
        type: "hand_start",
        round: 0,
        dealer: 3,
        roundWind: "E",
        roundNumber: 1,
        startingHands: STARTING,
        doraIndicators: ["3m"],
      },
      { type: "draw", seat: 2, tile: "1m", wallRemaining: 69 },
      { type: "hand_end", reason: "abort", abortKind: "kyuushuu" },
    ];
    const view = replayReducer(makeLog(events), 3);
    expect(view.lastHandResult?.reason).toBe("abort");
    expect(view.lastHandResult?.abortKind).toBe("kyuushuu");
    expect(view.lastHandResult?.dealer).toBe(3);
    const revealed = view.lastHandResult?.tenpaiHands;
    expect(revealed).toBeDefined();
    expect(revealed?.[2]).toEqual([...STARTING[2], "1m"]);
    expect(revealed?.[0]).toBeNull();
    expect(revealed?.[1]).toBeNull();
    expect(revealed?.[3]).toBeNull();
  });

  it("match_end populates `matchEnded.finalScores`", () => {
    const events: GameEvent[] = [
      { type: "match_start", seats: [], ruleSet: "tenhou-default" },
      {
        type: "match_end",
        reason: "round_limit",
        finalScores: [
          { seat: 0, score: 40000, place: 1 },
          { seat: 1, score: 30000, place: 2 },
          { seat: 2, score: 20000, place: 3 },
          { seat: 3, score: 10000, place: 4 },
        ],
      },
    ];
    const view = replayReducer(makeLog(events), 1);
    expect(view.matchEnded?.finalScores[0].score).toBe(40000);
  });

  it("incremental apply matches whole-prefix fold", () => {
    const events: GameEvent[] = [
      { type: "match_start", seats: [], ruleSet: "tenhou-default" },
      {
        type: "hand_start",
        round: 0,
        dealer: 0,
        roundWind: "E",
        roundNumber: 1,
        startingHands: STARTING,
        doraIndicators: ["3m"],
      },
      { type: "draw", seat: 0, tile: "9p", wallRemaining: 69 },
      { type: "discard", seat: 0, tile: "9p", tsumogiri: true },
      { type: "draw", seat: 1, tile: "1z", wallRemaining: 68 },
    ];
    const log = makeLog(events);
    let incremental = replayReducer(log, -1);
    for (let i = 0; i < events.length; i++) {
      incremental = applyReplayEvent(incremental, events[i]);
    }
    const wholeFold = replayReducer(log, events.length - 1);
    // Deep equality via JSON since both are plain data.
    expect(JSON.stringify(incremental)).toBe(JSON.stringify(wholeFold));
  });

  it("replayBounds + roundBoundaries", () => {
    const events: GameEvent[] = [
      { type: "match_start", seats: [], ruleSet: "tenhou-default" },
      {
        type: "hand_start",
        round: 0,
        dealer: 0,
        roundWind: "E",
        roundNumber: 1,
        startingHands: STARTING,
        doraIndicators: ["3m"],
      },
      { type: "draw", seat: 0, tile: "5m", wallRemaining: 69 },
      {
        type: "hand_start",
        round: 1,
        dealer: 1,
        roundWind: "E",
        roundNumber: 2,
        startingHands: STARTING,
        doraIndicators: ["6p"],
      },
    ];
    const log = makeLog(events);
    expect(replayBounds(log)).toEqual({ min: -1, max: 3 });
    expect(roundBoundaries(log)).toEqual([1, 3]);
  });
});
