import { describe, expect, it } from "vitest";
import { normalMatchMode } from "~/game/protocol/matchMode";
import { createInitialState, resolveRuleSet, step } from "~/game/rules";
import { getPreset, listPresets, presetToRuleSet } from "~/game/rules/presets";
import { createSystemMatchRuntime } from "../runtime";
import { MatchKernel } from "./matchKernel";

function fixture(rules = resolveRuleSet(), presetId = "tenhou-hanchan") {
  const kernel = new MatchKernel(
    normalMatchMode,
    presetId,
    createSystemMatchRuntime(42),
    rules.playerCount
  );
  kernel.initialize(42, 0, rules);
  return kernel;
}

const debugHand = [
  "1p",
  "1p",
  "1p",
  "2p",
  "2p",
  "2p",
  "3p",
  "3p",
  "3p",
  "4s",
  "4s",
  "4s",
  "5s",
];

const variants = [
  ...listPresets().map((preset) => ({
    name: preset.id,
    presetId: preset.id,
    rules: presetToRuleSet(preset),
  })),
  ...(["online", "kansai"] as const).map((sanmaType) => ({
    name: `sanma-${sanmaType}`,
    presetId: "m-league",
    rules: resolveRuleSet({ playerCount: 3, sanmaType }),
  })),
];

