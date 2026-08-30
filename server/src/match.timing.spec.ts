import { describe, expect, it } from "vitest";
import {
  remainingWinReactionDelayMs,
  winResultRevealDurationMs,
} from "./match";

describe("victory reaction timing", () => {
  it("leaves a full 700ms beat after a 350ms tile landing", () => {
    const triggerAt = 1_000;
    const minimumAge = 350 + 700;

    expect(
      remainingWinReactionDelayMs(triggerAt, triggerAt + 350, minimumAge)
    ).toBe(700);
    expect(
      remainingWinReactionDelayMs(triggerAt, triggerAt + 1_050, minimumAge)
    ).toBe(0);
  });

  it("does not add delay once a player has already reacted slowly", () => {
    expect(remainingWinReactionDelayMs(1_000, 2_500, 1_050)).toBe(0);
  });
});

describe("win result reveal timing", () => {
  it("leaves a final beat after the last regular yaku", () => {
    expect(
      winResultRevealDurationMs({
        visibleYakuCount: 3,
        hasUraIndicators: false,
        hasUraYaku: false,
      })
    ).toBe(3_000);
  });

  it("leaves a final beat after a positive ura-dora yaku", () => {
    expect(
      winResultRevealDurationMs({
        visibleYakuCount: 4,
        hasUraIndicators: true,
        hasUraYaku: true,
      })
    ).toBe(3_750);
  });

  it("waits for zero-ura indicators before the final beat", () => {
    expect(
      winResultRevealDurationMs({
        visibleYakuCount: 3,
        hasUraIndicators: true,
        hasUraYaku: false,
      })
    ).toBe(4_000);
  });

  it("ignores stale ura indicators when the rule set disables ura dora", () => {
    expect(
      winResultRevealDurationMs({
        visibleYakuCount: 3,
        hasUraIndicators: true,
        hasUraYaku: false,
        uraDoraEnabled: false,
      })
    ).toBe(3_000);
  });
});
