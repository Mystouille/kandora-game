import {
  Children,
  createElement,
  isValidElement,
  type ComponentProps,
  type ReactNode,
} from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  buildGameSetup,
  DEFAULT_GAME_SETUP_PRESET_ID,
  GameSetupControls,
  initialGameSetupSelection,
  setupPresetId,
  gameVariantLabel,
  type GameSetupPreset,
} from "./GameSetupControls";
import { DUPLICATE_GENERATION_VERSION } from "../protocol/matchMode";

const presets: readonly GameSetupPreset[] = [
  {
    id: "m-league",
    rulesFamily: "riichi",
    displayName: "M-League",
    description: "M-League four-player rules.",
  },
  {
    id: "tenhou-hanchan",
    rulesFamily: "riichi",
    displayName: "Tenhou Hanchan",
  },
  { id: "ema", displayName: "Legacy EMA Riichi" },
  {
    id: "mcr-ema",
    rulesFamily: "mcr",
    displayName: "MCR",
  },
];

type ControlsProps = ComponentProps<typeof GameSetupControls>;
type NativeControlProps = {
  children?: ReactNode;
  name?: string;
  type?: string;
  role?: string;
  value?: string | number;
  "aria-label"?: string;
  onChange?: (event: { target: { value: string; checked: boolean } }) => void;
};

function props(overrides: Partial<ControlsProps> = {}): ControlsProps {
  return {
    value: { ...initialGameSetupSelection },
    onChange: vi.fn(),
    presets,
    preset: "m-league",
    onPresetChange: vi.fn(),
    ...overrides,
  };
}

function findControl(
  tree: ReactNode,
  attributes: Partial<NativeControlProps>
): NativeControlProps | undefined {
  for (const child of Children.toArray(tree)) {
    if (!isValidElement<NativeControlProps>(child)) {
      continue;
    }
    if (
      (child.type === "input" || child.type === "select") &&
      Object.entries(attributes).every(
        ([key, value]) => child.props[key as keyof NativeControlProps] === value
      )
    ) {
      return child.props;
    }
    const descendant = findControl(child.props.children, attributes);
    if (descendant) {
      return descendant;
    }
  }
  return undefined;
}

function changeControl(
  config: ControlsProps,
  attributes: Partial<NativeControlProps>,
  target: Partial<{ value: string; checked: boolean }> = {}
) {
  let tree: ReactNode;
  renderToStaticMarkup(
    createElement(function ControlsHarness() {
      tree = GameSetupControls(config);
      return tree;
    })
  );
  const control = findControl(tree, attributes);
  expect(control?.onChange).toBeTypeOf("function");
  control?.onChange?.({
    target: { value: "", checked: true, ...target },
  });
}

