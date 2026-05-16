import { describe, expect, it } from "vitest";

import {
  DEFAULT_PRESET_ID,
  getPreset,
  listPresetIds,
  listPresets,
  presetToRuleSet,
} from "./index";

describe("rule-set presets", () => {
  it("loads at least the Tenhou-default preset", () => {
    const ids = listPresetIds();
    expect(ids).toContain(DEFAULT_PRESET_ID);
    expect(ids).toContain("tenhou-tonpuusen");
  });

  it("getPreset returns the requested preset by id", () => {
    const p = getPreset(DEFAULT_PRESET_ID);
    expect(p.id).toBe(DEFAULT_PRESET_ID);
    expect(p.roundWindCount).toBe(2);
    expect(p.startingScore).toBe(25000);
  });

  it("getPreset throws on unknown id", () => {
    expect(() => getPreset("does-not-exist")).toThrow(
      /Unknown rule-set preset/
    );
  });

  it("presetToRuleSet strips metadata and yields a plain RuleSet", () => {
    const rs = presetToRuleSet(getPreset(DEFAULT_PRESET_ID));
    expect(rs).not.toHaveProperty("id");
    expect(rs).not.toHaveProperty("displayName");
    expect(rs).not.toHaveProperty("description");
    expect(rs.kuitan).toBe(true);
    expect(rs.aborts.kyuushuu).toBe(true);
  });

  it("every loaded preset passes the structural validator", () => {
    const presets = listPresets();
    expect(presets.length).toBeGreaterThan(0);
    for (const p of presets) {
      expect(typeof p.id).toBe("string");
      expect(typeof p.displayName).toBe("string");
      expect([1, 2, 4]).toContain(p.roundWindCount);
      expect(Number.isInteger(p.roundLimit)).toBe(true);
      expect(Number.isInteger(p.startingScore)).toBe(true);
      for (const key of [
        "nbRedFiveManzu",
        "nbRedFivePinzu",
        "nbRedFiveSouzu",
      ] as const) {
        expect(Number.isInteger(p[key])).toBe(true);
        expect(p[key]).toBeGreaterThanOrEqual(0);
        expect(p[key]).toBeLessThanOrEqual(4);
      }
      for (const key of [
        "kuitan",
        "doubleRiichi",
        "renhou",
        "ippatsu",
        "uraDora",
        "kanDora",
        "nagashiMangan",
      ] as const) {
        expect(typeof p[key]).toBe("boolean");
      }
      for (const key of [
        "kyuushuu",
        "suufonRenda",
        "suuchaRiichi",
        "sanchahou",
      ] as const) {
        expect(typeof p.aborts[key]).toBe("boolean");
      }
    }
  });
});
