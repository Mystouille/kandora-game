import { describe, expect, it } from "vitest";
import type { HandResult } from "../scene/renderTypes";
import { buildWinResultRows } from "./resultRows";

describe("MCR result rows", () => {
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
    });
    expect(plan.rows).toContainEqual({
      kind: "scoreRow",
      han: "88 + 1 flower = 89 points",
      pts: "113 net",
      ptsColor: 0xfde68a,
    });
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
