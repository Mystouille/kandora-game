import { describe, expect, it } from "vitest";
import { generateDuplicateHandPlan } from "./duplicatePlan";
import { createMatchDriver } from "./matchDriver";
import { resolveRuleSet } from "~/game/rules/ruleSet";
import { estimateDuplicateExhaustionFromNextDrawer } from "~/game/duplicate/duplicateExhaustion";

const mode = {
  type: "duplicate" as const,
  seed: "Sanma board",
  generationVersion: 1 as const,
};
const key = {
  gameIndex: 0,
  roundWind: "E" as const,
  roundNumber: 1,
  honba: 0,
  dealer: 0 as const,
};

describe("sanma Duplicate generation", () => {
  it.each(["online", "kansai"] as const)(
    "uses three queues and a fixed reserve for %s",
    (sanmaType) => {
      const options = {
        playerCount: 3 as const,
        sanmaType,
        redFives: { m: 1, p: 1, s: 1 },
      };
      const plan = generateDuplicateHandPlan(mode, "m-league", key, options);
      expect(plan.deal.hands.map((hand) => hand.length)).toEqual([13, 13, 13]);
      expect(plan.deal.deadWall).toHaveLength(14);
      expect(plan.deal.sanmaWall).toEqual({
        sanmaType,
        mode: "duplicate",
        kanCount: 0,
        replacementsTaken: 0,
      });
      expect(plan.drawQueues.map((queue) => queue.length)).toEqual(
        sanmaType === "online" ? [19, 18, 18] : [20, 20, 19]
      );
      expect(generateDuplicateHandPlan(mode, "m-league", key, options)).toEqual(
        plan
      );
    }
  );

  it("allocates relative to the three-seat dealer rotation", () => {
    const plan = generateDuplicateHandPlan(
      mode,
      "m-league",
      { ...key, dealer: 2 },
      { playerCount: 3 }
    );
    expect(plan.drawQueues.map((queue) => queue.length)).toEqual([18, 18, 19]);
    expect(plan.drawQueues[2][0]).toBe(plan.deal.liveWall[0]);
    expect(plan.drawQueues[0][0]).toBe(plan.deal.liveWall[1]);
  });

  it("restores personal cursors without altering another queue", () => {
    const rules = resolveRuleSet({ playerCount: 3, sanmaType: "kansai" });
    const driver = createMatchDriver(mode, "m-league");
    const deal = driver.prepareHand(key, rules);
    expect(deal?.sanmaWall?.mode).toBe("duplicate");
    const draw = driver.peekDraw(1);
    if (draw.kind !== "tile") {
      throw new Error("Expected a personal draw");
    }
    driver.commitDraw(1, draw.tile);
    expect(driver.duplicateQueueCounts()?.remaining).toEqual([20, 19, 19]);
    const restored = createMatchDriver(mode, "m-league", {
      snapshot: driver.snapshot(),
      ruleSet: rules,
    });
    expect(restored.duplicateQueueCounts()).toEqual(
      driver.duplicateQueueCounts()
    );
    expect(restored.peekDraw(1)).toEqual(driver.peekDraw(1));
  });

  it("forecasts exhaustion using three-player rotation", () => {
    expect(estimateDuplicateExhaustionFromNextDrawer([19, 18, 18], 0)).toEqual({
      limitingSeat: 1,
      estimatedDrawsRemaining: 55,
    });
    expect(estimateDuplicateExhaustionFromNextDrawer([0, 1, 1], 2)).toEqual({
      limitingSeat: 0,
      estimatedDrawsRemaining: 1,
    });
  });
});
