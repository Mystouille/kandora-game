import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import baseline from "~/game/testing/fixtures/yonma-v7.json";
import { dealMatch, type DealtMatch } from "~/game/rules/wall";
import { scoreHand } from "~/game/rules/score";
import { generateDuplicateHandPlan } from "./match-drivers/duplicatePlan";
import { MatchProcess } from "./match";
import { parseMatchCheckpoint } from "./checkpoint";
import { ephemeralMatchRepository } from "./repository";
import type { MatchRuntime } from "./runtime";

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function originalDealFields(deal: DealtMatch) {
  return {
    hands: deal.hands,
    liveWall: deal.liveWall,
    deadWall: deal.deadWall,
    doraIndicators: deal.doraIndicators,
  };
}

const wallOptions = { redFives: { m: 1, p: 1, s: 1 } };

describe("frozen pre-sanma four-player compatibility", () => {
  it.each(baseline.deals)(
    "retains the full deal for seed $seed",
    ({ seed, digest: expected }) => {
      expect(digest(originalDealFields(dealMatch(seed, wallOptions)))).toBe(
        expected
      );
    }
  );

  it.each([0, 1, 2, 3] as const)(
    "retains Duplicate generation v1 for dealer %i",
    (dealer) => {
      const plan = generateDuplicateHandPlan(
        {
          type: "duplicate",
          seed: "Sanma compatibility baseline",
          generationVersion: 1,
        },
        "m-league",
        {
          gameIndex: 0,
          roundWind: "E",
          roundNumber: dealer + 1,
          honba: 0,
          dealer,
        },
        wallOptions
      );
      expect(
        digest({
          key: plan.key,
          deal: originalDealFields(plan.deal),
          drawQueues: plan.drawQueues,
        })
      ).toBe(baseline.duplicate[dealer].digest);
    }
  );

  it.each([false, true])(
    "retains dealer and non-dealer valuation, tsumo=%s",
    (tsumo) => {
      for (const seatWind of ["E", "S"] as const) {
        const expected = baseline.scores.find(
          (entry) => entry.tsumo === tsumo && entry.seatWind === seatWind
        );
        expect(
          scoreHand({
            hand: baseline.hand,
            winTile: "7z",
            tsumo,
            riichi: true,
            seatWind,
          })
        ).toMatchObject(expected?.score ?? {});
        expect(expected).toBeDefined();
      }
    }
  );

  it("restores a real pre-sanma version-7 four-player checkpoint", () => {
    const runtime: MatchRuntime = {
      clockEpoch: "yonma-restored",
      now: () => 50_000,
      random: () => 0.5,
      captureRandomState: () => 0,
      restoreRandomState: () => undefined,
      schedule: () => ({ cancel: () => undefined }),
      sleep: async () => undefined,
    };
    const saved = parseMatchCheckpoint(baseline.checkpoint);
    const restored = MatchProcess.restoreCheckpoint(saved, {
      repository: ephemeralMatchRepository,
      runtime,
    });
    const snapshot = restored.buildSnapshotForSeat(0);
    expect(snapshot.state.hands.map((hand) => hand.length)).toEqual([
      14, 13, 13, 13,
    ]);
    expect(snapshot.state.scores).toEqual([25_000, 25_000, 25_000, 25_000]);
    expect(snapshot.state.hands[0]).toEqual(baseline.checkpoint.state.hands[0]);
    expect(snapshot.state.doraIndicators).toEqual(
      baseline.checkpoint.state.doraIndicators
    );
  });
});
