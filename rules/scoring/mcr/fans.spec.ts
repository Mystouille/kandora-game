import { describe, expect, it } from "vitest";
import { MCR_FANS, MCR_FAN_IDS } from "./fans";

const VALUES: Readonly<Record<number, readonly string[]>> = {
  88: [
    "BIG_FOUR_WINDS",
    "BIG_THREE_DRAGONS",
    "ALL_GREEN",
    "NINE_GATES",
    "FOUR_KONGS",
    "SEVEN_SHIFTED_PAIRS",
    "THIRTEEN_ORPHANS",
  ],
  64: [
    "ALL_TERMINALS",
    "LITTLE_FOUR_WINDS",
    "LITTLE_THREE_DRAGONS",
    "ALL_HONORS",
    "FOUR_CONCEALED_PUNGS",
    "PURE_TERMINAL_CHOWS",
  ],
  48: ["QUADRUPLE_CHOW", "FOUR_PURE_SHIFTED_PUNGS"],
  32: [
    "FOUR_PURE_SHIFTED_CHOWS",
    "THREE_KONGS",
    "ALL_TERMINALS_AND_HONORS",
  ],
  24: [
    "SEVEN_PAIRS",
    "GREATER_HONORS_AND_KNITTED_TILES",
    "ALL_EVEN_PUNGS",
    "FULL_FLUSH",
    "PURE_TRIPLE_CHOW",
    "PURE_SHIFTED_PUNGS",
    "UPPER_TILES",
    "MIDDLE_TILES",
    "LOWER_TILES",
  ],
  16: [
    "PURE_STRAIGHT",
    "THREE_SUITED_TERMINAL_CHOWS",
    "PURE_SHIFTED_CHOWS",
    "ALL_FIVE",
    "TRIPLE_PUNG",
    "THREE_CONCEALED_PUNGS",
  ],
  12: [
    "LESSER_HONORS_AND_KNITTED_TILES",
    "KNITTED_STRAIGHT",
    "UPPER_FOUR",
    "LOWER_FOUR",
    "BIG_THREE_WINDS",
  ],
  8: [
    "MIXED_STRAIGHT",
    "REVERSIBLE_TILES",
    "MIXED_TRIPLE_CHOW",
    "MIXED_SHIFTED_PUNGS",
    "CHICKEN_HAND",
    "LAST_TILE_DRAW",
    "LAST_TILE_CLAIM",
    "OUT_WITH_REPLACEMENT_TILE",
    "ROBBING_THE_KONG",
    "TWO_CONCEALED_KONGS",
  ],
  6: [
    "ALL_PUNGS",
    "HALF_FLUSH",
    "MIXED_SHIFTED_CHOWS",
    "ALL_TYPES",
    "MELDED_HAND",
    "TWO_DRAGONS_PUNGS",
  ],
  4: [
    "OUTSIDE_HAND",
    "FULLY_CONCEALED_HAND",
    "TWO_MELDED_KONGS",
    "LAST_TILE",
  ],
  2: [
    "DRAGON_PUNG",
    "PREVALENT_WIND",
    "SEAT_WIND",
    "CONCEALED_HAND",
    "ALL_CHOWS",
    "TILE_HOG",
    "DOUBLE_PUNG",
    "TWO_CONCEALED_PUNGS",
    "CONCEALED_KONG",
    "ALL_SIMPLES",
  ],
  1: [
    "PURE_DOUBLE_CHOW",
    "MIXED_DOUBLE_CHOW",
    "SHORT_STRAIGHT",
    "TWO_TERMINAL_CHOWS",
    "PUNG_OF_TERMINALS_OR_HONORS",
    "MELDED_KONG",
    "ONE_VOIDED_SUIT",
    "NO_HONORS",
    "EDGE_WAIT",
    "CLOSED_WAIT",
    "SINGLE_WAIT",
    "SELF_DRAWN",
    "FLOWER_TILES",
  ],
};

describe("EMA Green Book fan vocabulary", () => {
  it("exposes stable IDs, English names, and all 81 values", () => {
    expect(MCR_FAN_IDS).toHaveLength(81);
    expect(new Set(MCR_FAN_IDS).size).toBe(81);
    for (const [points, ids] of Object.entries(VALUES)) {
      for (const id of ids) {
        expect(MCR_FANS[id as keyof typeof MCR_FANS]).toMatchObject({
          id,
          points: Number(points),
        });
        expect(MCR_FANS[id as keyof typeof MCR_FANS].englishName).not.toBe("");
      }
    }
    expect(Object.values(VALUES).flat()).toHaveLength(81);
  });
});

