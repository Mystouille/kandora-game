import { describe, expect, it } from "vitest";
import type { DuplicateMatchModeConfig } from "~/game/protocol/matchMode";
import { resolveRuleSet } from "~/game/rules/ruleSet";
import {
  createMatchDriver,
  type DuplicateMatchDriverSnapshot,
  type MatchHandContext,
} from "./matchDriver";

const mode: DuplicateMatchModeConfig = {
  type: "duplicate",
  seed: "Driver-A",
  generationVersion: 1,
};
const context: MatchHandContext = {
  gameIndex: 0,
  roundWind: "E",
  roundNumber: 1,
  honba: 0,
  dealer: 0,
};
const ruleSet = resolveRuleSet({
  nbRedFiveManzu: 1,
  nbRedFivePinzu: 1,
  nbRedFiveSouzu: 1,
});

describe("match drivers", () => {
  it("keeps standard mode free of supplied directives", () => {
    const driver = createMatchDriver({ type: "normal" }, "m-league");

    expect(driver.prepareHand(context, ruleSet)).toBeUndefined();
    expect(driver.peekDraw(0)).toEqual({ kind: "standard" });
    expect(driver.canSupplyReplacement(0)).toBe(true);
    expect(driver.snapshot()).toEqual({ type: "normal" });
  });

  it("advances only the committed duplicate seat queue", () => {
    const driver = createMatchDriver(mode, "m-league");
    driver.prepareHand(context, ruleSet);
    const seatZero = driver.peekDraw(0);
    const seatOne = driver.peekDraw(1);
    if (seatZero.kind !== "tile" || seatOne.kind !== "tile") {
      throw new Error("setup: expected duplicate draw tiles");
    }

    driver.commitDraw(0, seatZero.tile);

    expect(driver.peekDraw(0)).not.toEqual(seatZero);
    expect(driver.peekDraw(1)).toEqual(seatOne);
    expect(driver.snapshot()).toMatchObject({
      type: "duplicate",
      activeHand: { cursors: [1, 0, 0, 0] },
    });
  });

  it("reports exhaustion after a seat consumes its fixed queue", () => {
    const driver = createMatchDriver(mode, "m-league");
    driver.prepareHand(context, ruleSet);

    for (;;) {
      const next = driver.peekDraw(0);
      if (next.kind === "exhaustive") {
        break;
      }
      if (next.kind !== "tile") {
        throw new Error("setup: expected duplicate draw tile");
      }
      driver.commitDraw(0, next.tile);
    }

    expect(driver.peekDraw(0)).toEqual({ kind: "exhaustive" });
    expect(driver.canSupplyReplacement(0)).toBe(false);
  });

  it("keeps per-seat sequences stable across divergent table turn orders", () => {
    const firstTable = createMatchDriver(mode, "m-league");
    const secondTable = createMatchDriver(mode, "m-league");
    firstTable.prepareHand(context, ruleSet);
    secondTable.prepareHand(context, ruleSet);

    for (const seat of [0, 1, 2, 1] as const) {
      const next = firstTable.peekDraw(seat);
      if (next.kind !== "tile") {
        throw new Error("setup: expected duplicate draw tile");
      }
      firstTable.commitDraw(seat, next.tile);
    }
    for (const seat of [1, 0, 1, 3, 3] as const) {
      const next = secondTable.peekDraw(seat);
      if (next.kind !== "tile") {
        throw new Error("setup: expected duplicate draw tile");
      }
      secondTable.commitDraw(seat, next.tile);
    }

    expect(firstTable.peekDraw(0)).toEqual(secondTable.peekDraw(0));
    expect(firstTable.peekDraw(1)).toEqual(secondTable.peekDraw(1));
    expect(firstTable.peekDraw(2)).not.toEqual(secondTable.peekDraw(2));
    expect(firstTable.peekDraw(3)).not.toEqual(secondTable.peekDraw(3));
  });

  it("restores the exact next tile from a duplicate snapshot", () => {
    const original = createMatchDriver(mode, "m-league");
    original.prepareHand(context, ruleSet);
    const first = original.peekDraw(2);
    if (first.kind !== "tile") {
      throw new Error("setup: expected duplicate draw tile");
    }
    original.commitDraw(2, first.tile);
    const snapshot = original.snapshot() as DuplicateMatchDriverSnapshot;
    const expected = original.peekDraw(2);

    const restored = createMatchDriver(mode, "m-league", {
      snapshot,
      ruleSet,
    });

    expect(restored.peekDraw(2)).toEqual(expected);
    expect(restored.drawQueuesForArchive()).toEqual(
      original.drawQueuesForArchive()
    );
  });

  it("rejects a snapshot cursor beyond its generated queue", () => {
    expect(() =>
      createMatchDriver(mode, "m-league", {
        snapshot: {
          type: "duplicate",
          activeHand: { key: context, cursors: [99, 0, 0, 0] },
        },
        ruleSet,
      })
    ).toThrow(/cursor/i);
  });
});