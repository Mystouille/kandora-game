import { afterEach, describe, expect, it } from "vitest";
import {
  ServerMessageSchema,
  type MatchDebug,
  type ServerMessage,
} from "~/game/protocol/messages";
import { parseTileList } from "~/game/client/debugSeed";
import { getPreset, listPresets, presetToRuleSet } from "~/game/rules/presets";
import { resolveRuleSet, type RuleSet } from "~/game/rules/ruleSet";
import { activeSeats } from "~/game/rules/seats";
import { parseMatchCheckpoint } from "./checkpoint";
import {
  MatchProcess,
  setReadyCheckMs,
  waitingRoomSeatPermutation,
} from "./match";
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

function createDependencies() {
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
  return { repository: ephemeralMatchRepository, runtime };
}

function createMatch(rules: RuleSet, presetId: string, debug: MatchDebug) {
  const dependencies = createDependencies();
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

  for (const startMethod of ["startWaitingRoom", "fillBotsAndStart"] as const) {
    it.each(profiles)(
      `delivers the requested hand to the solo human with bots via ${startMethod} in $name`,
      async ({ rules, presetId }) => {
        const seed = [1, 2, 3, 4, 5, 6, 7, 8].find(
          (candidate) =>
            waitingRoomSeatPermutation(candidate, rules.playerCount).indexOf(
              0
            ) !== 0
        );
        if (seed === undefined) {
          throw new Error(
            "Expected a seed that normally moves the host out of East"
          );
        }
        const startingHand =
          rules.playerCount === 3
            ? hand
            : parseTileList("123789m123p1239s").tiles;
        const room = MatchProcess.createWaitingRoom(
          `solo-debug-${presetId}-${rules.playerCount}-${rules.sanmaType}`,
          seed,
          createDependencies(),
          { humanHand: startingHand },
          rules,
          presetId
        );
        const seat = room.claimSeat("tester", "Tester");
        if (seat === null) {
          throw new Error("Expected a seat for the solo player");
        }
        const frames: ServerMessage[] = [];
        const send = (message: ServerMessage) => {
          ServerMessageSchema.parse(message);
          frames.push(message);
        };
        room.attachHuman(seat, send);
        room.setWaitingRoomReady(seat, true);
        setReadyCheckMs(0);
        if (startMethod === "startWaitingRoom") {
          await room.startWaitingRoom(seat);
        } else {
          await room.fillBotsAndStart();
        }

        expect(room.humanSeatForUser("tester")).toBe(0);
        expect(room.humanSeatFor(send)).toBe(0);
        const snapshot = room.buildSnapshotForSeat(0);
        expect(snapshot.state.hands[0]).toHaveLength(14);
        expect(snapshot.state.hands[0].slice(0, 13)).toEqual(startingHand);
        expect(room.buildRoomState(0).seats[0].occupant).toMatchObject({
          kind: "human",
          userId: "tester",
        });
        expect(
          room
            .buildRoomState(0)
            .seats.slice(1)
            .every(({ occupant }) => occupant.kind === "bot")
        ).toBe(true);
        const handStart = frames
          .flatMap((message) =>
            message.type === "event" ? message.events : []
          )
          .find((event) => event.type === "hand_start");
        expect(handStart?.hand?.slice(0, 13)).toEqual(startingHand);
      }
    );
  }

  it.each(profiles)(
    "keeps the debug host and queued opening draw after waiting-room recovery in $name",
    async ({ rules, presetId }) => {
      const dependencies = createDependencies();
      const room = MatchProcess.createWaitingRoom(
        `restored-solo-debug-${presetId}-${rules.sanmaType}`,
        1,
        dependencies,
        { humanHand: hand, humanDraws: ["5s", "6s"], leftDiscards: ["7z"] },
        rules,
        presetId
      );
      expect(room.claimSeat("tester", "Tester")).toBe(0);
      const restored = MatchProcess.restoreCheckpoint(
        parseMatchCheckpoint(room.createCheckpoint()),
        dependencies
      );
      const seat = restored.claimSeat("tester", "Tester");
      if (seat === null) {
        throw new Error("Expected the debug host to retain their waiting seat");
      }
      const send = (message: ServerMessage) => {
        ServerMessageSchema.parse(message);
      };
      restored.attachHuman(seat, send);
      restored.setWaitingRoomReady(seat, true);
      setReadyCheckMs(0);
      await restored.startWaitingRoom(seat);

      expect(restored.humanSeatFor(send)).toBe(0);
      expect(restored.buildSnapshotForSeat(0).state.hands[0]).toEqual([
        ...hand,
        "5s",
      ]);
      expect(restored.owners.kernel.debugQueues()).toEqual({
        humanDraws: ["6s"],
        leftDiscards: ["7z"],
      });
      const botSeat = rules.playerCount === 3 ? 2 : 3;
      expect(restored.buildRoomState(0).seats[botSeat].occupant.kind).toBe(
        "bot"
      );
      expect(restored.owners.kernel.hasForcedBotDiscard(botSeat)).toBe(true);
      expect(restored.owners.actionWindows.legals(0)).toContainEqual({
        id: "tsumo",
        type: "tsumo",
      });
    }
  );

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

  it("offers discard and declaration for a seeded MCR flower draw", async () => {
    const { match } = createMatch(
      presetToRuleSet(getPreset("mcr-ema")),
      "mcr-ema",
      { humanHand: hand, humanDraws: ["1f", "2f", "5s", "6s"] }
    );
    setReadyCheckMs(0);
    await match.start();
    expect(match.buildSnapshotForSeat(0).state.hands[0]).toEqual([
      ...hand,
      "1f",
    ]);
    expect(match.buildSnapshotForSeat(0).state.flowerTiles?.[0]).toEqual([]);
    expect(match.owners.actionWindows.legals(0)).toEqual(
      expect.arrayContaining([
        {
          id: "discard:draw:1f",
          type: "discard",
          tile: "1f",
          discardSource: "draw",
        },
        { id: "flower:1f", type: "flower", tile: "1f" },
      ])
    );
    expect(match.owners.kernel.debugQueues().humanDraws).toEqual([
      "2f",
      "5s",
      "6s",
    ]);

    await match.handleAct(0, "flower:1f");

    expect(match.buildSnapshotForSeat(0).state.hands[0]).toEqual([
      ...hand,
      "2f",
    ]);
    expect(match.buildSnapshotForSeat(0).state.flowerTiles?.[0]).toEqual([
      "1f",
    ]);
    expect(match.owners.actionWindows.legals(0)).toContainEqual({
      id: "discard:draw:2f",
      type: "discard",
      tile: "2f",
      discardSource: "draw",
    });
    expect(match.owners.actionWindows.legals(0)).toContainEqual({
      id: "flower:2f",
      type: "flower",
      tile: "2f",
    });
    expect(match.owners.kernel.debugQueues().humanDraws).toEqual(["5s", "6s"]);
  });

  it("rejects invalid debug tiles before a session can be started", () => {
    expect(() =>
      createMatch(presetToRuleSet(getPreset("mcr-ema")), "mcr-ema", {
        humanDraws: ["0p"],
      })
    ).toThrow("not available");
  });
});
