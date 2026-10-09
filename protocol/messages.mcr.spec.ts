import { describe, expect, it } from "vitest";
import {
  GameEventSchema,
  LegalActionSchema,
  SnapshotStateSchema,
  TileSchema,
} from "./messages";

describe("MCR protocol", () => {
  it("accepts flower tiles and rules-family metadata", () => {
    expect(TileSchema.parse("1f")).toBe("1f");
    expect(TileSchema.parse("8f")).toBe("8f");
    expect(() => TileSchema.parse("9f")).toThrow();

    expect(
      GameEventSchema.parse({
        type: "match_start",
        rulesFamily: "mcr",
        seats: [
          { seat: 0, userId: "0", displayName: "East" },
          { seat: 1, userId: "1", displayName: "South" },
          { seat: 2, userId: "2", displayName: "West" },
          { seat: 3, userId: "3", displayName: "North" },
        ],
        ruleSet: "mcr-ema",
      })
    ).toMatchObject({ rulesFamily: "mcr" });
  });

  it("accepts MCR hand starts, flowers, and scored wins", () => {
    expect(() =>
      GameEventSchema.parse({
        type: "hand_start",
        rulesFamily: "mcr",
        round: 0,
        dealer: 0,
        roundWind: "E",
        roundNumber: 1,
        flowerTiles: [["1f"], [], [], []],
        seatNames: ["East", "South", "West", "North"],
        doraIndicators: [],
        liveWall: Array.from({ length: 90 }, () => "1m"),
        deadWall: [],
      })
    ).not.toThrow();
    expect(() =>
      GameEventSchema.parse({ type: "flower", seat: 0, tile: "1f" })
    ).not.toThrow();
    expect(() =>
      GameEventSchema.parse({
        type: "win",
        seat: 0,
        scoringFamily: "mcr",
        totalFan: 88,
        nonFlowerFan: 88,
        fan: [
          {
            id: "THIRTEEN_ORPHANS",
            name: "Thirteen Orphans",
            count: 1,
            points: 88,
          },
        ],
      })
    ).not.toThrow();
  });

  it("accepts a flower declaration legal action", () => {
    expect(
      LegalActionSchema.parse({
        id: "flower",
        type: "flower",
        tile: "1f",
      })
    ).toEqual({ id: "flower", type: "flower", tile: "1f" });
  });

  it("round-trips pending flower replacement snapshots", () => {
    const snapshot = SnapshotStateSchema.parse({
      rulesFamily: "mcr",
      mySeat: 0,
      hands: [
        Array.from({ length: 14 }, () => "1m"),
        Array.from({ length: 13 }, () => null),
        Array.from({ length: 13 }, () => null),
        Array.from({ length: 13 }, () => null),
      ],
      discards: [[], [], [], []],
      melds: [[], [], [], []],
      flowerTiles: [[], [], [], []],
      pendingFlower: { seat: 0, tile: "1f" },
      lastDiscard: null,
      phase: "awaiting_flower_replacement",
      wallRemaining: 80,
      doraIndicators: [],
      turn: 0,
      dealer: 0,
      roundWind: "E",
      roundNumber: 1,
      honba: 0,
      riichiSticks: 0,
      scores: [0, 0, 0, 0],
      riichiDeclared: [false, false, false, false],
      furiten: [false, false, false, false],
    });
    expect(snapshot.pendingFlower).toEqual({ seat: 0, tile: "1f" });
  });
});
