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
      text: "Win",
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
});
