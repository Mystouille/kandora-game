import { afterEach, describe, expect, it } from "vitest";
import { ServerMessageSchema, type MatchDebug } from "~/game/protocol/messages";
import { getPreset, listPresets, presetToRuleSet } from "~/game/rules/presets";
import { resolveRuleSet, type RuleSet } from "~/game/rules/ruleSet";
import { activeSeats } from "~/game/rules/seats";
import { parseMatchCheckpoint } from "./checkpoint";
import { MatchProcess, setReadyCheckMs } from "./match";
import { ephemeralMatchRepository } from "./repository";
import type { MatchRuntime } from "./runtime";

const hand = [
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
const profiles = [
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

function createMatch(rules: RuleSet, presetId: string, debug: MatchDebug) {
  let now = 1_000;
  const runtime: MatchRuntime = {
    clockEpoch: "debug-seed",
    now: () => now,
    random: () => 0.5,
    captureRandomState: () => 0,
    restoreRandomState: () => undefined,
    schedule: () => ({ cancel: () => undefined }),
    sleep: async (ms) => {
      now += ms;
    },
  };
  const dependencies = { repository: ephemeralMatchRepository, runtime };
  const match = new MatchProcess(
    `debug-${presetId}-${rules.playerCount}-${rules.sanmaType}`,
    42,
    activeSeats(rules.playerCount).map((seat) => ({
      userId: `human-${seat}`,
      displayName: `Human ${seat}`,
      isBot: false,
    })),
    dependencies,
    debug,
    rules,
    presetId
  );
  for (const seat of activeSeats(rules.playerCount)) {
    match.attachHuman(seat, (message) => {
      ServerMessageSchema.parse(message);
    });
  }
  return { match, dependencies };
}

describe("authoritative debug seed startup", () => {
  afterEach(() => setReadyCheckMs(5_000));

  it.each(profiles)(
    "offers the seeded win and preserves remaining queues through recovery in $name",
    async ({ rules, presetId }) => {
      const { match, dependencies } = createMatch(rules, presetId, {
        humanHand: hand,
        humanDraws: ["5s", "6s"],
        leftDiscards: ["7z"],
      });
      setReadyCheckMs(0);
      await match.start();
      const snapshot = match.buildSnapshotForSeat(0);
      expect(snapshot.state.hands[0]).toEqual([...hand, "5s"]);
      expect(snapshot.state.hands).toHaveLength(rules.playerCount);
      expect(match.owners.actionWindows.legals(0)).toContainEqual({
        id: "tsumo",
        type: "tsumo",
      });
      expect(match.owners.kernel.debugQueues()).toEqual({
        humanDraws: ["6s"],
        leftDiscards: ["7z"],
      });
      expect(
        match.owners.kernel.hasForcedBotDiscard(rules.playerCount === 3 ? 2 : 3)
      ).toBe(true);

      const checkpoint = parseMatchCheckpoint(match.createCheckpoint());
      const restored = MatchProcess.restoreCheckpoint(checkpoint, dependencies);
      expect(restored.owners.kernel.debugQueues()).toEqual({
        humanDraws: ["6s"],
        leftDiscards: ["7z"],
      });
      expect(restored.buildSnapshotForSeat(0).state.hands[0]).toEqual([
        ...hand,
        "5s",
      ]);
    }
  );

  it("starts a seeded MCR flower chain with a valid fourteen-tile hand", async () => {
    const { match } = createMatch(
      presetToRuleSet(getPreset("mcr-ema")),
      "mcr-ema",
      { humanHand: hand, humanDraws: ["1f", "2f", "5s", "6s"] }
    );
    setReadyCheckMs(0);
    await match.start();
    const snapshot = match.buildSnapshotForSeat(0);
    expect(snapshot.state.hands[0]).toEqual([...hand, "5s"]);
    expect(snapshot.state.flowerTiles?.[0]).toEqual(["1f", "2f"]);
    expect(match.owners.actionWindows.legals(0)).toContainEqual({
      id: "tsumo",
      type: "tsumo",
    });
    expect(match.owners.kernel.debugQueues().humanDraws).toEqual(["6s"]);
  });

  it("rejects invalid debug tiles before a session can be started", () => {
    expect(() =>
      createMatch(presetToRuleSet(getPreset("mcr-ema")), "mcr-ema", {
        humanDraws: ["0p"],
      })
    ).toThrow("not available");
  });
});
