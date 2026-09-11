import { describe, expect, it } from "vitest";
import { MatchModeConfigSchema, normalMatchMode } from "./matchMode";

describe("MatchModeConfigSchema", () => {
  it("keeps normal mode as an explicit mode", () => {
    expect(MatchModeConfigSchema.parse(normalMatchMode)).toEqual({
      type: "normal",
    });
  });

  it("trims duplicate seeds while preserving case", () => {
    expect(
      MatchModeConfigSchema.parse({
        type: "duplicate",
        seed: "  Board-A  ",
        generationVersion: 1,
      })
    ).toEqual({
      type: "duplicate",
      seed: "Board-A",
      generationVersion: 1,
    });
  });

  it("rejects empty and oversized duplicate seeds", () => {
    expect(
      MatchModeConfigSchema.safeParse({
        type: "duplicate",
        seed: "   ",
        generationVersion: 1,
      }).success
    ).toBe(false);
    expect(
      MatchModeConfigSchema.safeParse({
        type: "duplicate",
        seed: "x".repeat(129),
        generationVersion: 1,
      }).success
    ).toBe(false);
  });
});