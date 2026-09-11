import { describe, expect, it } from "vitest";
import {
  estimateDuplicateExhaustion,
  estimateDuplicateExhaustionFromNextDrawer,
} from "./duplicateExhaustion";

describe("duplicate exhaustion forecast", () => {
  it("identifies dealer+2 as limiting with 70 successful draws initially", () => {
    expect(
      estimateDuplicateExhaustionFromNextDrawer([18, 18, 17, 17], 0)
    ).toEqual({ limitingSeat: 2, estimatedDrawsRemaining: 70 });
  });

  it("accounts for the next drawer instead of using the smallest queue alone", () => {
    expect(
      estimateDuplicateExhaustionFromNextDrawer([17, 18, 17, 17], 1)
    ).toEqual({ limitingSeat: 2, estimatedDrawsRemaining: 69 });
    expect(
      estimateDuplicateExhaustionFromNextDrawer([17, 18, 17, 17], 3)
    ).toEqual({ limitingSeat: 3, estimatedDrawsRemaining: 68 });
  });

  it("uses the post-discard next seat while awaiting a discard", () => {
    expect(
      estimateDuplicateExhaustion([17, 18, 17, 17], {
        phase: "awaiting_discard",
        turn: 2,
        pendingReplacementSeat: null,
      })
    ).toEqual({ limitingSeat: 3, estimatedDrawsRemaining: 68 });
  });

  it("includes the pending declarer replacement after shouminkan", () => {
    expect(
      estimateDuplicateExhaustion([1, 2, 2, 2], {
        phase: "awaiting_chankan",
        turn: 0,
        pendingReplacementSeat: 0,
      })
    ).toEqual({ limitingSeat: 0, estimatedDrawsRemaining: 4 });
  });

  it("returns an immediate exhaustion when the next drawer is empty", () => {
    expect(
      estimateDuplicateExhaustionFromNextDrawer([0, 4, 4, 4], 0)
    ).toEqual({ limitingSeat: 0, estimatedDrawsRemaining: 0 });
  });

  it("has no active forecast after the hand ends", () => {
    expect(
      estimateDuplicateExhaustion([0, 0, 0, 0], {
        phase: "hand_ended",
        turn: 0,
        pendingReplacementSeat: null,
      })
    ).toBeNull();
  });
});