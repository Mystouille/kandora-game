import { describe, expect, it } from "vitest";
import {
  CONCEALED_KONG_SERIES_FIXTURES,
  CORRECTION_FIXTURES,
  FOUR_KONG_FIXTURES,
  KNITTED_FIXTURES,
  STANDARD_FIXTURES,
  mcrFixture,
  type ScoringFixture,
} from "./fixtures";
import { scoreMcr } from "./scorer";

function verifyFixture(fixture: ScoringFixture): void {
  const result = scoreMcr(fixture.input);
  expect(result.isWinningShape, fixture.name).toBe(true);
  if (fixture.totalFan !== undefined) {
    expect(result.totalFan, fixture.name).toBe(fixture.totalFan);
    expect(result.nonFlowerFan, fixture.name).toBe(
      fixture.nonFlowerFan ?? fixture.totalFan
    );
  }
  for (const [id, count] of Object.entries(fixture.fans ?? {})) {
    expect(result.fans.find((fan) => fan.id === id)?.count, fixture.name).toBe(
      count
    );
  }
  for (const id of fixture.absent ?? []) {
    expect(result.fans.some((fan) => fan.id === id), fixture.name).toBe(false);
  }
  expect(
    result.fans.reduce((sum, fan) => sum + fan.awardedPoints, 0),
    fixture.name
  ).toBe(result.totalFan);
}

describe("pinned scorer corrections", () => {
  it.each(CORRECTION_FIXTURES)("$name", verifyFixture);
  it.each(CONCEALED_KONG_SERIES_FIXTURES)("$name", verifyFixture);
  it.each(FOUR_KONG_FIXTURES)("$name", (fixture) => {
    verifyFixture(fixture);
    const result = scoreMcr(fixture.input);
    expect(result.fans.some((fan) => fan.id === "SINGLE_WAIT")).toBe(false);
  });

  describe("independent Green Book combinations", () => {
    it.each(STANDARD_FIXTURES)("$name", verifyFixture);
  });
});

describe("knitted forms", () => {
  it.each(KNITTED_FIXTURES)("$name", verifyFixture);
});

describe("minimum, flowers, and Chicken Hand", () => {
  it("does not let flowers satisfy the eight-point minimum", () => {
    const result = scoreMcr(
      mcrFixture("445566m2277779s8s", { flowerCount: 8 })
    );
    expect(result).toMatchObject({
      isWinningShape: true,
      totalFan: 15,
      nonFlowerFan: 7,
      meetsMinimum: false,
    });
    expect(result.fans.find((fan) => fan.id === "FLOWER_TILES")).toMatchObject({
      count: 8,
      awardedPoints: 8,
    });
  });

  it("awards Chicken Hand only when no other non-flower fan exists", () => {
    const chicken = scoreMcr(mcrFixture("[123m]345m567sNN78p9p"));
    expect(chicken).toMatchObject({
      isWinningShape: true,
      totalFan: 8,
      nonFlowerFan: 8,
      meetsMinimum: true,
    });
    expect(chicken.fans.map((fan) => fan.id)).toEqual(["CHICKEN_HAND"]);

    const flowers = scoreMcr(
      mcrFixture("[123m]345m567sNN78p9p", { flowerCount: 3 })
    );
    expect(flowers.fans.map((fan) => fan.id)).toEqual([
      "CHICKEN_HAND",
      "FLOWER_TILES",
    ]);
    expect(flowers.nonFlowerFan).toBe(8);
  });

  it("returns a stable non-winning result", () => {
    const result = scoreMcr(mcrFixture("123m456s789pEE23m5m"));
    expect(result).toEqual({
      isWinningShape: false,
      fans: [],
      totalFan: 0,
      nonFlowerFan: 0,
      meetsMinimum: false,
    });
  });
});

describe("win context", () => {
  it.each([
    {
      context: { method: "self-draw" as const, lastTileDraw: true },
      fan: "LAST_TILE_DRAW",
    },
    {
      context: { method: "discard" as const, lastTileClaim: true },
      fan: "LAST_TILE_CLAIM",
    },
    {
      context: { method: "self-draw" as const, replacementTile: true },
      fan: "OUT_WITH_REPLACEMENT_TILE",
    },
    {
      context: { method: "discard" as const, robbingPromotedKong: true },
      fan: "ROBBING_THE_KONG",
    },
    {
      context: { method: "discard" as const, lastCopy: true },
      fan: "LAST_TILE",
    },
  ])("maps $fan", ({ context, fan }) => {
    const notation =
      fan === "OUT_WITH_REPLACEMENT_TILE"
        ? "[1111m]345p789pEE67s8s"
        : "123m345s456pNN34p2p";
    const result = scoreMcr(mcrFixture(notation, context));
    expect(result.fans.some((awarded) => awarded.id === fan)).toBe(true);
  });
});
