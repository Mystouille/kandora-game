import { describe, expect, it } from "vitest";
import { tableLayoutFromConfig } from "../tableLayout";
import { currentTableLayout } from "../layouts/currentTableLayout";
import { tenhouTileDesign } from "../tiles/designs/tenhouTileDesign";
import {
  buildDuplicateWallPlan,
  type DuplicateWallPlanInput,
} from "./duplicateWallPlan";

const layout = tableLayoutFromConfig(currentTableLayout);
const metrics: DuplicateWallPlanInput["metrics"] = {
  upright: tenhouTileDesign.metrics.wallUpright,
  side: tenhouTileDesign.metrics.wallSide,
  sideOverlap: tenhouTileDesign.spacing.wallSide,
};

function input(
  overrides: Partial<DuplicateWallPlanInput["view"]> = {},
  showWalls = false
): DuplicateWallPlanInput {
  return {
    layout,
    metrics,
    showWalls,
    view: {
      dealer: 0,
      doraIndicators: ["4p"],
      deadWall: null,
      duplicateDrawQueues: null,
      duplicateWallState: {
        initial: [18, 18, 17, 17],
        remaining: [18, 18, 17, 17],
        limitingSeat: 2,
        estimatedDrawsRemaining: 70,
      },
      ...overrides,
    },
  };
}

