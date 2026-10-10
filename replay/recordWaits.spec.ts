import { describe, expect, it } from "vitest";
import type { GameEvent, Tile } from "../protocol/messages";
import { recordMissingDiscardWaits } from "./recordWaits";
import { recordedWaitsByIndex } from "./recordedWaits";

const knittedReady = [
  "1z",
  "2z",
  "3z",
  "4z",
  "5z",
  "6z",
  "7z",
  "1m",
  "4m",
  "7m",
  "2p",
  "5p",
  "8p",
] satisfies Tile[];

const riichiReady = [
  "1m",
  "2m",
  "3m",
  "1p",
  "2p",
  "3p",
  "1s",
  "2s",
  "3s",
  "1z",
  "1z",
  "2z",
  "2z",
] satisfies Tile[];

function replayForDiscard(
  rulesFamily: "riichi" | "mcr",
  hand: Tile[],
  drawn: Tile,
  waits?: Tile[]
): GameEvent[] {
  return [
    {
      type: "match_start",
      rulesFamily,
      seats: [],
      ruleSet: rulesFamily === "mcr" ? "mcr-ema" : "tenhou",
    },
    {
      type: "hand_start",
      rulesFamily,
      round: 0,
      dealer: 1,
      startingHands: [hand, [], [], []],
      ...(rulesFamily === "mcr"
        ? { flowerTiles: [[], [], [], []], doraIndicators: [] }
        : { doraIndicators: ["1z"] }),
    },
    {
      type: "draw",
      seat: 0,
      tile: drawn,
      wallRemaining: 50,
    },
    {
      type: "discard",
      seat: 0,
      tile: drawn,
      tsumogiri: true,
      discardSource: "draw",
      ...(waits === undefined ? {} : { waits }),
    },
  ];
}

describe("recordMissingDiscardWaits", () => {
  it("records MCR waits once on a missing discard annotation", () => {
    const events = recordMissingDiscardWaits(
      replayForDiscard("mcr", knittedReady, "9s")
    );
    expect(events.at(-1)).toMatchObject({
      type: "discard",
      waits: ["3s", "6s", "9s"],
    });
  });

  it("records Riichi waits once on a missing discard annotation", () => {
    const events = recordMissingDiscardWaits(
      replayForDiscard("riichi", riichiReady, "9m")
    );
    expect(events.at(-1)).toMatchObject({
      type: "discard",
      waits: ["1z", "2z"],
    });
  });

  it("preserves authoritative platform waits", () => {
    const events = recordMissingDiscardWaits(
      replayForDiscard("riichi", riichiReady, "9m", ["9m"])
    );
    expect(events.at(-1)).toMatchObject({
      type: "discard",
      waits: ["9m"],
    });
  });

  it("leaves incomplete spectator hands unannotated", () => {
    const events = recordMissingDiscardWaits([
      {
        type: "discard",
        seat: 0,
        tile: "1m",
        tsumogiri: false,
      },
    ]);
    expect(events[0]).not.toHaveProperty("waits");
  });
});

describe("recordedWaitsByIndex", () => {
  it("does not calculate fallback waits for a legacy discard", () => {
    expect(
      recordedWaitsByIndex([
        {
          type: "discard",
          seat: 0,
          tile: "1m",
          tsumogiri: false,
        },
      ])
    ).toEqual([[[], [], [], []]]);
  });

  it("uses only recorded waits and clears the affected seat on draw", () => {
    const events: GameEvent[] = [
      {
        type: "discard",
        seat: 0,
        tile: "1m",
        tsumogiri: false,
        waits: ["2m", "3m"],
      },
      {
        type: "discard",
        seat: 1,
        tile: "4p",
        tsumogiri: false,
        waits: ["5p"],
      },
      {
        type: "draw",
        seat: 0,
        tile: "9s",
        wallRemaining: 20,
      },
      {
        type: "discard",
        seat: 0,
        tile: "9s",
        tsumogiri: true,
      },
    ];

    const snapshots = recordedWaitsByIndex(events);

    expect(snapshots[0]).toEqual([["2m", "3m"], [], [], []]);
    expect(snapshots[1]).toEqual([["2m", "3m"], ["5p"], [], []]);
    expect(snapshots[2]).toEqual([[], ["5p"], [], []]);
    expect(snapshots[3]).toEqual([[], ["5p"], [], []]);
  });
});
