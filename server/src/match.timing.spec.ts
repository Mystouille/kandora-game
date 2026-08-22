import { describe, expect, it } from "vitest";
import { remainingWinReactionDelayMs } from "./match";

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