describe("buildDuplicateWallPlan", () => {
  it("renders four personal walls and ten fixed dealer dead-wall tiles", () => {
    const plan = buildDuplicateWallPlan(input());

    expect(plan.tiles).toHaveLength(80);
    expect(plan.tiles.filter((tile) => tile.kind === "live")).toHaveLength(70);
    expect(plan.tiles.filter((tile) => tile.kind === "dead")).toHaveLength(10);
    expect(
      [0, 1, 2, 3].map(
        (seat) =>
          plan.tiles.filter(
            (tile) => tile.kind === "live" && tile.seat === seat
          ).length
      )
    ).toEqual([18, 18, 17, 17]);
    expect(
      new Set(
        plan.tiles
          .filter((tile) => tile.kind === "dead")
          .map((tile) => tile.seat)
      )
    ).toEqual(new Set([0]));
  });

  it("draws from player-right, upper then lower, with a lower lone tile", () => {
    const plan = buildDuplicateWallPlan(input());
    const seatZeroFirst = plan.tiles.find(
      (tile) => tile.kind === "live" && tile.seat === 0 && tile.sourceIndex === 0
    );
    const seatZeroSecond = plan.tiles.find(
      (tile) => tile.kind === "live" && tile.seat === 0 && tile.sourceIndex === 1
    );
    const seatTwoLast = plan.tiles.find(
      (tile) => tile.kind === "live" && tile.seat === 2 && tile.sourceIndex === 16
    );

    expect(seatZeroFirst).toMatchObject({ stackIndex: 8, row: 1 });
    expect(seatZeroSecond).toMatchObject({ stackIndex: 8, row: 0 });
    expect(seatTwoLast).toMatchObject({ stackIndex: 0, row: 0 });
    expect(
      plan.tiles.some(
        (tile) =>
          tile.kind === "live" &&
          tile.seat === 2 &&
          tile.stackIndex === 0 &&
          tile.row === 1
      )
    ).toBe(false);
  });

  it("removes one personal tile without moving any remaining slot", () => {
    const before = buildDuplicateWallPlan(input());
    const after = buildDuplicateWallPlan(
      input({
        duplicateWallState: {
          initial: [18, 18, 17, 17],
          remaining: [17, 18, 17, 17],
          limitingSeat: 2,
          estimatedDrawsRemaining: 69,
        },
      })
    );
    const beforeByTile = new Map(
      before.tiles
        .filter((tile) => tile.kind === "live" && tile.seat === 0)
        .map((tile) => [tile.sourceIndex, tile])
    );

    expect(
      after.tiles.some(
        (tile) => tile.kind === "live" && tile.seat === 0 && tile.sourceIndex === 0
      )
    ).toBe(false);
    for (const tile of after.tiles.filter(
      (candidate) => candidate.kind === "live" && candidate.seat === 0
    )) {
      expect(tile).toMatchObject({
        x: beforeByTile.get(tile.sourceIndex)?.x,
        y: beforeByTile.get(tile.sourceIndex)?.y,
      });
    }
  });

  it("places the dead wall on the dealer's player-left before a fixed gap", () => {
    const plan = buildDuplicateWallPlan(
      input({
        dealer: 2,
        duplicateWallState: {
          initial: [17, 17, 18, 18],
          remaining: [17, 17, 18, 18],
          limitingSeat: 0,
          estimatedDrawsRemaining: 70,
        },
      })
    );
    const dealerDeadSlots = plan.tiles
      .filter((tile) => tile.kind === "dead" && tile.seat === 2)
      .map((tile) => tile.groupSlotIndex);
    const dealerPersonalSlots = plan.tiles
      .filter((tile) => tile.kind === "live" && tile.seat === 2)
      .map((tile) => tile.groupSlotIndex);

    expect(Math.max(...dealerDeadSlots)).toBe(4);
    expect(Math.min(...dealerPersonalSlots)).toBe(6);
    expect(
      plan.tiles.some(
        (tile) => tile.seat === 2 && tile.groupSlotIndex === 5
      )
    ).toBe(false);
  });

  it("reveals archived personal and dora/ura faces with fixed dead indices", () => {
    const queues = [
      Array.from({ length: 18 }, (_, index) => (index === 0 ? "1m" : "9p")),
      new Array(18).fill("2m"),
      new Array(17).fill("3m"),
      new Array(17).fill("4m"),
    ];
    const deadWall = Array.from({ length: 14 }, (_, index) =>
      index === 4 ? "1z" : index === 5 ? "2z" : "9s"
    );
    const plan = buildDuplicateWallPlan(
      input(
        {
          duplicateDrawQueues: queues as [string[], string[], string[], string[]],
          deadWall,
        },
        true
      )
    );

    expect(
      plan.tiles.find(
        (tile) => tile.kind === "live" && tile.seat === 0 && tile.sourceIndex === 0
      )?.faceUpTile
    ).toBe("1m");
    expect(
      plan.tiles.find(
        (tile) => tile.kind === "dead" && tile.sourceIndex === 4
      )
    ).toMatchObject({ faceUpTile: "4p", tone: "normal", row: 1 });
    expect(
      plan.tiles.find(
        (tile) => tile.kind === "dead" && tile.sourceIndex === 5
      )
    ).toMatchObject({ faceUpTile: "2z", tone: "deemphasized", row: 0 });
    expect(
      plan.tiles.some(
        (tile) => tile.kind === "dead" && tile.sourceIndex < 4
      )
    ).toBe(false);
  });

  it("keeps every rotated wall inside its band for every dealer", () => {
    for (const dealer of [0, 1, 2, 3] as const) {
      const initial = [17, 17, 17, 17] as [number, number, number, number];
      initial[dealer] = 18;
      initial[((dealer + 1) % 4) as 0 | 1 | 2 | 3] = 18;
      const plan = buildDuplicateWallPlan(
        input({
          dealer,
          duplicateWallState: {
            initial,
            remaining: [...initial],
            limitingSeat: ((dealer + 2) % 4) as 0 | 1 | 2 | 3,
            estimatedDrawsRemaining: 70,
          },
        })
      );
      expect(
        new Set(
          plan.tiles
            .filter((tile) => tile.kind === "dead")
            .map((tile) => tile.seat)
        )
      ).toEqual(new Set([dealer]));
      for (const tile of plan.tiles) {
        const band = layout.wall[tile.seat];
        expect(tile.x).toBeGreaterThanOrEqual(band.x - 8);
        expect(tile.y).toBeGreaterThanOrEqual(band.y - 16);
        expect(tile.x + tile.width).toBeLessThanOrEqual(
          band.x + band.w + 8
        );
        expect(tile.y + tile.height).toBeLessThanOrEqual(
          band.y + band.h + 16
        );
      }
    }
  });
});