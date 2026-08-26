import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  ReplayOverlayPanel,
  defaultReplayOverlayState,
  replayOverlayToggles,
} from "./ReplayOverlayPanel";

describe("replayOverlayToggles", () => {
  it("hides wall reveal from live spectate controls", () => {
    expect(replayOverlayToggles(false).map((toggle) => toggle.key)).toEqual([
      "showWaits",
      "showHands",
      "showTsumogiri",
      "showNames",
    ]);
  });

  it("includes wall reveal for completed log replays", () => {
    expect(replayOverlayToggles(true).map((toggle) => toggle.key)).toEqual([
      "showWaits",
      "showHands",
      "showTsumogiri",
      "showWalls",
      "showNames",
    ]);
  });

  it("hides wall reveal while compact layout is active", () => {
    expect(replayOverlayToggles(true, true).map((toggle) => toggle.key)).toEqual([
      "showWaits",
      "showHands",
      "showTsumogiri",
      "showNames",
    ]);
  });

  it("renders the tsumogiri button in both replay sliders", () => {
    const render = (includeWallToggle: boolean): string =>
      renderToStaticMarkup(
        createElement(ReplayOverlayPanel, {
          overlays: defaultReplayOverlayState,
          onChange: () => undefined,
          includeWallToggle,
        })
      );

    const liveReplay = render(false);
    expect(liveReplay).toContain("Show tsumogiri");
    expect(liveReplay).not.toContain("Compact table");
    expect(liveReplay).not.toContain("Show walls");

    const logReplay = render(true);
    expect(logReplay).toContain("Show tsumogiri");
    expect(logReplay).toContain("Show walls");
    expect(logReplay).not.toContain("Compact table");
  });
});