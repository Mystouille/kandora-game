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
  it("uses the final reveal timing when the win is not in riichi", () => {
    expect(
      winResultRevealDurationMs({
        visibleYakuCount: 3,
        hasUraYaku: false,
      })
    ).toBe(4_250);
  });

  it("reveals score details with positive ura dora", () => {
    expect(
      winResultRevealDurationMs({
        visibleYakuCount: 4,
        hasUraYaku: true,
      })
    ).toBe(4_250);
  });

  it("uses the same timing when no ura tile scores", () => {
    expect(
      winResultRevealDurationMs({
        visibleYakuCount: 3,
        hasUraYaku: false,
      })
    ).toBe(4_250);
  });

  it("ignores stale ura indicators when the rule set disables ura dora", () => {
    expect(
      winResultRevealDurationMs({
        visibleYakuCount: 3,
        hasUraYaku: false,
        uraDoraEnabled: false,
      })
    ).toBe(3_000);
  });
});
