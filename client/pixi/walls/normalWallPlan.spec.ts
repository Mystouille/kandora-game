import { describe, expect, it } from "vitest";
import { tableLayoutFromConfig } from "../tableLayout";
import { currentTableLayout } from "../layouts/currentTableLayout";
import { tenhouTileDesign } from "../tiles/designs/tenhouTileDesign";
import {
  buildNormalWallPlan,
  type NormalWallPlanInput,
} from "./normalWallPlan";

const layout = tableLayoutFromConfig(currentTableLayout);
const metrics: NormalWallPlanInput["metrics"] = {
  upright: tenhouTileDesign.metrics.wallUpright,
  side: tenhouTileDesign.metrics.wallSide,
  sideOverlap: tenhouTileDesign.spacing.wallSide,
};

function input(
  overrides: Partial<NormalWallPlanInput["view"]> = {},
  options: Partial<
    Pick<NormalWallPlanInput, "showWalls" | "showUndealtWall">
  > = {}
): NormalWallPlanInput {
  return {
    layout,
    metrics,
    showWalls: false,
    showUndealtWall: false,
    view: {
      dealer: 0,
      dice: [3, 4],
      drawsTaken: 0,
      liveDrawsTaken: 0,
      doraIndicators: ["4p"],
      liveWall: null,
      deadWall: null,
      liveDrawSchedule: null,
      mySeat: 0,
      ...overrides,
    },
    ...options,
  };
}

