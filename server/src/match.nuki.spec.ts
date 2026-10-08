import { afterEach, describe, expect, it, vi } from "vitest";
import { MatchProcess, setReadyCheckMs, setNextHandDelayMs } from "./match";
import { ephemeralMatchRepository } from "./repository";
import type { MatchRuntime } from "./runtime";
import { activeSeats } from "~/game/rules/seats";
import type { GameEvent, Seat } from "~/game/protocol/messages";
import { ServerMessageSchema } from "~/game/protocol/messages";
import { duplicateMatchSeed } from "./match-drivers/duplicatePlan";
import {
  normalMatchMode,
  type MatchModeConfig,
} from "~/game/protocol/matchMode";
import { editMatchState } from "~/game/testing/matchState";
import { parseMatchCheckpoint, type MatchCheckpoint } from "./checkpoint";

async function startMatch(
  sanmaType: "online" | "kansai",
  mode: MatchModeConfig = normalMatchMode,
  northDraw = false,
  capturePending = false
) {
  let now = 1_000;
  const runtime: MatchRuntime = {
    clockEpoch: `nuki-${sanmaType}-${mode.type}`,
    now: () => now,
    random: () => 0.5,
    captureRandomState: () => 0,
    restoreRandomState: () => undefined,
    schedule: () => ({ cancel: () => undefined }),
    sleep: async (ms) => {
      now += ms;
    },
  };
  const events: GameEvent[] = [];
  const match = new MatchProcess(
    `nuki-${sanmaType}-${mode.type}`,
    mode.type === "duplicate" ? duplicateMatchSeed(mode) : 42,
    activeSeats(3).map((seat) => ({
      userId: `human-${seat}`,
      displayName: `Human ${seat}`,
      isBot: false,
    })),
    { repository: ephemeralMatchRepository, runtime },
    northDraw ? { humanDraws: ["4z"] } : undefined,
    { playerCount: 3, sanmaType },
    "m-league",
    mode
  );
  for (const seat of activeSeats(3)) {
    match.attachHuman(seat, (message) => {
      ServerMessageSchema.parse(message);
      if (seat === 0 && message.type === "event") {
        events.push(...message.events);
      }
    });
  }
  const captured: { checkpoint: MatchCheckpoint | null } = { checkpoint: null };
  if (capturePending) {
    const apply = match.owners.gameplay.effects.applyEngineAction.bind(
      match.owners.gameplay.effects
    );
    vi.spyOn(
      match.owners.gameplay.effects,
      "applyEngineAction"
    ).mockImplementation(async (action) => {
      const result = await apply(action);
      if (
        captured.checkpoint === null &&
        result.phase === "awaiting_nuki_replacement"
      ) {
        captured.checkpoint = match.createCheckpoint();
      }
      return result;
    });
  }
  setReadyCheckMs(0);
  setNextHandDelayMs(0);
  await match.start();
  return {
    match,
    runtime,
    events,
    captured,
    act: async (seat: Seat, id: string) => {
      const window = match.owners.actionWindows.timedView(seat);
      if (window === null) {
        throw new Error(`No decision window for seat ${seat}`);
      }
      now = Math.max(now, window.opensAt);
      await match.handleAct(seat, id, match.actionReceipt(seat, now));
    },
  };
}

