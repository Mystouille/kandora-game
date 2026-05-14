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
  replayBounds,
  replayReducer,
  roundBoundaries,
} from "./player";
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
      },
    ]);
    const view = replayReducer(log, 1);
    expect(view.hands.map((h) => h.length)).toEqual([13, 13, 13, 13]);
    expect(view.hands[0]).toEqual(STARTING[0]);
    expect(view.hands[2]).toEqual(STARTING[2]);
    expect(view.doraIndicators).toEqual(["3m"]);
    expect(view.dealer).toBe(0);
    expect(view.roundWind).toBe("E");
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

  it("match_end populates `matchEnded.finalScores`", () => {
    const events: GameEvent[] = [
      { type: "match_start", seats: [], ruleSet: "tenhou-default" },
      {
        type: "match_end",
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