describe("native game setup controls", () => {
  it("defaults to Riichi, Yonma, and M-League", () => {
    expect(DEFAULT_GAME_SETUP_PRESET_ID).toBe("m-league");
    expect(initialGameSetupSelection).toEqual({
      rulesFamily: "riichi",
      playerCount: 4,
      sanmaType: "online",
      duplicateEnabled: false,
      duplicateSeed: "",
    });
  });

  it("keeps each host's four-player preset and normal mode by default", () => {
    for (const preset of ["m-league", "tenhou-hanchan", "buu-east"]) {
      expect(buildGameSetup(preset, initialGameSetupSelection)).toEqual({
        preset,
        rulesFamily: "riichi",
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
        rulesFamily: "riichi",
        playerCount: 3,
        sanmaType,
        mode: {
          type: "duplicate",
          seed: "Board A",
          generationVersion: DUPLICATE_GENERATION_VERSION,
        },
        spectatorDelayMs: 300_000,
      });
      expect(setupPresetId("buu-east", selection.playerCount)).toBe("m-league");
      expect(
        buildGameSetup("buu-east", { ...selection, playerCount: 4 }).preset
      ).toBe("buu-east");
    }
  );

  it("builds the fixed four-player EMA MCR setup", () => {
    expect(
      buildGameSetup("m-league", {
        ...initialGameSetupSelection,
        rulesFamily: "mcr",
        playerCount: 3,
        sanmaType: "online",
      })
    ).toEqual({
      preset: "mcr-ema",
      rulesFamily: "mcr",
      playerCount: 4,
      sanmaType: "online",
      mode: { type: "normal" },
      spectatorDelayMs: 0,
    });
    expect(gameVariantLabel({ rulesFamily: "mcr", playerCount: 4 })).toBe("MCR");
  });

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

  it.each([false, true])(
    "orders rules, players, Yonma game type, and Duplicate (mobile: %s)",
    (mobile) => {
      const html = renderToStaticMarkup(
        createElement(GameSetupControls, props({ mobile }))
      );
      const radios = [...html.matchAll(/<input\b[^>]*type="radio"[^>]*>/g)].map(
        ([input]) => input
      );

      expect(radios).toHaveLength(4);
      expect(
        radios.find((input) => input.includes('value="riichi"'))
      ).toContain('checked=""');
      expect(radios.find((input) => input.includes('value="4"'))).toContain(
        'checked=""'
      );
      expect(html).toMatch(/<legend[^>]*>Mahjong rules<\/legend>/);
      expect(html).toMatch(/<legend[^>]*>Players<\/legend>/);
      expect(html).toContain(">Riichi</span>");
      expect(html).toContain(">MCR</span>");
      expect(html).toContain(">Yonma (4 players)</span>");
      expect(html).toContain(">Sanma (3 players)</span>");
      expect(html).toContain('aria-label="Game type"');
      expect(html).toContain('value="m-league" selected=""');
      expect(html).toContain("M-League four-player rules.");
      expect(html).toContain('value="tenhou-hanchan"');
      expect(html).toContain('value="ema"');
      expect(html).toContain("Legacy EMA Riichi");
      expect(html).not.toContain('value="mcr-ema"');
      expect(html).not.toContain('aria-label="Sanma game type"');
      expect(html).not.toContain('name="duplicateSeed"');
      expect(html.match(/role="switch"/g)).toHaveLength(1);
      expect(html).toMatch(
        /<fieldset[^>]*>\s*<legend[^>]*>Duplicate<\/legend>/
      );

      const rulesIndex = html.indexOf(">Mahjong rules</legend>");
      const playersIndex = html.indexOf(">Players</legend>");
      const gameTypeIndex = html.indexOf('aria-label="Game type"');
      const duplicateIndex = html.indexOf(">Duplicate</legend>");
      expect(rulesIndex).toBeLessThan(playersIndex);
      expect(playersIndex).toBeLessThan(gameTypeIndex);
      expect(gameTypeIndex).toBeLessThan(duplicateIndex);
    }
  );

  it("keeps a legacy host-allowed Riichi preset selected", () => {
    const html = renderToStaticMarkup(
      createElement(GameSetupControls, props({ preset: "ema" }))
    );
    expect(html).toContain('value="ema" selected=""');
    expect(html).not.toContain("M-League four-player rules.");
  });

  it.each(["online", "kansai"] as const)(
    "shows only the %s Sanma game type and fixed M-League explanation",
    (sanmaType) => {
      const html = renderToStaticMarkup(
        createElement(
          GameSetupControls,
          props({
            preset: "ema",
            value: {
              ...initialGameSetupSelection,
              playerCount: 3,
              sanmaType,
              duplicateEnabled: true,
              duplicateSeed: "Board A",
            },
          })
        )
      );
      expect(html).toContain('aria-label="Sanma game type"');
      expect(html).toContain('name="sanmaType"');
      expect(html).toContain(`value="${sanmaType}" selected=""`);
      expect(html).toContain(">Online</option>");
      expect(html).toContain(">Kansai</option>");
      expect(html).toContain("fixed M-League base (no head-bump)");
      expect(html).not.toContain('aria-label="Game type"');
      expect(html).not.toContain('value="ema"');
      expect(html.indexOf('aria-label="Sanma game type"')).toBeLessThan(
        html.indexOf(">Duplicate</legend>")
      );
      expect(html).toContain("Duplicate mode");
      expect(html).toContain("Duplicate seed");
      expect(html).toContain('name="duplicateSeed"');
      expect(html).toContain('value="Board A"');
      expect(html).toContain('required=""');
      expect(html).toContain('maxLength="128"');
    }
  );

  it("shows only the fixed EMA four-player summary for MCR", () => {
    const html = renderToStaticMarkup(
      createElement(
        GameSetupControls,
        props({
          value: {
            ...initialGameSetupSelection,
            rulesFamily: "mcr",
            duplicateEnabled: true,
          },
        })
      )
    );
    expect(html.match(/type="radio"/g)).toHaveLength(2);
    expect(html).toContain("EMA Green Book");
    expect(html).toContain("4 players");
    expect(html).not.toContain(">Players</legend>");
    expect(html).not.toContain("Yonma");
    expect(html).not.toContain("<select");
    expect(html).toContain(">Duplicate</legend>");
    expect(html).toContain('role="switch"');
    expect(html).toContain('name="duplicateSeed"');
  });

  it("isolates both radio groups across multiple control instances", () => {
    const html = renderToStaticMarkup(
      createElement(
        "div",
        null,
        createElement(GameSetupControls, props()),
        createElement(GameSetupControls, props({ mobile: true }))
      )
    );
    const names = [...html.matchAll(/<input\b[^>]*type="radio"[^>]*>/g)].map(
      ([input]) => input.match(/\bname="([^"]+)"/)?.[1]
    );
    expect(names).toHaveLength(8);
    expect(names).not.toContain(undefined);
    expect(new Set(names).size).toBe(4);
    for (const name of new Set(names)) {
      expect(names.filter((candidate) => candidate === name)).toHaveLength(2);
    }
  });

  it.each([false, true])(
    "natively disables every setup section including the seed (mobile: %s)",
    (mobile) => {
      const html = renderToStaticMarkup(
        createElement(
          GameSetupControls,
          props({
            mobile,
            disabled: true,
            value: {
              ...initialGameSetupSelection,
              duplicateEnabled: true,
              duplicateSeed: "Board A",
            },
          })
        )
      );
      expect(html).toMatch(
        /^<fieldset(?=[^>]*aria-label="Game setup")(?=[^>]*disabled="")[^>]*>/
      );
      expect(html).toContain('aria-label="Game type"');
      expect(html).toContain('name="duplicateSeed"');
      expect(html).toMatch(/<\/fieldset>$/);
    }
  );

  it("retains the chosen Yonma preset across Sanma and MCR switches", () => {
    const config = props({
      preset: "ema",
      value: {
        ...initialGameSetupSelection,
        duplicateEnabled: true,
        duplicateSeed: "Board A",
      },
    });
    config.onChange = vi.fn((value) => {
      config.value = value;
    });

    changeControl(config, { type: "radio", value: 3 });
    changeControl(
      config,
      { "aria-label": "Sanma game type" },
      { value: "kansai" }
    );
    expect(buildGameSetup(config.preset, config.value)).toMatchObject({
      preset: "m-league",
      playerCount: 3,
      sanmaType: "kansai",
    });
    changeControl(config, { type: "radio", value: 4 });
    expect(buildGameSetup(config.preset, config.value)).toMatchObject({
      preset: "ema",
      playerCount: 4,
    });
    changeControl(config, { type: "radio", value: "mcr" });
    expect(config.value).toEqual({
      rulesFamily: "mcr",
      playerCount: 4,
      sanmaType: "online",
      duplicateEnabled: true,
      duplicateSeed: "Board A",
    });
    expect(buildGameSetup(config.preset, config.value).preset).toBe("mcr-ema");
    changeControl(config, { type: "radio", value: "riichi" });
    expect(buildGameSetup(config.preset, config.value)).toMatchObject({
      preset: "ema",
      rulesFamily: "riichi",
      playerCount: 4,
    });
    expect(config.onPresetChange).not.toHaveBeenCalled();
    expect(config.preset).toBe("ema");
    expect(config.value.duplicateSeed).toBe("Board A");
  });

  it("changes only the Yonma preset when choosing a game type", () => {
    const config = props({
      value: {
        ...initialGameSetupSelection,
        duplicateEnabled: true,
        duplicateSeed: "Board A",
      },
    });
    changeControl(
      config,
      { "aria-label": "Game type" },
      { value: "tenhou-hanchan" }
    );
    expect(config.onPresetChange).toHaveBeenCalledExactlyOnceWith(
      "tenhou-hanchan"
    );
    expect(config.onChange).not.toHaveBeenCalled();
    expect(config.value.duplicateSeed).toBe("Board A");
  });

  it("preserves the game type and seed when Duplicate is disabled and re-enabled", () => {
    const config = props({
      preset: "tenhou-hanchan",
      value: {
        ...initialGameSetupSelection,
        playerCount: 3,
        sanmaType: "kansai",
        duplicateEnabled: true,
        duplicateSeed: "Original board",
      },
    });
    config.onChange = vi.fn((value) => {
      config.value = value;
    });
    changeControl(
      config,
      { name: "duplicateSeed" },
      { value: "Updated board" }
    );
    changeControl(config, { role: "switch" }, { checked: false });
    expect(config.value).toEqual({
      ...initialGameSetupSelection,
      playerCount: 3,
      sanmaType: "kansai",
      duplicateEnabled: false,
      duplicateSeed: "Updated board",
    });
    changeControl(config, { role: "switch" }, { checked: true });
    expect(config.value.duplicateSeed).toBe("Updated board");
    expect(config.onPresetChange).not.toHaveBeenCalled();
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
