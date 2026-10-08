import { describe, expect, it } from "vitest";
import { RuleSetSchema, resolveRuleSet } from "./ruleSet";
import { getPreset, presetToRuleSet } from "./presets";
import {
  activeSeats,
  nextSeat,
  seatDistance,
  seatValues,
  mapSeatValues,
} from "./seats";
import { GameSetupSchema, gameSetupRules } from "./gameSetup";
import { GameVariantSchema, seatValuesSchema } from "../protocol/seat";
import { z } from "zod";
import { calculateMatchPoints } from "./matchScoring";

describe("sanma configuration", () => {
  it("does not silently apply four-place tournament UMA to native sanma", () => {
    expect(() =>
      calculateMatchPoints(
        [25_000, 25_000, 25_000],
        resolveRuleSet({ playerCount: 3 })
      )
    ).toThrow(/raw match scores/);
  });
  it("keeps four-player and Online defaults for old data", () => {
    expect(GameVariantSchema.parse({})).toEqual({
      playerCount: 4,
      sanmaType: "online",
    });
    const legacy: Record<string, unknown> = {
      ...presetToRuleSet(getPreset("m-league")),
    };
    delete legacy.playerCount;
    delete legacy.sanmaType;
    expect(RuleSetSchema.parse(legacy)).toMatchObject({
      playerCount: 4,
      sanmaType: "online",
    });
  });

  it.each(["online", "kansai"] as const)(
    "resolves the fixed M-League %s profile",
    (sanmaType) => {
      const rules = resolveRuleSet({ playerCount: 3, sanmaType });
      expect(rules).toMatchObject({
        playerCount: 3,
        sanmaType,
        roundWindCount: 2,
        roundLimit: 3,
        startingScore: 25_000,
        atamahane: false,
        nagashiMangan: false,
        bustedScore: null,
        buuMode: false,
        kiriageMangan: true,
        nbRedFiveManzu: sanmaType === "online" ? 0 : 1,
        nbRedFivePinzu: 1,
        nbRedFiveSouzu: 1,
        aborts: {
          kyuushuu: false,
          suufonRenda: false,
          suuchaRiichi: false,
          sanchahou: false,
        },
      });
      expect(RuleSetSchema.parse(rules)).toEqual(rules);
    }
  );

  it("rejects Buu sanma rather than silently changing the requested mode", () => {
    expect(() => resolveRuleSet({ playerCount: 3, buuMode: true })).toThrow(
      /Buu/
    );
    expect(
      GameSetupSchema.safeParse({ preset: "buu-east", playerCount: 3 }).success
    ).toBe(false);
  });

  it("validates common creation options and preserves Duplicate as a separate axis", () => {
    const setup = GameSetupSchema.parse({
      preset: "m-league",
      playerCount: 3,
      sanmaType: "kansai",
      mode: { type: "duplicate", seed: "Board-A", generationVersion: 1 },
    });
    expect(setup.mode.type).toBe("duplicate");
    expect(gameSetupRules(setup)).toEqual(
      resolveRuleSet({ playerCount: 3, sanmaType: "kansai" })
    );
    expect(
      GameSetupSchema.safeParse({ preset: "ema", playerCount: 3 }).success
    ).toBe(false);
    expect(
      GameSetupSchema.safeParse({ preset: "m-league", playerCount: 2 }).success
    ).toBe(false);
    expect(
      GameSetupSchema.safeParse({ preset: "m-league", sanmaType: "unknown" })
        .success
    ).toBe(false);
    expect(gameSetupRules(GameSetupSchema.parse({ preset: "ema" }))).toEqual(
      presetToRuleSet(getPreset("ema"))
    );
  });
});

describe("logical active seats", () => {
  it("does not include a fourth participant or apply four-sided visual rotation", () => {
    expect(activeSeats(3)).toEqual([0, 1, 2]);
    expect(activeSeats(4)).toEqual([0, 1, 2, 3]);
    expect(nextSeat(2, 3)).toBe(0);
    expect(nextSeat(2, 4)).toBe(3);
    expect(seatDistance(2, 0, 3)).toBe(1);
    expect(() => nextSeat(3, 3)).toThrow(/seat/i);
  });

  it("constructs and maps collections without padding", () => {
    expect(seatValues(3, (seat) => `player-${seat}`)).toEqual([
      "player-0",
      "player-1",
      "player-2",
    ]);
    expect(mapSeatValues([3, 2, 1], (value) => value * 2)).toEqual([6, 4, 2]);
    expect(seatValuesSchema(z.number()).safeParse([1, 2]).success).toBe(false);
    expect(seatValuesSchema(z.number()).parse([1, 2, 3])).toEqual([1, 2, 3]);
    expect(seatValuesSchema(z.number()).parse([1, 2, 3, 4])).toEqual([
      1, 2, 3, 4,
    ]);
    expect(() => mapSeatValues([1, 2], (value) => value)).toThrow(/players/i);
  });
});
