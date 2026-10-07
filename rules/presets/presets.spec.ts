import { describe, expect, it } from "vitest";

import {
  DEFAULT_PRESET_ID,
  getPreset,
  listPresetIds,
  listPresets,
  listSelectablePresets,
  presetToRuleSet,
} from "./index";
import { shouldEndMatch } from "../matchEnd";
import { createInitialState, type HandResult } from "../state";

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

  it("loads the M-League rules", () => {
    const preset = getPreset("m-league");
    expect(preset.roundWindCount).toBe(2);
    expect(preset.startingScore).toBe(25000);
    expect(preset.atamahane).toBe(true);
    expect(preset.bustedScore).toBeNull();
    expect(preset.kiriageMangan).toBe(true);
    expect(Object.values(preset.aborts)).toEqual([false, false, false, false]);
  });

  it("offers the requested EMA rules", () => {
    const selectableIds = listSelectablePresets().map((preset) => preset.id);
    expect(selectableIds).toContain("ema");

    const preset = getPreset("ema");
    expect(preset).toMatchObject({
      displayName: "EMA — Hanchan",
      roundWindCount: 2,
      startingScore: 30000,
      kuikae: "full",
      unclaimedRiichiDeposits: "highest_score_player",
      nbRedFiveManzu: 0,
      nbRedFivePinzu: 0,
      nbRedFiveSouzu: 0,
      kuitan: true,
      kiriageMangan: true,
      doubleWindPairFu: 2,
      bustedScore: null,
      agariYame: false,
    });
  });

  it("starts EMA games at 30,000 and continues below zero", () => {
    const ruleSet = presetToRuleSet(getPreset("ema"));
    const state = createInitialState(1, { ruleSet });
    expect(state.scores).toEqual([30000, 30000, 30000, 30000]);

    state.scores = [42000, 41000, 37000, -1000];
    const result: HandResult = {
      reason: "ron",
      winner: 0,
      loser: 3,
      delta: [0, 0, 0, 0],
      tenpai: null,
      abortKind: null,
      winHan: 1,
      winYakuman: false,
    };

    expect(shouldEndMatch(state, result, false)).toEqual({ ended: false });
  });

  it("offers JPML hanchan without the legacy Tenhou options", () => {
    const selectableIds = listSelectablePresets().map((preset) => preset.id);
    expect(selectableIds).toContain("jpml-hanchan");
    expect(selectableIds).not.toContain("tenhou-hanchan");
    expect(selectableIds).not.toContain("tenhou-tonpuusen");

    const preset = getPreset("jpml-hanchan");
    expect(preset.roundWindCount).toBe(2);
    expect(preset.ippatsu).toBe(false);
    expect(preset.uraDora).toBe(false);
    expect(preset.kanDora).toBe(false);
    expect(preset.nagashiMangan).toBe(false);
    expect(preset.aborts).toMatchObject({
      kyuushuu: false,
      suufonRenda: false,
      suuchaRiichi: false,
    });
    expect([
      preset.nbRedFiveManzu,
      preset.nbRedFivePinzu,
      preset.nbRedFiveSouzu,
    ]).toEqual([0, 0, 0]);
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
      expect(p.kuikae).toBe("full");
      expect(p.unclaimedRiichiDeposits).toBe("highest_score_player");
      expect([2, 4]).toContain(p.doubleWindPairFu);
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
