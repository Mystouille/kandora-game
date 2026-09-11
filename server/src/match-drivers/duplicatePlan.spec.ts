import { describe, expect, it } from "vitest";
import { buildAllTiles } from "~/game/rules/wall";
import type { DuplicateMatchModeConfig } from "~/game/protocol/matchMode";
import {
  duplicateMatchSeed,
  generateDuplicateHandPlan,
  type DuplicateHandKey,
} from "./duplicatePlan";

const mode: DuplicateMatchModeConfig = {
  type: "duplicate",
  seed: "Board-A",
  generationVersion: 1,
};

const key: DuplicateHandKey = {
  gameIndex: 0,
  roundWind: "E",
  roundNumber: 1,
  honba: 0,
  dealer: 0,
};

describe("generateDuplicateHandPlan", () => {
  it("reproduces a plan and full-match seed from the public seed", () => {
    expect(duplicateMatchSeed(mode)).toBe(duplicateMatchSeed(mode));
    expect(
      generateDuplicateHandPlan(mode, "m-league", key, {
        redFives: { m: 1, p: 1, s: 1 },
      })
    ).toEqual(
      generateDuplicateHandPlan(mode, "m-league", key, {
        redFives: { m: 1, p: 1, s: 1 },
      })
    );
  });

  it("partitions one legal wall into dealer-relative fixed queues", () => {
    const plan = generateDuplicateHandPlan(mode, "m-league", key, {
      redFives: { m: 1, p: 1, s: 1 },
    });

    expect(plan.deal.hands.map((hand) => hand.length)).toEqual([
      13, 13, 13, 13,
    ]);
    expect(plan.deal.deadWall).toHaveLength(14);
    expect(plan.drawQueues.map((queue) => queue.length)).toEqual([
      18, 18, 17, 17,
    ]);

    const plannedTiles = [
      ...plan.deal.hands.flat(),
      ...plan.deal.deadWall,
      ...plan.drawQueues.flat(),
    ].sort();
    expect(plannedTiles).toEqual(
      buildAllTiles({ redFives: { m: 1, p: 1, s: 1 } }).sort()
    );
  });

  it("starts round-robin allocation at the current dealer", () => {
    const dealerTwo = generateDuplicateHandPlan(
      mode,
      "m-league",
      { ...key, roundNumber: 3, dealer: 2 },
      {}
    );

    expect(dealerTwo.drawQueues.map((queue) => queue.length)).toEqual([
      17, 17, 18, 18,
    ]);
    expect(dealerTwo.drawQueues[2][0]).toBe(dealerTwo.deal.liveWall[0]);
    expect(dealerTwo.drawQueues[3][0]).toBe(dealerTwo.deal.liveWall[1]);
  });

  it("changes plans when the seed or round key changes", () => {
    const first = generateDuplicateHandPlan(mode, "m-league", key, {});
    const otherSeed = generateDuplicateHandPlan(
      { ...mode, seed: "Board-B" },
      "m-league",
      key,
      {}
    );
    const otherRound = generateDuplicateHandPlan(
      mode,
      "m-league",
      { ...key, roundNumber: 2, dealer: 1 },
      {}
    );

    expect(otherSeed.deal).not.toEqual(first.deal);
    expect(otherRound.deal).not.toEqual(first.deal);
  });
});