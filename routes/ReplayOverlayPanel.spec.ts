import { describe, expect, it } from "vitest";
import { replayOverlayToggles } from "./ReplayOverlayPanel";

describe("replayOverlayToggles", () => {
  it("hides wall reveal from live spectate controls", () => {
    expect(replayOverlayToggles(false).map((toggle) => toggle.key)).toEqual([
      "showWaits",
      "showHands",
      "showNames",
    ]);
  });

  it("includes wall reveal for completed log replays", () => {
    expect(replayOverlayToggles(true).map((toggle) => toggle.key)).toEqual([
      "showWaits",
      "showHands",
      "showWalls",
      "showNames",
    ]);
  });
});