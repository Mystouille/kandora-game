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
      after.tiles.some(
        (tile) => tile.kind === "live" && tile.sourceIndex === 0
      )
    ).toBe(false);
    for (const tile of after.tiles.filter((candidate) => candidate.kind === "live")) {
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
    const plan = buildNormalWallPlan(
      input({}, { showUndealtWall: true })
    );

    expect(plan.tiles).toHaveLength(136);
  });
});