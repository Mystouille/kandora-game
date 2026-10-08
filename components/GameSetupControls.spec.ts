import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  buildGameSetup,
  GameSetupControls,
  initialGameSetupSelection,
  setupPresetId,
  gameVariantLabel,
} from "./GameSetupControls";

describe("native game setup controls", () => {
  it("keeps each host's four-player preset and normal mode by default", () => {
    for (const preset of ["m-league", "tenhou-hanchan", "buu-east"]) {
      expect(buildGameSetup(preset, initialGameSetupSelection)).toEqual({
        preset,
        playerCount: 4,
        sanmaType: "online",
        mode: { type: "normal" },
        spectatorDelayMs: 0,
      });
    }
  });

  it.each(["online", "kansai"] as const)(
    "uses fixed M-League for %s sanma plus Duplicate without changing the four-player preset",
    (sanmaType) => {
      const selection = {
        ...initialGameSetupSelection,
        playerCount: 3 as const,
        sanmaType,
        duplicateEnabled: true,
        duplicateSeed: " Board A ",
      };
      expect(buildGameSetup("buu-east", selection, 300_000)).toEqual({
        preset: "m-league",
        playerCount: 3,
        sanmaType,
        mode: { type: "duplicate", seed: "Board A", generationVersion: 1 },
        spectatorDelayMs: 300_000,
      });
      expect(setupPresetId("buu-east", selection.playerCount)).toBe("m-league");
      expect(
        buildGameSetup("buu-east", { ...selection, playerCount: 4 }).preset
      ).toBe("buu-east");
    }
  );

  it.each(["", "   ", "x".repeat(129)])(
    "requires a usable Duplicate seed",
    (duplicateSeed) => {
      expect(() =>
        buildGameSetup("m-league", {
          ...initialGameSetupSelection,
          duplicateEnabled: true,
          duplicateSeed,
        })
      ).toThrow("Enter a duplicate seed between 1 and 128 characters.");
    }
  );

  it("exposes a toggle rather than additional presets, and a required seed", () => {
    const html = renderToStaticMarkup(
      createElement(GameSetupControls, {
        value: {
          ...initialGameSetupSelection,
          playerCount: 3,
          duplicateEnabled: true,
        },
        onChange: vi.fn(),
      })
    );
    expect(html).toContain("3-player");
    expect(html).toContain('role="switch"');
    expect(html).toContain('name="sanmaType"');
    expect(html).toContain("Online");
    expect(html).toContain("Kansai");
    expect(html).toContain("Duplicate seed");
    expect(html).toContain('required=""');
  });

  it("does not label a partial legacy seat list as sanma", () => {
    expect(gameVariantLabel({})).toBeNull();
    expect(
      gameVariantLabel({ playerCount: 4, sanmaType: "kansai" })
    ).toBeNull();
    expect(gameVariantLabel({ playerCount: 3, sanmaType: "online" })).toBe(
      "Sanma · Online"
    );
    expect(gameVariantLabel({ playerCount: 3, sanmaType: "kansai" })).toBe(
      "Sanma · Kansai"
    );
  });
});
