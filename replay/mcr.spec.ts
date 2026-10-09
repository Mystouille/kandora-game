import { describe, expect, it } from "vitest";
import type { GameEvent } from "../protocol/messages";
import { applyReplayEvent, initialView, replayViewToMatchView } from "./player";

const seats = [0, 1, 2, 3].map((seat) => ({
  seat: seat as 0 | 1 | 2 | 3,
  userId: String(seat),
  displayName: `Player ${seat + 1}`,
}));

describe("MCR replay folding", () => {
  it("tracks flowers and MCR score details in the neutral replay view", () => {
    const events: GameEvent[] = [
      {
        type: "match_start",
        rulesFamily: "mcr",
        seats,
        ruleSet: "mcr-ema",
      },
      {
        type: "hand_start",
        rulesFamily: "mcr",
        round: 0,
        dealer: 0,
        roundWind: "E",
        roundNumber: 1,
        flowerTiles: [[], [], [], []],
        startingHands: [
          Array.from({ length: 14 }, () => "1m"),
          Array.from({ length: 13 }, () => "2m"),
          Array.from({ length: 13 }, () => "3m"),
          Array.from({ length: 13 }, () => "4m"),
        ],
        doraIndicators: [],
      },
      { type: "draw", seat: 1, tile: "1f", wallRemaining: 90 },
      { type: "flower", seat: 1, tile: "1f" },
      {
        type: "draw",
        seat: 1,
        tile: "5m",
        wallRemaining: 89,
        replacementKind: "flower",
        fromDeadWall: false,
      },
      {
        type: "win",
        seat: 1,
        loser: 0,
        winTile: "1m",
        scoringFamily: "mcr",
        totalFan: 89,
        nonFlowerFan: 88,
        fan: [
          {
            id: "THIRTEEN_ORPHANS",
            name: "Thirteen Orphans",
            count: 1,
            points: 88,
          },
          {
            id: "FLOWER_TILES",
            name: "Flower Tiles",
            count: 1,
            points: 1,
          },
        ],
      },
      {
        type: "hand_end",
        reason: "ron",
        delta: [-97, 113, -8, -8],
      },
    ];

    let view = initialView({ rulesFamily: "mcr", playerCount: 4 });
    for (const event of events) {
      view = applyReplayEvent(view, event);
    }

    expect(view.rulesFamily).toBe("mcr");
    expect(view.flowerTiles[1]).toEqual(["1f"]);
    expect(view.lastHandResult?.wins?.[0]).toMatchObject({
      scoringFamily: "mcr",
      totalFan: 89,
      nonFlowerFan: 88,
    });
    expect(
      replayViewToMatchView(view, { index: events.length - 1 }).rulesFamily
    ).toBe("mcr");
  });
});
