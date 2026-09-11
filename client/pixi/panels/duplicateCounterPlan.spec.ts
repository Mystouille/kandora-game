import { describe, expect, it } from "vitest";
import {
  DUPLICATE_LIMITING_COLOR,
  DUPLICATE_REMAINING_COLOR,
  displayedTilesRemaining,
  duplicatePlayerCounterSpecs,
} from "./duplicateCounterPlan";

const state = {
  initial: [18, 18, 17, 17] as [number, number, number, number],
  remaining: [16, 18, 17, 17] as [number, number, number, number],
  limitingSeat: 0 as const,
  estimatedDrawsRemaining: 67,
};

describe("duplicate counter presentation", () => {
  it("shows raw counts with exactly one highlighted limiting player", () => {
    expect(duplicatePlayerCounterSpecs(state)).toEqual([
      { seat: 0, remaining: 16, limiting: true, color: DUPLICATE_LIMITING_COLOR },
      { seat: 1, remaining: 18, limiting: false, color: DUPLICATE_REMAINING_COLOR },
      { seat: 2, remaining: 17, limiting: false, color: DUPLICATE_REMAINING_COLOR },
      { seat: 3, remaining: 17, limiting: false, color: DUPLICATE_REMAINING_COLOR },
    ]);
  });

  it("uses the limiting-player estimate in the center", () => {
    expect(
      displayedTilesRemaining({ drawsTaken: 3, duplicateWallState: state })
    ).toBe(67);
  });

  it("retains the normal wall counter outside duplicate mode", () => {
    expect(
      displayedTilesRemaining({ drawsTaken: 12, duplicateWallState: null })
    ).toBe(58);
    expect(
      displayedTilesRemaining({ drawsTaken: 80, duplicateWallState: null })
    ).toBe(0);
  });
});