describe("MatchKernel", () => {
  it("preserves initial state and the engine's ordered draw effects", () => {
    const kernel = fixture();
    const initial = createInitialState(42);
    expect(kernel.view).toEqual(initial);
    const expected = step(initial, { type: "draw", seat: 0 });
    expect(kernel.draw()).toEqual(expected);
    expect(kernel.view).toEqual(expected.state);
  });

  it("returns discard effects after updating the sole authoritative state", () => {
    const kernel = fixture();
    kernel.draw();
    const before = step(createInitialState(42), {
      type: "draw",
      seat: 0,
    }).state;
    const tile = kernel.view.lastDrawn[0];
    if (tile === null) {
      throw new Error("expected a drawn tile");
    }
    const expected = step(before, {
      type: "discard",
      seat: 0,
      tile,
      discardSource: "draw",
    });
    expect(kernel.discard(0, tile, "draw")).toEqual(expected);
    expect(kernel.view).toEqual(expected.state);
  });

  it("rejects illegal transitions explicitly without replacing state", () => {
    const kernel = fixture();
    const before = JSON.stringify(kernel.view);
    expect(() => kernel.discard(0, "1m")).toThrow("engine rejected discard");
    expect(JSON.stringify(kernel.view)).toBe(before);
  });

  it("builds legality through engine probes without mutating state", () => {
    const kernel = fixture();
    kernel.draw();
    const before = JSON.stringify(kernel.view);
    expect(
      kernel.discardLegals(0).some((action) => action.type === "discard")
    ).toBe(true);
    expect(JSON.stringify(kernel.view)).toBe(before);
  });

  it("preserves the forced human draw queue and recovery queue snapshots", () => {
    const kernel = fixture();
    kernel.applyDebugSeed({ humanDraws: ["1m", "2p"] });
    kernel.prepareDebugDraw();
    const result = kernel.draw();
    expect(result.events.find((event) => event.type === "draw")).toMatchObject({
      tile: "1m",
    });
    const queues = kernel.debugQueues();
    queues.humanDraws.push("3s");
    expect(kernel.debugQueues().humanDraws).toEqual(["2p"]);
  });

  it.each(variants)(
    "applies the starting hand and opening draw in $name",
    ({ rules, presetId }) => {
      const kernel = fixture(rules, presetId);
      kernel.applyDebugSeed({
        humanHand: debugHand,
        humanDraws: ["5s", "6s"],
      });
      if (kernel.view.phase === "awaiting_draw") {
        kernel.prepareDebugDraw();
        kernel.draw();
      }
      expect(kernel.view.phase).toBe("awaiting_discard");
      expect(kernel.view.hands[0]).toEqual([...debugHand, "5s"]);
      expect(kernel.view.lastDrawn[0]).toBe("5s");
      expect(kernel.debugQueues().humanDraws).toEqual(["6s"]);
      expect(kernel.discard(0, "5s", "draw").events).toContainEqual(
        expect.objectContaining({ type: "discard", seat: 0, tile: "5s" })
      );
      expect(kernel.view.hands[0]).toHaveLength(13);
    }
  );

  it("keeps MCR's random fourteenth tile when only the hand is overridden", () => {
    const kernel = fixture(presetToRuleSet(getPreset("mcr-ema")), "mcr-ema");
    const openingDraw = kernel.view.lastDrawn[0];
    kernel.applyDebugSeed({ humanHand: debugHand });
    expect(kernel.view.hands[0]).toEqual([...debugHand, openingDraw]);
    expect(kernel.view.lastDrawn[0]).toBe(openingDraw);
  });

  it("overrides MCR's opening draw without replacing the other thirteen tiles", () => {
    const kernel = fixture(presetToRuleSet(getPreset("mcr-ema")), "mcr-ema");
    const originalHand = kernel.view.hands[0].slice(0, 13);
    kernel.applyDebugSeed({ humanDraws: ["5s", "6s"] });
    expect(kernel.view.hands[0]).toEqual([...originalHand, "5s"]);
    expect(kernel.view.lastDrawn[0]).toBe("5s");
    expect(kernel.debugQueues().humanDraws).toEqual(["6s"]);
  });

  it.each(variants)(
    "targets the previous active bot's discard queue in $name",
    ({ rules, presetId }) => {
      const kernel = fixture(rules, presetId);
      kernel.applyDebugSeed({ leftDiscards: ["7z"] });
      const previousSeat = rules.playerCount === 3 ? 2 : 3;
      expect(kernel.hasForcedBotDiscard(previousSeat)).toBe(true);
      expect(kernel.hasForcedBotDiscard(0)).toBe(false);
      expect(kernel.hasForcedBotDiscard(1)).toBe(false);
      expect(kernel.botDiscard(previousSeat).tile).toBe("7z");
      expect(kernel.debugQueues().leftDiscards).toEqual([]);
    }
  );

  it("offers discard and declaration for an MCR starting flower", () => {
    const kernel = fixture(presetToRuleSet(getPreset("mcr-ema")), "mcr-ema");
    kernel.applyDebugSeed({
      humanHand: ["1f", ...debugHand.slice(1)],
      humanDraws: ["5s", "2f", "1p", "6s"],
    });
    expect(kernel.view.hands[0]).toHaveLength(14);
    expect(kernel.view.hands[0]).toContain("1f");
    expect(kernel.view.hands[0]).not.toContain("2f");
    expect(kernel.view.flowerTiles[0]).toEqual([]);
    expect(kernel.discardLegals(0)).toEqual(
      expect.arrayContaining([
        {
          id: "discard:hand:1f",
          type: "discard",
          tile: "1f",
          discardSource: "hand",
        },
        { id: "flower", type: "flower", tile: "1f" },
      ])
    );

    kernel.applyAction({ type: "flower", seat: 0, tile: "1f" });
    expect(kernel.view.pendingFlower).toEqual({ seat: 0, tile: "1f" });
    kernel.applyAction({ type: "complete_flower" });
    expect(kernel.view.flowerTiles[0]).toEqual(["1f"]);
    expect(kernel.view.lastDrawn[0]).toBe("2f");
    expect(kernel.discardLegals(0)).toContainEqual({
      id: "discard:draw:2f",
      type: "discard",
      tile: "2f",
      discardSource: "draw",
    });
    expect(kernel.debugQueues().humanDraws).toEqual(["1p", "6s"]);
  });

  it("offers one generic declaration for multiple MCR flowers", () => {
    const kernel = fixture(presetToRuleSet(getPreset("mcr-ema")), "mcr-ema");
    kernel.applyDebugSeed({
      humanHand: ["1f", "2f", ...debugHand.slice(2)],
      humanDraws: ["5s", "6s"],
    });

    expect(
      kernel
        .discardLegals(0)
        .filter((action) => action.type === "flower")
    ).toEqual([{ id: "flower", type: "flower", tile: "1f" }]);
  });

  it("requires a choice for each MCR flower in a replacement chain", () => {
    const kernel = fixture(presetToRuleSet(getPreset("mcr-ema")), "mcr-ema");
    kernel.applyDebugSeed({
      humanHand: debugHand,
      humanDraws: ["1f", "2f", "5s", "6s"],
    });
    expect(kernel.view.hands[0]).toEqual([...debugHand, "1f"]);
    expect(kernel.view.flowerTiles[0]).toEqual([]);
    expect(kernel.view.lastDrawn[0]).toBe("1f");

    kernel.applyAction({ type: "flower", seat: 0, tile: "1f" });
    kernel.applyAction({ type: "complete_flower" });
    expect(kernel.view.hands[0]).toEqual([...debugHand, "2f"]);
    expect(kernel.view.flowerTiles[0]).toEqual(["1f"]);
    expect(kernel.view.lastDrawn[0]).toBe("2f");

    kernel.applyAction({ type: "flower", seat: 0, tile: "2f" });
    kernel.applyAction({ type: "complete_flower" });
    expect(kernel.view.hands[0]).toEqual([...debugHand, "5s"]);
    expect(kernel.view.flowerTiles[0]).toEqual(["1f", "2f"]);
    expect(kernel.view.lastDrawn[0]).toBe("5s");
    expect(kernel.debugQueues().humanDraws).toEqual(["6s"]);
  });

  it("continues the MCR draw queue through flowers on a later turn", () => {
    const kernel = fixture(presetToRuleSet(getPreset("mcr-ema")), "mcr-ema");
    kernel.applyDebugSeed({
      humanHand: debugHand,
      humanDraws: ["5s", "1f", "2f", "6s", "7s"],
    });
    kernel.discard(0, "5s", "draw");
    for (const seat of [1, 2, 3] as const) {
      kernel.draw();
      while (kernel.view.phase === "awaiting_flower_replacement") {
        kernel.applyAction({ type: "complete_flower" });
      }
      const tile = kernel.view.lastDrawn[seat];
      if (tile === null) {
        throw new Error("Expected the other player's drawn tile");
      }
      kernel.discard(seat, tile, "draw");
    }
    expect(kernel.debugQueues().humanDraws).toEqual(["1f", "2f", "6s", "7s"]);
    kernel.prepareDebugDraw();
    kernel.draw();
    expect(kernel.view.pendingFlower).toBeNull();
    expect(kernel.view.lastDrawn[0]).toBe("1f");
    kernel.applyAction({ type: "flower", seat: 0, tile: "1f" });
    kernel.applyAction({ type: "complete_flower" });
    expect(kernel.view.pendingFlower).toBeNull();
    expect(kernel.view.lastDrawn[0]).toBe("2f");
    kernel.applyAction({ type: "flower", seat: 0, tile: "2f" });
    kernel.applyAction({ type: "complete_flower" });
    expect(kernel.view.hands[0]).toEqual([...debugHand, "6s"]);
    expect(kernel.view.flowerTiles[0]).toEqual(["1f", "2f"]);
    expect(kernel.debugQueues().humanDraws).toEqual(["7s"]);
  });

  it.each(variants)(
    "uses the next queued tile for a kan replacement in $name",
    ({ rules, presetId }) => {
      const kernel = fixture(rules, presetId);
      kernel.applyDebugSeed({
        humanHand: [
          "1p",
          "1p",
          "1p",
          "1p",
          "2s",
          "3s",
          "4s",
          "5s",
          "6s",
          "7s",
          "5z",
          "5z",
          "5z",
        ],
        humanDraws: ["9s", "8s", "7s"],
      });
      if (kernel.view.phase === "awaiting_draw") {
        kernel.prepareDebugDraw();
        kernel.draw();
      }
      const result = kernel.applyAction({
        type: "kan",
        seat: 0,
        kind: "ankan",
        tile: "1p",
      });
      expect(result.events).toContainEqual(
        expect.objectContaining({ type: "draw", seat: 0, tile: "8s" })
      );
      expect(kernel.view.lastDrawn[0]).toBe("8s");
      expect(kernel.debugQueues().humanDraws).toEqual(["7s"]);
      if (rules.playerCount === 3) {
        expect(kernel.view.sanmaWall).toMatchObject({
          kanCount: 1,
          replacementsTaken: 1,
        });
      }
    }
  );

  it.each(["online", "kansai"] as const)(
    "uses the next queued tile after %s nuki without consuming it on declaration",
    (sanmaType) => {
      const kernel = fixture(
        resolveRuleSet({ playerCount: 3, sanmaType }),
        "m-league"
      );
      const nuki = sanmaType === "online" ? "4z" : "5m";
      kernel.applyDebugSeed({
        humanHand: debugHand,
        humanDraws: [nuki, "5s", "6s"],
      });
      kernel.prepareDebugDraw();
      kernel.draw();
      kernel.applyAction({ type: "nuki", seat: 0, tile: nuki });
      expect(kernel.debugQueues().humanDraws).toEqual(["5s", "6s"]);
      const result = kernel.applyAction({ type: "complete_nuki" });
      expect(result.events).toContainEqual(
        expect.objectContaining({
          type: "draw",
          seat: 0,
          tile: "5s",
          replacementKind: "nuki",
        })
      );
      expect(kernel.view.nukiTiles[0]).toEqual([nuki]);
      expect(kernel.view.hands[0]).toEqual([...debugHand, "5s"]);
      expect(kernel.debugQueues().humanDraws).toEqual(["6s"]);
    }
  );

  it("uses queued replacements for opening Kansai nuki before the normal draw", () => {
    const kernel = fixture(
      resolveRuleSet({ playerCount: 3, sanmaType: "kansai" }),
      "m-league"
    );
    kernel.applyDebugSeed({
      humanHand: ["0m", ...debugHand.slice(1)],
      humanDraws: ["1p", "5s", "6s"],
    });
    kernel.applyAction({ type: "nuki", seat: 0, tile: "0m", opening: true });
    const replacement = kernel.applyAction({ type: "complete_nuki" });
    expect(replacement.events).toContainEqual(
      expect.objectContaining({ type: "draw", tile: "1p", opening: true })
    );
    expect(kernel.view.hands[0]).toHaveLength(13);
    kernel.prepareDebugDraw();
    kernel.draw();
    expect(kernel.view.hands[0].at(-1)).toBe("5s");
    expect(kernel.debugQueues().humanDraws).toEqual(["6s"]);
  });

  it("does not mutate the hand, wall, or queue when a forced kan is rejected", () => {
    const kernel = fixture();
    kernel.applyDebugSeed({ humanHand: debugHand, humanDraws: ["5s", "6s"] });
    kernel.prepareDebugDraw();
    kernel.draw();
    const before = JSON.stringify(kernel.view);
    expect(() =>
      kernel.applyAction({ type: "kan", seat: 0, kind: "ankan", tile: "9m" })
    ).toThrow("engine rejected");
    expect(JSON.stringify(kernel.view)).toBe(before);
    expect(kernel.debugQueues().humanDraws).toEqual(["6s"]);
  });

  it("rejects invalid debug configuration before modifying state or queues", () => {
    const kernel = fixture(presetToRuleSet(getPreset("mcr-ema")), "mcr-ema");
    const before = JSON.stringify(kernel.view);
    expect(() => kernel.applyDebugSeed({ humanHand: ["1p"] })).toThrow(
      "13 tiles"
    );
    expect(() => kernel.applyDebugSeed({ humanDraws: ["0p"] })).toThrow(
      "not available"
    );
    expect(JSON.stringify(kernel.view)).toBe(before);
    expect(kernel.debugQueues()).toEqual({ humanDraws: [], leftDiscards: [] });
  });
});
