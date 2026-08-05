import { describe, expect, it } from "vitest";
import type { ReplayLog } from "./types";
import { replayLogToTenhou5Json } from "./replayLogToTenhou5Json";

function replayWithEvents(events: ReplayLog["events"]): ReplayLog {
  return {
    source: "riichicity",
    sourceGameId: "test-game",
    ruleSet: "riichicity",
    startedAt: 0,
    endedAt: 0,
    seats: [0, 1, 2, 3].map((seat) => ({
      seat: seat as 0 | 1 | 2 | 3,
      displayName: `Player ${seat + 1}`,
      finalScore: 25000,
      place: (seat + 1) as 1 | 2 | 3 | 4,
    })),
    events,
    schemaVersion: 1,
  };
}

describe("replayLogToTenhou5Json", () => {
  it("uses the explicit hand number independently of the dealer seat", () => {
    const converted = replayLogToTenhou5Json(
      replayWithEvents([
        {
          type: "hand_start",
          round: 0,
          dealer: 3,
          roundWind: "E",
          roundNumber: 1,
          scores: [25000, 25000, 25000, 25000],
          startingHands: [[], [], [], []],
          doraIndicators: [],
        },
        { type: "hand_end", reason: "exhaustive_draw" },
      ])
    );

    const round = converted.log[0] as unknown[];
    expect(round[0]).toEqual([0, 0, 0]);
  });

  it("preserves the two owned copies when encoding a pon", () => {
    const converted = replayLogToTenhou5Json(
      replayWithEvents([
        {
          type: "hand_start",
          round: 0,
          dealer: 0,
          scores: [25000, 25000, 25000, 25000],
          startingHands: [[], [], [], []],
          doraIndicators: [],
        },
        { type: "discard", seat: 0, tile: "5m", tsumogiri: false },
        {
          type: "call",
          seat: 1,
          meld: {
            type: "pon",
            tiles: ["5m", "5m", "5m"],
            claimedTile: "5m",
            from: 0,
          },
        },
        { type: "hand_end", reason: "exhaustive_draw" },
      ])
    );

    const round = converted.log[0] as unknown[];
    expect(round[8]).toEqual(["p151515"]);
  });

  it("places a dealer pon immediately after its explicit opening draw", () => {
    const dealerHand = [
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
    ];
    const converted = replayLogToTenhou5Json(
      replayWithEvents([
        {
          type: "hand_start",
          round: 0,
          dealer: 3,
          scores: [25000, 25000, 25000, 25000],
          startingHands: [[], [], [], dealerHand],
          doraIndicators: [],
        },
        { type: "draw", seat: 3, tile: "1z", wallRemaining: 69 },
        { type: "discard", seat: 3, tile: "1p", tsumogiri: false },
        { type: "discard", seat: 1, tile: "9m", tsumogiri: false },
        {
          type: "call",
          seat: 3,
          meld: {
            type: "pon",
            tiles: ["9m", "9m", "9m"],
            claimedTile: "9m",
            from: 1,
          },
        },
        { type: "discard", seat: 3, tile: "7p", tsumogiri: false },
        { type: "hand_end", reason: "exhaustive_draw" },
      ])
    );

    const round = converted.log[0] as unknown[];
    expect(round[13]).toHaveLength(13);
    expect(round[14]).toEqual([41, "19p1919"]);
  });

  it("uses canonical Tenhou role names in win results", () => {
    const converted = replayLogToTenhou5Json(
      replayWithEvents([
        {
          type: "hand_start",
          round: 0,
          dealer: 3,
          roundWind: "S",
          roundNumber: 2,
          scores: [25000, 25000, 25000, 25000],
          startingHands: [[], [], [], []],
          doraIndicators: [],
        },
        {
          type: "win",
          seat: 1,
          loser: 2,
          delta: [0, 2000, -2000, 0],
          han: 4,
          fu: 30,
          ten: 2000,
          yaku: {
            Haku: "1飜",
            Tanyao: "1飜",
            Jikaze: "1飜",
            Bakaze: "1飜",
            "Aka Dora": "1飜",
          },
        },
        {
          type: "hand_end",
          reason: "ron",
          delta: [0, 2000, -2000, 0],
        },
      ])
    );

    const round = converted.log[0] as unknown[];
    const result = round[16] as unknown[];
    expect(result[2]).toEqual([
      1,
      2,
      1,
      "30符4飜2000点",
      "役牌 白(1飜)",
      "断么九(1飜)",
      "自風 西(1飜)",
      "場風 南(1飜)",
      "赤ドラ(1飜)",
    ]);
  });
});