describe("authoritative nuki orchestration", () => {
  afterEach(() => {
    setReadyCheckMs(5_000);
    setNextHandDelayMs(5_000);
    vi.restoreAllMocks();
  });

  it.each(["normal", "duplicate"] as const)(
    "automatically normalizes opening Kansai hands in %s",
    async (kind) => {
      const mode: MatchModeConfig =
        kind === "duplicate"
          ? { type: "duplicate", seed: "Board-A", generationVersion: 1 }
          : normalMatchMode;
      const { match, runtime, events } = await startMatch("kansai", mode);
      const state = match.owners.kernel.currentState();
      expect(
        state.hands.flat().some((tile) => tile === "5m" || tile === "0m")
      ).toBe(false);
      expect(state.hands.map((hand) => hand.length)).toEqual([14, 13, 13]);
      expect(state.nukiTiles.flat().length).toBeGreaterThan(0);
      expect(
        events.some(
          (event) => event.type === "nuki" && event.stage === "completed"
        )
      ).toBe(true);
      const nukiCount = state.nukiTiles.flat().length;
      expect(state.sanmaWall?.replacementsTaken).toBe(nukiCount);
      expect(state.liveWall.length).toBe(
        kind === "normal" ? 62 : 58 - nukiCount
      );
      const snapshot = match.buildSnapshotForSeat(0);
      expect(snapshot.state.drawsTaken).toBe(1 + nukiCount);
      expect(snapshot.state.liveDrawsTaken).toBe(1);
      const saved = parseMatchCheckpoint(match.createCheckpoint());
      const restored = MatchProcess.restoreCheckpoint(saved, {
        repository: ephemeralMatchRepository,
        runtime,
      });
      expect(restored.owners.kernel.currentState().nukiTiles).toEqual(
        state.nukiTiles
      );
      expect(restored.owners.kernel.driverSnapshot()).toEqual(
        match.owners.kernel.driverSnapshot()
      );
      expect(restored.owners.kernel.currentState().sanmaWall).toEqual(
        state.sanmaWall
      );
    }
  );

  it("waits for every eligible human instead of auto-ronning the second opponent", async () => {
    const { match, runtime, act, events } = await startMatch(
      "online",
      normalMatchMode,
      true
    );
    editMatchState(match, (state) => {
      const waiting = [
        "1p",
        "2p",
        "3p",
        "4p",
        "5p",
        "6p",
        "7p",
        "8p",
        "9p",
        "1s",
        "2s",
        "3s",
        "4z",
      ];
      state.hands[1] = [...waiting];
      state.hands[2] = [...waiting];
      state.roundWind = "S";
      state.roundNumber = 3;
    });
    const before = match.owners.kernel.currentState().liveWall.length;
    expect(
      match
        .buildSnapshotForSeat(0)
        .legalActions.some((action) => action.type === "nuki")
    ).toBe(true);
    await act(0, "nuki:4z");
    expect(match.owners.kernel.currentState().phase).toBe("awaiting_chankan");
    expect(match.owners.gameplay.calls.isOpen(1)).toBe(true);
    expect(match.owners.gameplay.calls.isOpen(2)).toBe(true);
    const checkpoint = parseMatchCheckpoint(match.createCheckpoint());
    expect(checkpoint.status === "playing" && checkpoint.checkpointKind).toBe(
      "call_window"
    );
    const restored = MatchProcess.restoreCheckpoint(checkpoint, {
      repository: ephemeralMatchRepository,
      runtime,
    });
    expect(restored.owners.kernel.pendingRobbery()?.kind).toBe("nuki");
    expect(
      restored.owners.kernel.currentState().sanmaWall?.replacementsTaken
    ).toBe(0);
    await act(1, "pass");
    expect(events.some((event) => event.type === "win")).toBe(false);
    const ron = match.owners.actionWindows
      .legals(2)
      .find((action) => action.type === "ron");
    if (!ron) {
      throw new Error("Expected a North-ron action");
    }
    await act(2, ron.id);
    const wins = events.filter((event) => event.type === "win");
    expect(wins.map((event) => event.seat)).toEqual([2]);
    expect(match.owners.kernel.currentState().nukiTiles[0]).toEqual([]);
    expect(
      match.owners.kernel.currentState().sanmaWall?.replacementsTaken
    ).toBe(0);
    expect(match.owners.kernel.currentState().liveWall.length).toBe(before);
    expect(
      events.some(
        (event) => event.type === "draw" && event.replacementKind === "nuki"
      )
    ).toBe(false);
  });

  it.each(["normal", "duplicate"] as const)(
    "resumes an interrupted mandatory %s replacement exactly once",
    async (kind) => {
      const mode: MatchModeConfig =
        kind === "duplicate"
          ? { type: "duplicate", seed: "Board-A", generationVersion: 1 }
          : normalMatchMode;
      const { match, runtime, captured } = await startMatch(
        "kansai",
        mode,
        false,
        true
      );
      const checkpoint = captured.checkpoint;
      if (
        checkpoint === null ||
        checkpoint.status !== "playing" ||
        checkpoint.checkpointKind !== "nuki_replacement"
      ) {
        throw new Error("Expected a captured mandatory replacement");
      }
      const restored = MatchProcess.restoreCheckpoint(checkpoint, {
        repository: ephemeralMatchRepository,
        runtime,
      });
      expect(restored.owners.kernel.currentState().phase).toBe(
        "awaiting_nuki_replacement"
      );
      await restored.owners.recovery.resumeAutomaticWork();
      expect(restored.owners.kernel.currentState().hands).toEqual(
        match.owners.kernel.currentState().hands
      );
      expect(restored.owners.kernel.currentState().nukiTiles).toEqual(
        match.owners.kernel.currentState().nukiTiles
      );
      expect(restored.owners.kernel.currentState().sanmaWall).toEqual(
        match.owners.kernel.currentState().sanmaWall
      );
      expect(restored.owners.kernel.driverSnapshot()).toEqual(
        match.owners.kernel.driverSnapshot()
      );
      const before = structuredClone(restored.owners.kernel.currentState());
      await restored.owners.recovery.resumeAutomaticWork();
      expect(restored.owners.kernel.currentState()).toEqual(before);
    }
  );
});
