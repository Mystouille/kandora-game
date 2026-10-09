import { describe, expect, it } from "vitest";
import { debugDiscardSeat, debugSeedValidationError } from "./debugSeed";
import { getPreset, listPresets, presetToRuleSet } from "./presets";
import { resolveRuleSet } from "./ruleSet";

const hand = [
  "1p",
  "2p",
  "3p",
  "4p",
  "5p",
  "6p",
  "7p",
  "8p",
  "9p",
  "1s",
  "2s",
  "3s",
  "4s",
];
const profiles = [
  ...listPresets().map((preset) => ({
    name: preset.id,
    rules: presetToRuleSet(preset),
  })),
  ...(["online", "kansai"] as const).map((sanmaType) => ({
    name: `sanma-${sanmaType}`,
    rules: resolveRuleSet({ playerCount: 3, sanmaType }),
  })),
];

describe("variant-aware debug seed validation", () => {
  it.each(profiles)("accepts all three debug fields for $name", ({ rules }) => {
    expect(
      debugSeedValidationError(
        {
          humanHand: hand,
          humanDraws: ["7z"],
          leftDiscards: ["1m", "9m", "4z"],
        },
        rules
      )
    ).toBeNull();
    expect(debugDiscardSeat(rules.playerCount)).toBe(
      rules.playerCount === 3 ? 2 : 3
    );
  });

  it("allows MCR flowers in starting hands and queued draws", () => {
    expect(
      debugSeedValidationError(
        {
          humanHand: ["1f", ...hand.slice(1)],
          humanDraws: ["8f", "7z"],
        },
        presetToRuleSet(getPreset("mcr-ema"))
      )
    ).toBeNull();
  });

  it.each(profiles.filter(({ rules }) => rules.rulesFamily === "riichi"))(
    "rejects flowers in $name",
    ({ rules }) => {
      expect(debugSeedValidationError({ humanDraws: ["1f"] }, rules)).toContain(
        "not available"
      );
    }
  );

  it.each(["mcr-ema", "ema", "jpml-hanchan"])(
    "rejects unavailable red fives for %s",
    (preset) => {
      expect(
        debugSeedValidationError(
          { humanDraws: ["0m", "0p", "0s"] },
          presetToRuleSet(getPreset(preset))
        )
      ).toContain("not available");
    }
  );

  it("retains red-five overrides in a red-five preset", () => {
    expect(
      debugSeedValidationError(
        { humanDraws: ["0m", "0p", "0s"] },
        presetToRuleSet(getPreset("m-league"))
      )
    ).toBeNull();
  });

  it.each(["online", "kansai"] as const)(
    "validates the reduced tile set in every %s field",
    (sanmaType) => {
      const rules = resolveRuleSet({ playerCount: 3, sanmaType });
      for (const debug of [
        { humanHand: ["2m", ...hand.slice(1)] },
        { humanDraws: ["2m"] },
        { leftDiscards: ["2m"] },
      ]) {
        expect(debugSeedValidationError(debug, rules)).toContain("2m");
      }
    }
  );

  it("allows Kansai nuki in hands and draws, but not forced discards", () => {
    const rules = resolveRuleSet({ playerCount: 3, sanmaType: "kansai" });
    expect(
      debugSeedValidationError(
        { humanHand: ["0m", ...hand.slice(1)], humanDraws: ["5m"] },
        rules
      )
    ).toBeNull();
    expect(debugSeedValidationError({ leftDiscards: ["0m"] }, rules)).toContain(
      "cannot contain"
    );
  });

  it("allows MCR flower discards", () => {
    expect(
      debugSeedValidationError(
        { leftDiscards: ["1f"] },
        presetToRuleSet(getPreset("mcr-ema"))
      )
    ).toBeNull();
  });

  it.each([0, 12, 14])("rejects a %i-tile starting hand", (length) => {
    expect(
      debugSeedValidationError(
        { humanHand: Array<string>(length).fill("1p") },
        resolveRuleSet()
      )
    ).toBe(`Starting hand should have 13 tiles, got ${length}.`);
  });

  it("preserves intentionally unrestricted physical copy counts", () => {
    expect(
      debugSeedValidationError(
        { humanHand: Array<string>(13).fill("1p") },
        resolveRuleSet()
      )
    ).toBeNull();
    expect(debugSeedValidationError(undefined, resolveRuleSet())).toBeNull();
  });
});
