import { describe, expect, it } from "vitest";
import type { HandResult } from "../scene/renderTypes";
import { resultScoreBreakdownLayout } from "./resultRowNodes";
import { buildWinResultRows } from "./resultRows";

describe("MCR result rows", () => {
  it("right-aligns only the points and flower tally", () => {
    const layout = resultScoreBreakdownLayout(30, 120, 140);

    expect(layout.pointsX + 30).toBe(layout.flowersX + 120);
    expect(layout.totalPointsX).toBe(layout.flowersX + 120 + 8);
    expect(layout.width).toBe(layout.totalPointsX + 140);
  });

  it("renders fan points without Riichi han, fu, or dora rows", () => {
    const result: HandResult & {
      wins: NonNullable<HandResult["wins"]>;
    } = {
      reason: "ron",
      delta: [-97, 113, -8, -8],
      wins: [
        {
          seat: 1,
          loser: 0,
          scoringFamily: "mcr",
          totalFan: 89,
          nonFlowerFan: 88,
          ten: 113,
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
      ],
    };

    const plan = buildWinResultRows(
      result,
      0,
      false,
      Number.POSITIVE_INFINITY,
      null,
      false
    );

    expect(plan.rows).toContainEqual({
      kind: "title",
      text: "Mahjong",
      size: 36,
    });
    expect(plan.rows).toContainEqual({
      kind: "yaku",
      name: "Thirteen Orphans",
      value: "88 pts",
      hidden: false,
    });
    expect(
      plan.rows.some(
        (row) => row.kind === "yaku" && row.name === "Flower Tiles"
      )
    ).toBe(false);
    expect(plan.rows).toContainEqual({
      kind: "scoreRow",
      han: "89 points",
      scoreBreakdown: {
        points: "88",
        flowers: "+1 flower",
        totalPoints: "= 89 points",
      },
      pts: "113 net",
      ptsColor: 0xfde68a,
      hidden: false,
    });
  });

  it("reveals MCR combinations 1.5 seconds apart without a flower row", () => {
    const result: HandResult & {
      wins: NonNullable<HandResult["wins"]>;
    } = {
      reason: "ron",
      wins: [
        {
          seat: 0,
          scoringFamily: "mcr",
          totalFan: 11,
          nonFlowerFan: 10,
          fan: [
            {
              id: "MIXED_TRIPLE_CHOW",
              name: "Mixed Triple Chow",
              count: 1,
              points: 8,
            },
            {
              id: "CONCEALED_HAND",
              name: "Concealed Hand",
              count: 1,
              points: 2,
            },
            {
              id: "FLOWER_TILES",
              name: "Flower Tiles",
              count: 1,
              points: 1,
            },
          ],
        },
      ],
    };

    const beforeFirst = buildWinResultRows(
      result,
      0,
      true,
      1_499,
      null,
      false
    );
    expect(beforeFirst.revealedYakuCount).toBe(0);
    expect(beforeFirst.scoreSummaryRevealed).toBe(false);
    expect(
      beforeFirst.rows.filter((row) => row.kind === "yaku")
    ).toMatchObject([{ hidden: true }, { hidden: true }]);

    const afterFirst = buildWinResultRows(
      result,
      0,
      true,
      1_500,
      null,
      false
    );
    expect(afterFirst.revealedYakuCount).toBe(1);
    expect(
      afterFirst.rows.filter((row) => row.kind === "yaku")
    ).toMatchObject([{ hidden: false }, { hidden: true }]);

    const beforeSecond = buildWinResultRows(
      result,
      0,
      true,
      2_999,
      null,
      false
    );
    expect(beforeSecond.revealedYakuCount).toBe(1);

    const afterSecond = buildWinResultRows(
      result,
      0,
      true,
      3_000,
      null,
      false
    );
    expect(afterSecond.revealedYakuCount).toBe(2);
    expect(afterSecond.scoreSummaryRevealed).toBe(true);
    expect(afterSecond.scoreDeltaRevealed).toBe(true);
  });

  it.each(["ron", "tsumo"] as const)(
    "announces an MCR %s win as Mahjong",
    (reason) => {
      const plan = buildWinResultRows(
        {
          reason,
          wins: [
            {
              seat: 0,
              scoringFamily: "mcr",
              totalFan: 8,
              nonFlowerFan: 8,
            },
          ],
        },
        0,
        true,
        0,
        null,
        false
      );

      expect(plan.rows).toContainEqual({
        kind: "title",
        text: "Mahjong",
        size: 36,
      });
    }
  );

  it("marks winning concealed Kongs for full result reveal", () => {
    const plan = buildWinResultRows(
      {
        reason: "tsumo",
        wins: [
          {
            seat: 0,
            scoringFamily: "mcr",
            totalFan: 8,
            nonFlowerFan: 8,
            hand: ["1m", "2m", "3m"],
            melds: [
              {
                type: "ankan",
                tiles: ["7z", "7z", "7z", "7z"],
                claimedTile: null,
                from: null,
              },
            ],
          },
        ],
      },
      0,
      false,
      Number.POSITIVE_INFINITY,
      null,
      false
    );

    expect(plan.rows.find((row) => row.kind === "hand")).toMatchObject({
      kind: "hand",
      revealConcealedKongs: true,
      melds: [
        {
          type: "ankan",
          tiles: ["7z", "7z", "7z", "7z"],
        },
      ],
    });
  });

  it.each(["ron", "tsumo"] as const)(
    "keeps the legacy Riichi %s announcement",
    (reason) => {
      const plan = buildWinResultRows(
        { reason, wins: [{ seat: 0, han: 1, fu: 30 }] },
        0,
        false,
        0,
        null,
        true
      );
      expect(plan.rows).toContainEqual({
        kind: "title",
        text: reason === "ron" ? "Ron" : "Tsumo",
        size: 36,
      });
    }
  );
});
