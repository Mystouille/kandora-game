import { describe, expect, it } from "vitest";
import { tableLayoutFromConfig } from "../tableLayout";
import { currentTableLayout } from "../layouts/currentTableLayout";
import { tenhouTileDesign } from "../tiles/designs/tenhouTileDesign";
import {
  buildNormalWallPlan,
  type NormalWallPlanInput,
} from "./normalWallPlan";
import { buildDuplicateWallPlan } from "./duplicateWallPlan";
import {
  createTableProjection,
  tablePositionForSeat,
  rotateMatchView,
} from "../../tableProjection";
import { useMatchStore } from "../../store";
import { initialView } from "~/game/replay/player";
import { seatValues } from "~/game/rules/seats";
import type { SanmaType } from "~/game/protocol/seat";

const layout = tableLayoutFromConfig(currentTableLayout);
const metrics = {
  upright: tenhouTileDesign.metrics.wallUpright,
  side: tenhouTileDesign.metrics.wallSide,
  sideOverlap: tenhouTileDesign.spacing.wallSide,
};
function input(
  sanmaType: SanmaType,
  replacementsTaken = 0,
  kanCount = 0
): NormalWallPlanInput {
  return {
    layout,
    metrics,
    showWalls: true,
    showUndealtWall: false,
    view: {
      ...initialView({ playerCount: 3, sanmaType }),
      mySeat: 0,
      sanmaWall: { sanmaType, mode: "standard", replacementsTaken, kanCount },
      liveWall: Array.from(
        { length: sanmaType === "online" ? 55 : 63 },
        (_, index) => `L${index}`
      ),
      deadWall: Array.from(
        { length: sanmaType === "online" ? 14 : 10 },
        (_, index) => `D${index}`
      ),
      doraIndicators: ["D8"],
    },
  };
}

describe("standard sanma physical walls", () => {
  for (const variant of ["online", "kansai"] as const) {
    for (const focus of [0, 1, 2] as const) {
      for (const dealer of [0, 1, 2] as const) {
        it(`${variant} inventory and quarter-turns at focus ${focus}, dealer ${dealer}`, () => {
          const args = input(variant);
          args.view.dealer = tablePositionForSeat(dealer, focus);
          args.view.tableProjection = createTableProjection(3, focus, dealer);
          const undealt = buildNormalWallPlan({
            ...args,
            showUndealtWall: true,
          });
          expect(undealt.tiles).toHaveLength(variant === "online" ? 108 : 112);
          expect(
            new Set(
              undealt.tiles.map((tile) => `${tile.seat}:${tile.stackIndex}`)
            ).size
          ).toBe(variant === "online" ? 54 : 56);
          expect(new Set(undealt.tiles.map((tile) => tile.seat)).size).toBe(4);
          const plan = buildNormalWallPlan(args);
          expect(
            plan.tiles.filter((tile) => tile.kind === "live")
          ).toHaveLength(variant === "online" ? 55 : 63);
          expect(
            plan.tiles.filter((tile) => tile.kind === "dead")
          ).toHaveLength(variant === "online" ? 14 : 10);
          expect(
            plan.tiles.filter((tile) => tile.faceUpTile === "D8")
          ).toHaveLength(1);
          expect(
            new Set(
              plan.tiles.map(
                (tile) => `${tile.seat}:${tile.stackIndex}:${tile.row}`
              )
            ).size
          ).toBe(plan.tiles.length);
          expect(
            plan.tiles.every(
              (tile) => Number.isFinite(tile.x) && Number.isFinite(tile.y)
            )
          ).toBe(true);
        });
      }
    }
  }

  it.each(["online", "kansai"] as const)(
    "accounts for all kan/nuki mixtures without deriving kans from draws (%s)",
    (variant) => {
      for (let kan = 0; kan <= 4; kan++) {
        for (let nuki = 0; nuki <= 4; nuki++) {
          const replacements = kan + nuki;
          const args = input(variant, replacements, kan);
          args.view.liveDrawsTaken = 3;
          args.view.drawsTaken = 3 + replacements;
          const plan = buildNormalWallPlan(args);
          const live =
            variant === "online" ? 55 - 3 - replacements : 63 - 3 - kan * 2;
          const dead = variant === "online" ? 14 : 10 - nuki + kan;
          expect(
            plan.tiles.filter((tile) => tile.kind === "live")
          ).toHaveLength(live);
          expect(
            plan.tiles.filter((tile) => tile.kind === "dead")
          ).toHaveLength(dead);
          expect(plan.tiles).toHaveLength(live + dead);
          expect(
            plan.tiles.find((tile) => tile.faceUpTile === "D8")
          ).toBeDefined();
        }
      }
    }
  );

  it("reveals future Kansai indicator pairs at their original live-tail positions only after reservation", () => {
    const before = buildNormalWallPlan(input("kansai"));
    const args = input("kansai", 3, 1);
    args.view.doraIndicators = ["D8", "L62"];
    const after = buildNormalWallPlan(args);
    const oldTile = before.tiles.find((tile) => tile.faceUpTile === "L62");
    expect(oldTile?.kind).toBe("live");
    expect(after.tiles.find((tile) => tile.faceUpTile === "L62")).toMatchObject(
      {
        kind: "dead",
        x: oldTile?.x,
        y: oldTile?.y,
      }
    );
    expect(
      after.tiles.filter(
        (tile) =>
          tile.faceUpTile?.startsWith("D") &&
          Number(tile.faceUpTile.slice(1)) < 3
      )
    ).toEqual([]);
  });
});

describe("sanma Duplicate queues", () => {
  it.each(["online", "kansai"] as const)(
    "keeps exactly three personal queues and the fixed 14 reserve (%s)",
    (variant) => {
      const initial: readonly number[] =
        variant === "online" ? [19, 18, 18] : [20, 20, 19];
      for (const focus of [0, 1, 2] as const) {
        for (const dealer of [0, 1, 2] as const) {
          const raw = {
            ...useMatchStore.getInitialState(),
            ...initialView({ playerCount: 3, sanmaType: variant }),
            mySeat: focus,
            dealer,
            duplicateDrawQueues: seatValues(3, (seat) =>
              Array.from(
                { length: initial[seat] },
                (_, index) => `${seat}:${index}`
              )
            ),
            duplicateWallState: {
              initial: seatValues(3, (seat) => initial[seat]),
              remaining: seatValues(
                3,
                (seat) => initial[seat] - (seat === 2 ? 2 : 0)
              ),
              limitingSeat: 2 as const,
              estimatedDrawsRemaining: 48,
            },
          };
          const view = rotateMatchView(raw, focus);
          const plan = buildDuplicateWallPlan({
            layout,
            metrics,
            view,
            showWalls: true,
          });
          expect(
            plan.tiles.filter((tile) => tile.kind === "dead")
          ).toHaveLength(14);
          expect(
            plan.tiles.filter((tile) => tile.kind === "live")
          ).toHaveLength(initial.reduce((sum, count) => sum + count, 0) - 2);
          const gap = tablePositionForSeat(3, focus);
          expect(plan.tiles.some((tile) => tile.seat === gap)).toBe(false);
          expect(
            plan.tiles.some(
              (tile) => tile.faceUpTile === "2:0" || tile.faceUpTile === "2:1"
            )
          ).toBe(false);
          expect(plan.tiles.some((tile) => tile.faceUpTile === "0:0")).toBe(
            true
          );
          expect(plan.tiles.some((tile) => tile.faceUpTile === "1:0")).toBe(
            true
          );
        }
      }
    }
  );
});
