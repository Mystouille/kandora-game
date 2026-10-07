import { describe, expect, it } from "vitest";
import { getPreset, presetToRuleSet } from "./presets";
import { RuleSetSchema, resolveRuleSet } from "./ruleSet";
import { calculateMatchPoints, UmaTableSchema } from "./matchScoring";

describe("match scoring rules", () => {
  it("applies M-League return points, UMA and oka exactly once", () => {
    const rules = presetToRuleSet(getPreset("m-league"));
    expect(calculateMatchPoints([27800, 27700, 26300, 18200], rules)).toEqual([
      47.8, 7.7, -13.7, -41.8,
    ]);
    expect(rules.returnScore).toBe(30000);
    expect(rules.uma[0]).toEqual([30, 10, -10, -30]);
  });

  it("uses the return score, not starting points, when counting sinking players", () => {
    const rules = resolveRuleSet({
      startingScore: 25000,
      returnScore: 30000,
      uma: [
        [45, 5, -15, -35],
        [46, 6, -16, -36],
        [47, 7, -17, -37],
        [48, 8, -18, -38],
        [49, 9, -19, -39],
      ],
      roundFinalScores: false,
    });
    expect(calculateMatchPoints([30000, 29000, 28000, 13000], rules)).toEqual([
      68, 7, -20, -55,
    ]);
  });

  it.each([
    { scores: [30000, 30000, 30000, 30000], below: 0, points: [0, 0, 0, 0] },
    { scores: [31000, 31000, 31000, 27000], below: 1, points: [5, 5, 5, -15] },
    {
      scores: [45000, 35000, 25000, 15000],
      below: 2,
      points: [23, 9, -9, -23],
    },
    {
      scores: [45000, 25000, 25000, 25000],
      below: 3,
      points: [27, -9, -9, -9],
    },
  ])(
    "uses JPML A floating UMA for $below sinking players",
    ({ scores, points }) => {
      const rules = presetToRuleSet(getPreset("jpml-hanchan"));
      expect(rules.startingScore).toBe(30000);
      expect(rules.returnScore).toBe(30000);
      expect(calculateMatchPoints(scores, rules)).toEqual(points);
    }
  );

  it("splits both placement bonuses and oka on tied scores", () => {
    const rules = presetToRuleSet(getPreset("m-league"));
    expect(calculateMatchPoints([40000, 40000, 10000, 10000], rules)).toEqual([
      40, 40, -40, -40,
    ]);
    rules.splitTiedUma = false;
    expect(calculateMatchPoints([40000, 40000, 10000, 10000], rules)).toEqual([
      60, 20, -30, -50,
    ]);
  });

  it("can round final points without changing raw table scores", () => {
    const rules = resolveRuleSet({
      returnScore: 25000,
      uma: Array.from({ length: 5 }, () => [0, 0, 0, 0]),
      roundFinalScores: true,
    });
    const scores = [25500, 24500, 25000, 25000];
    expect(calculateMatchPoints(scores, rules)).toEqual([1, -1, 0, 0]);
    expect(scores).toEqual([25500, 24500, 25000, 25000]);
  });

  it("validates every floating UMA row, not only the default row", () => {
    const uma = structuredClone(getPreset("ema").uma);
    uma[4][0] = 999;
    expect(UmaTableSchema.safeParse(uma).success).toBe(false);
    expect(UmaTableSchema.safeParse(uma.slice(0, 4)).success).toBe(false);
  });

  it("keeps legacy serialized rules valid with neutral settlement defaults", () => {
    const rules: Partial<ReturnType<typeof presetToRuleSet>> = presetToRuleSet(
      getPreset("ema")
    );
    delete rules.returnScore;
    delete rules.minimumScoreToWin;
    delete rules.uma;
    delete rules.roundFinalScores;
    delete rules.splitTiedUma;
    const parsed = RuleSetSchema.parse(rules);
    expect(parsed.returnScore).toBe(parsed.startingScore);
    expect(parsed.minimumScoreToWin).toBeNull();
    expect(parsed.uma).toEqual(Array.from({ length: 5 }, () => [0, 0, 0, 0]));
  });

  it("does not share mutable UMA rows with preset definitions", () => {
    const preset = getPreset("ema");
    const rules = presetToRuleSet(preset);
    rules.uma[0][0] = 999;
    expect(preset.uma[0][0]).toBe(15);
    const resolved = resolveRuleSet();
    resolved.uma[0][0] = 999;
    expect(resolveRuleSet().uma[0][0]).not.toBe(999);
  });
});