describe("buildNormalWallPlan", () => {
  it("renders the MCR wall without a reserved dead wall", () => {
    const initial = buildNormalWallPlan(
      input({
        rulesFamily: "mcr",
        flowerTiles: [[], [], [], []],
        wallRemaining: 91,
        doraIndicators: [],
      })
    );
    const afterHeadAndTailDraw = buildNormalWallPlan(
      input({
        rulesFamily: "mcr",
        flowerTiles: [[], [], [], []],
        wallRemaining: 89,
        drawsTaken: 2,
        liveDrawsTaken: 1,
        doraIndicators: [],
      })
    );

    expect(initial.tiles).toHaveLength(91);
    expect(initial.tiles.every((tile) => tile.kind === "live")).toBe(true);
    expect(afterHeadAndTailDraw.tiles).toHaveLength(89);
  });

  it("continues MCR draws clockwise from the wall split", () => {
    const plan = buildNormalWallPlan(
      input({
        rulesFamily: "mcr",
        flowerTiles: [[], [], [], []],
        wallRemaining: 91,
        doraIndicators: [],
      })
    );

    expect(plan.tiles.find((tile) => tile.sourceIndex === 0)).toMatchObject({
      seat: 1,
      stackIndex: 2,
      row: 0,
    });
    expect(plan.tiles.find((tile) => tile.sourceIndex === 1)).toMatchObject({
      seat: 1,
      stackIndex: 1,
      row: 1,
    });
  });

  it("takes MCR replacement tiles from the wall tail, top tile first", () => {
    const afterOne = buildNormalWallPlan(
      input({
        rulesFamily: "mcr",
        flowerTiles: [["1f"], [], [], []],
        wallRemaining: 90,
        drawsTaken: 1,
        doraIndicators: [],
      })
    );
    const afterTwo = buildNormalWallPlan(
      input({
        rulesFamily: "mcr",
        flowerTiles: [["1f", "2f"], [], [], []],
        wallRemaining: 89,
        drawsTaken: 2,
        doraIndicators: [],
      })
    );
    const afterThree = buildNormalWallPlan(
      input({
        rulesFamily: "mcr",
        flowerTiles: [["1f", "2f", "3f"], [], [], []],
        wallRemaining: 88,
        drawsTaken: 3,
        doraIndicators: [],
      })
    );
    const hasTile = (
      plan: ReturnType<typeof buildNormalWallPlan>,
      stackIndex: number,
      row: 0 | 1
    ) =>
      plan.tiles.some(
        (tile) =>
          tile.seat === 2 && tile.stackIndex === stackIndex && tile.row === row
      );

    expect(afterOne.tiles.some((tile) => tile.sourceIndex === 0)).toBe(true);
    expect(hasTile(afterOne, 11, 1)).toBe(false);
    expect(hasTile(afterOne, 11, 0)).toBe(true);
    expect(hasTile(afterTwo, 11, 1)).toBe(false);
    expect(hasTile(afterTwo, 11, 0)).toBe(false);
    expect(hasTile(afterThree, 12, 1)).toBe(false);
    expect(hasTile(afterThree, 12, 0)).toBe(true);
  });

  it("shows the 70-tile live wall and 14-tile dead wall after dealing", () => {
    const plan = buildNormalWallPlan(input());

    expect(plan.tiles).toHaveLength(84);
    expect(plan.tiles.filter((tile) => tile.kind === "live")).toHaveLength(70);
    expect(plan.tiles.filter((tile) => tile.kind === "dead")).toHaveLength(14);
    expect(plan.tiles.filter((tile) => tile.castsShadow)).toHaveLength(42);
    expect(
      plan.tiles.find(
        (tile) => tile.kind === "dead" && tile.faceUpTile === "4p"
      )
    ).toMatchObject({ seat: 2, stackIndex: 12, row: 1, sourceIndex: 5 });
  });

  it("removes live tiles from the draw end without moving remaining slots", () => {
    const before = buildNormalWallPlan(input());
    const after = buildNormalWallPlan(
      input({ drawsTaken: 1, liveDrawsTaken: 1 })
    );
    const beforeBySource = new Map(
      before.tiles
        .filter((tile) => tile.kind === "live")
        .map((tile) => [tile.sourceIndex, tile])
    );

    expect(after.tiles.filter((tile) => tile.kind === "live")).toHaveLength(69);
    expect(
      after.tiles.some((tile) => tile.kind === "live" && tile.sourceIndex === 0)
    ).toBe(false);
    for (const tile of after.tiles.filter(
      (candidate) => candidate.kind === "live"
    )) {
      expect(tile).toMatchObject({
        x: beforeBySource.get(tile.sourceIndex)?.x,
        y: beforeBySource.get(tile.sourceIndex)?.y,
      });
    }
  });

  it("keeps physical wall size while transferring one live tile after a kan", () => {
    const plan = buildNormalWallPlan(
      input({ drawsTaken: 1, liveDrawsTaken: 0 })
    );

    expect(plan.tiles).toHaveLength(83);
    expect(plan.tiles.filter((tile) => tile.kind === "live")).toHaveLength(70);
    expect(plan.tiles.filter((tile) => tile.kind === "dead")).toHaveLength(13);
    expect(
      plan.tiles.filter(
        (tile) => tile.kind === "live" && tile.tone === "deemphasized"
      )
    ).toHaveLength(1);
  });

  it("maps replay wall faces and focused-seat highlights", () => {
    const liveWall = Array.from({ length: 70 }, (_, index) =>
      index === 0 ? "1m" : index === 1 ? "2m" : "9p"
    );
    const deadWall = Array.from({ length: 14 }, (_, index) =>
      index === 4 ? "1z" : index === 5 ? "4p" : "9s"
    );
    const plan = buildNormalWallPlan(
      input(
        {
          liveWall,
          deadWall,
          liveDrawSchedule: [0, 1, ...new Array(68).fill(2)],
        },
        { showWalls: true }
      )
    );
    const firstLive = plan.tiles.find(
      (tile) => tile.kind === "live" && tile.sourceIndex === 0
    );
    const secondLive = plan.tiles.find(
      (tile) => tile.kind === "live" && tile.sourceIndex === 1
    );
    const ura = plan.tiles.find(
      (tile) => tile.kind === "dead" && tile.sourceIndex === 4
    );

    expect(firstLive).toMatchObject({
      faceUpTile: "1m",
      tone: "future-draw",
    });
    expect(secondLive).toMatchObject({ faceUpTile: "2m", tone: "normal" });
    expect(ura).toMatchObject({ faceUpTile: "1z", tone: "deemphasized" });
  });

  it("can render the complete undealt 136-tile wall", () => {
    const plan = buildNormalWallPlan(input({}, { showUndealtWall: true }));

    expect(plan.tiles).toHaveLength(136);
  });
});
