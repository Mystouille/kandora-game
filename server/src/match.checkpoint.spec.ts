import { afterEach, describe, expect, it, vi } from "vitest";
import { createPRNG, type MatchState } from "~/game/rules";
import { getPreset, presetToRuleSet } from "~/game/rules/presets";
import type { LegalAction } from "~/game/protocol/messages";
import {
  MATCH_CHECKPOINT_SCHEMA_VERSION,
  parseMatchCheckpoint,
  type MatchCheckpoint,
} from "./checkpoint";
import {
  MatchProcess,
  setDelayAfterDiscardMs,
  setNextHandDelayMs,
  setReadyCheckMs,
} from "./match";
import {
  createMemoryMatchRepository,
  ephemeralMatchRepository,
  type MatchRepository,
} from "./repository";
import type { MatchRuntime } from "./runtime";

const runtime: MatchRuntime = {
  now: () => 1_234_567,
  random: () => 0.5,
  captureRandomState: () => 123,
  restoreRandomState: () => undefined,
  schedule: () => ({ cancel: () => undefined }),
  sleep: async () => undefined,
};

const dependencies = {
  repository: ephemeralMatchRepository,
  runtime,
};

interface ControlledMatchRuntime extends MatchRuntime {
  advance(ms: number): void;
  runNextTimer(): void;
  scheduledDelays(): number[];
}

function controlledRuntime(
  initialNow: number,
  randomSeed: number
): ControlledMatchRuntime {
  let now = initialNow;
  const random = createPRNG(randomSeed);
  const timers: Array<{
    callback: () => void;
    delayMs: number;
    cancelled: boolean;
    fired: boolean;
  }> = [];
  return {
    now: () => now,
    random: () => random.next(),
    captureRandomState: () => random.getState(),
    restoreRandomState: (state) => random.setState(state),
    schedule: (callback, delayMs) => {
      const timer = { callback, delayMs, cancelled: false, fired: false };
      timers.push(timer);
      return {
        cancel: () => {
          timer.cancelled = true;
        },
      };
    },
    sleep: async (delayMs) => {
      now += delayMs;
    },
    advance: (ms) => {
      now += ms;
    },
    runNextTimer: () => {
      const timer = timers.find(
        (candidate) => !candidate.cancelled && !candidate.fired
      );
      if (!timer) {
        throw new Error("no active timer");
      }
      timer.fired = true;
      timer.callback();
    },
    scheduledDelays: () =>
      timers
        .filter((timer) => !timer.cancelled && !timer.fired)
        .map((timer) => timer.delayMs),
  };
}

function humanPlayers() {
  return [0, 1, 2, 3].map((seat) => ({
    userId: `human-${seat}`,
    displayName: `Human ${seat}`,
    isBot: false,
  }));
}

function oneHumanPlayers() {
  return [0, 1, 2, 3].map((seat) => ({
    userId: seat === 0 ? "human-0" : `bot-${seat}`,
    displayName: seat === 0 ? "Human 0" : `Bot ${seat}`,
    isBot: seat !== 0,
  }));
}

function comparableSnapshot(
  match: MatchProcess,
  seat: 0 | 1 | 2 | 3,
  runtime: MatchRuntime
) {
  const snapshot = match.buildSnapshotForSeat(seat);
  if (snapshot.type !== "snapshot") {
    throw new Error("expected snapshot");
  }
  return {
    state: snapshot.state,
    legalActions: snapshot.legalActions,
    deadlineRemaining:
      snapshot.deadline === undefined
        ? undefined
        : snapshot.deadline - runtime.now(),
    bufferMs: snapshot.bufferMs,
  };
}

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

describe("MatchProcess checkpoints", () => {
  afterEach(() => {
    setReadyCheckMs(5_000);
    setNextHandDelayMs(5_000);
    setDelayAfterDiscardMs(350);
  });

  it("round-trips a waiting room through JSON with sockets detached", () => {
    const ruleSet = presetToRuleSet(getPreset("buu-east"));
    const room = MatchProcess.createWaitingRoom(
      "checkpoint-room",
      42,
      dependencies,
      { humanDraws: ["1m", "2m"], leftDiscards: ["3p"] },
      ruleSet,
      "buu-east"
    );
    const aliceSeat = room.claimSeat("alice", "Alice");
    const bobSeat = room.claimSeat("bob", "Bob");
    if (aliceSeat === null || bobSeat === null) {
      throw new Error("expected both players to claim seats");
    }
    room.attachHuman(aliceSeat, () => undefined);

    const checkpoint = room.createCheckpoint();
    if (checkpoint.status !== "waiting") {
      throw new Error("expected a waiting-room checkpoint");
    }
    const restored = MatchProcess.restoreCheckpoint(
      JSON.parse(JSON.stringify(checkpoint)),
      dependencies
    );

    expect(checkpoint.schemaVersion).toBe(MATCH_CHECKPOINT_SCHEMA_VERSION);
    expect(checkpoint.savedAt).toBe(1_234_567);
    expect(checkpoint.ruleSet).toEqual(ruleSet);
    expect(checkpoint.debug).toEqual({
      humanDraws: ["1m", "2m"],
      leftDiscards: ["3p"],
    });
    expect(restored.summary()).toEqual(room.summary());
    expect(restored.claimSeat("alice", "Changed name")).toBe(aliceSeat);
    expect(restored.claimSeat("bob", "Changed name")).toBe(bobSeat);

    const restoredRoom = restored.buildRoomState(aliceSeat);
    const restoredAlice = restoredRoom.seats[aliceSeat].occupant;
    expect(restoredAlice).toMatchObject({
      kind: "human",
      userId: "alice",
      displayName: "Alice",
      connected: false,
    });
  });

  it("preserves bot occupants in a waiting room", () => {
    const room = MatchProcess.createWaitingRoom(
      "checkpoint-bots",
      7,
      dependencies
    );
    room.claimSeat("alice", "Alice");
    room.fillBots();

    const restored = MatchProcess.restoreCheckpoint(
      room.createCheckpoint(),
      dependencies
    );

    expect(restored.buildRoomState(null).seats).toEqual(
      room.buildRoomState(null).seats
    );
  });

  it("starts with the same seating and state after restoration", async () => {
    const room = MatchProcess.createWaitingRoom(
      "checkpoint-start",
      73,
      dependencies
    );
    for (let seat = 0; seat < 4; seat++) {
      room.claimSeat(`human-${seat}`, `Human ${seat}`);
    }
    const restored = MatchProcess.restoreCheckpoint(
      room.createCheckpoint(),
      dependencies
    );
    setReadyCheckMs(0);

    await room.fillBotsAndStart();
    await restored.fillBotsAndStart();

    expect(restored.buildRoomState(null)).toEqual(room.buildRoomState(null));
    expect(restored.buildSnapshotForSeat(0)).toEqual(
      room.buildSnapshotForSeat(0)
    );
  });

  it("pauses and restores a waiting room through the repository", async () => {
    const repository = createMemoryMatchRepository();
    const room = MatchProcess.createWaitingRoom(
      "checkpoint-waiting-save",
      74,
      { repository, runtime }
    );
    room.claimSeat("alice", "Alice");

    await room.pauseAndSaveCheckpoint();

    expect(room.isPaused).toBe(true);
    await expect(room.waitUntilConnectionReady()).resolves.toBe(false);
    expect(() => room.claimSeat("bob", "Bob")).toThrow(/match is paused/);
    const restored = await MatchProcess.restoreSavedCheckpoint(room.matchId, {
      repository,
      runtime,
    });
    if (!restored) {
      throw new Error("expected a saved waiting room");
    }
    expect(restored.summary()).toEqual(room.summary());
    expect(restored.claimSeat("bob", "Bob")).not.toBeNull();
  });

  it("restores a partially-acknowledged initial ready check", async () => {
    const originalRuntime = controlledRuntime(70_000, 1001);
    const match = new MatchProcess(
      "checkpoint-initial-ready",
      61,
      humanPlayers(),
      {
        repository: ephemeralMatchRepository,
        runtime: originalRuntime,
      }
    );
    setReadyCheckMs(5_000);
    setDelayAfterDiscardMs(0);
    const starting = match.start();
    await vi.waitFor(() => {
      const candidate = match.createCheckpoint();
      expect(candidate).toMatchObject({
        status: "playing",
        checkpointKind: "ready_check",
        readyContinuation: "initial_hand",
      });
    });
    await match.handleReady(0);
    const checkpoint = match.createCheckpoint();
    if (
      checkpoint.status !== "playing" ||
      checkpoint.checkpointKind !== "ready_check"
    ) {
      throw new Error("expected an initial ready checkpoint");
    }
    expect(checkpoint.readyAcked).toEqual([true, false, false, false]);

    const restoredRuntime = controlledRuntime(1_000_000, 1002);
    const restored = MatchProcess.restoreCheckpoint(checkpoint, {
      repository: ephemeralMatchRepository,
      runtime: restoredRuntime,
    });
    for (const seat of [1, 2, 3] as const) {
      await match.handleReady(seat);
      await restored.handleReady(seat);
    }
    await starting;
    await vi.waitFor(() => {
      const candidate = restored.createCheckpoint();
      expect(candidate).toMatchObject({
        status: "playing",
        checkpointKind: "action_window",
      });
    });

    expect(restored.replayFromBuffer(0, 0)).toEqual(
      match.replayFromBuffer(0, 0)
    );
    expect(comparableSnapshot(restored, 0, restoredRuntime)).toEqual(
      comparableSnapshot(match, 0, originalRuntime)
    );
    expect(restoredRuntime.captureRandomState()).toBe(
      originalRuntime.captureRandomState()
    );
  });

  it("does not acknowledge ready until the command is durable", async () => {
    const storage = createMemoryMatchRepository();
    const gate = deferred();
    let captured:
      | Parameters<MatchRepository["saveCommandTransaction"]>[0]
      | null = null;
    const repository: MatchRepository = {
      ...storage,
      saveCommandTransaction: async (args) => {
        captured = args;
        await gate.promise;
        await storage.saveCommandTransaction(args);
      },
    };
    const runtime = controlledRuntime(75_000, 1051);
    const match = new MatchProcess(
      "checkpoint-ready-write-ahead",
      611,
      humanPlayers(),
      { repository, runtime }
    );
    setReadyCheckMs(5_000);
    setDelayAfterDiscardMs(0);
    const starting = match.start();
    await vi.waitFor(() => {
      expect(match.createCheckpoint()).toMatchObject({
        status: "playing",
        checkpointKind: "ready_check",
      });
    });

    const acknowledging = match.handleReady(0);
    await Promise.resolve();

    expect(captured).toMatchObject({
      matchId: match.matchId,
      command: { type: "ready", seat: 0 },
    });
    expect(match.createCheckpoint()).toMatchObject({
      checkpointKind: "ready_check",
      readyAcked: [false, false, false, false],
    });
    expect(() => runtime.runNextTimer()).toThrow(/no active timer/);

    gate.resolve();
    await acknowledging;

    expect(match.createCheckpoint()).toMatchObject({
      checkpointKind: "ready_check",
      readyAcked: [true, false, false, false],
    });
    expect(await repository.loadRecoveryRecord(match.matchId)).toMatchObject({
      pendingCommand: null,
    });
    for (const seat of [1, 2, 3] as const) {
      await match.handleReady(seat);
    }
    await starting;
  });

  it("retries a failed ready-command commit before resuming its timer", async () => {
    const storage = createMemoryMatchRepository();
    const retryGate = deferred();
    let commitAttempts = 0;
    const repository: MatchRepository = {
      ...storage,
      saveCheckpoint: async (args) => {
        commitAttempts += 1;
        if (commitAttempts === 1) {
          throw new Error("ready command commit failed");
        }
        if (commitAttempts === 2) {
          await retryGate.promise;
        }
        await storage.saveCheckpoint(args);
      },
    };
    const runtime = controlledRuntime(75_500, 1056);
    const match = new MatchProcess(
      "checkpoint-ready-commit-retry",
      613,
      humanPlayers(),
      { repository, runtime }
    );
    setReadyCheckMs(5_000);
    setDelayAfterDiscardMs(0);
    const starting = match.start();
    await vi.waitFor(() => {
      expect(match.createCheckpoint()).toMatchObject({
        checkpointKind: "ready_check",
      });
    });

    await expect(match.handleReady(0)).rejects.toThrow(
      "ready command commit failed"
    );

    expect(match.isPaused).toBe(true);
    expect(match.hasPendingCommandCommit).toBe(true);
    expect(() => runtime.runNextTimer()).toThrow(/no active timer/);
    expect(await repository.loadRecoveryRecord(match.matchId)).toMatchObject({
      checkpoint: { readyAcked: [false, false, false, false] },
      pendingCommand: { type: "ready", seat: 0 },
    });

    const retrying = match.retryPendingCommandCommit();
    expect(match.retryPendingCommandCommit()).toBe(retrying);
    expect(commitAttempts).toBe(2);
    retryGate.resolve();
    await expect(retrying).resolves.toBe(true);
    expect(commitAttempts).toBe(2);
    const committed = match.createCheckpoint();
    if (
      committed.status !== "playing" ||
      committed.checkpointKind !== "ready_check"
    ) {
      throw new Error("expected a committed ready checkpoint");
    }
    expect(committed.readyAcked).toEqual([true, false, false, false]);
    expect(runtime.scheduledDelays().at(-1)).toBe(
      committed.readyRemainingMs
    );
    for (const seat of [1, 2, 3] as const) {
      await match.handleReady(seat);
    }
    await starting;
  });

  it("accepts ready while a parent command boundary is still saving", async () => {
    const storage = createMemoryMatchRepository();
    const gate = deferred();
    let boundarySaveStarted = false;
    const repository: MatchRepository = {
      ...storage,
      saveCheckpoint: async (args) => {
        if (!boundarySaveStarted) {
          boundarySaveStarted = true;
          await gate.promise;
        }
        await storage.saveCheckpoint(args);
      },
    };
    const runtime = controlledRuntime(75_750, 1058);
    const match = new MatchProcess(
      "checkpoint-ready-boundary-race",
      615,
      humanPlayers(),
      { repository, runtime }
    );
    setReadyCheckMs(0);
    setDelayAfterDiscardMs(0);
    await match.start();
    setNextHandDelayMs(5_000);
    const internals = match as unknown as {
      state: MatchState;
      afterHandEnd: () => Promise<void>;
      commandTransactionPromise: Promise<void> | null;
      activeCommandTransactionId: number | null;
    };
    internals.state.phase = "hand_ended";
    internals.state.lastHandResult = {
      reason: "exhaustive_draw",
      winner: null,
      loser: null,
      delta: [0, 0, 0, 0],
      tenpai: [false, false, false, false],
      abortKind: null,
      winHan: null,
      winYakuman: null,
    };
    internals.commandTransactionPromise = new Promise<void>(() => undefined);
    internals.activeCommandTransactionId = 999;
    const advancing = internals.afterHandEnd();
    await vi.waitFor(() => {
      expect(boundarySaveStarted).toBe(true);
    });

    const acknowledging = match.handleReady(0);
    await Promise.resolve();
    expect(match.createCheckpoint()).toMatchObject({
      checkpointKind: "ready_check",
      readyAcked: [false, false, false, false],
    });

    gate.resolve();
    await acknowledging;
    expect(match.createCheckpoint()).toMatchObject({
      checkpointKind: "ready_check",
      readyAcked: [true, false, false, false],
    });
    for (const seat of [1, 2, 3] as const) {
      await match.handleReady(seat);
    }
    await advancing;
    expect(match.createCheckpoint()).toMatchObject({
      checkpointKind: "action_window",
    });
  });

  it("replays ready and resumes a completed ready checkpoint once", async () => {
    const repository = createMemoryMatchRepository();
    const originalRuntime = controlledRuntime(76_000, 1061);
    const match = new MatchProcess(
      "checkpoint-ready-command-replay",
      612,
      humanPlayers(),
      { repository, runtime: originalRuntime }
    );
    setReadyCheckMs(5_000);
    setDelayAfterDiscardMs(0);
    void match.start();
    await vi.waitFor(() => {
      expect(match.createCheckpoint()).toMatchObject({
        status: "playing",
        checkpointKind: "ready_check",
      });
    });
    const checkpoint = match.createCheckpoint();
    if (
      checkpoint.status !== "playing" ||
      checkpoint.checkpointKind !== "ready_check"
    ) {
      throw new Error("expected a ready checkpoint");
    }
    await repository.saveCommandTransaction({
      matchId: match.matchId,
      checkpoint,
      command: { type: "ready", seat: 0 },
    });

    const restoredRuntime = controlledRuntime(1_060_000, 1062);
    const restored = await MatchProcess.restoreSavedCheckpoint(match.matchId, {
      repository,
      runtime: restoredRuntime,
    });
    if (!restored) {
      throw new Error("expected a restored ready command");
    }
    expect(restored.createCheckpoint()).toMatchObject({
      checkpointKind: "ready_check",
      readyAcked: [true, false, false, false],
    });
    for (const seat of [1, 2, 3] as const) {
      await restored.handleReady(seat);
    }
    const completed = await repository.loadRecoveryRecord(match.matchId);
    expect(completed).toMatchObject({
      checkpoint: {
        checkpointKind: "ready_check",
        readyAcked: [true, true, true, true],
      },
      pendingCommand: null,
    });

    const recoveredRuntime = controlledRuntime(1_060_000, 1063);
    const recovered = await MatchProcess.restoreSavedCheckpoint(match.matchId, {
      repository,
      runtime: recoveredRuntime,
    });
    if (!recovered) {
      throw new Error("expected a completed ready recovery");
    }
    await vi.waitFor(() => {
      expect(restored.createCheckpoint()).toMatchObject({
        checkpointKind: "action_window",
      });
      expect(recovered.createCheckpoint()).toMatchObject({
        checkpointKind: "action_window",
      });
    });
    expect(recovered.replayFromBuffer(0, 0)).toEqual(
      restored.replayFromBuffer(0, 0)
    );
  });

  it("returns recovery when a pending win reaches result transition", async () => {
    const repository = createMemoryMatchRepository();
    const originalRuntime = controlledRuntime(77_000, 1071);
    const match = new MatchProcess(
      "checkpoint-win-command-boundary",
      614,
      humanPlayers(),
      { repository, runtime: originalRuntime }
    );
    setReadyCheckMs(0);
    setDelayAfterDiscardMs(0);
    await match.start();
    setNextHandDelayMs(5_000);
    const internals = match as unknown as {
      state: MatchState;
      buildDiscardLegals: (seat: 0) => LegalAction[];
      setSeatLegals: (seat: 0, actions: LegalAction[]) => void;
    };
    internals.state.hands[0] = [
      "1m",
      "1m",
      "1m",
      "1m",
      "2m",
      "3m",
      "2p",
      "3p",
      "4p",
      "2s",
      "3s",
      "4s",
      "2z",
      "2z",
    ];
    internals.state.turn = 0;
    internals.state.phase = "awaiting_discard";
    internals.state.lastDrawn = ["2z", null, null, null];
    internals.state.liveWall = [];
    internals.setSeatLegals(0, internals.buildDiscardLegals(0));
    const checkpoint = match.createCheckpoint();
    if (
      checkpoint.status !== "playing" ||
      checkpoint.checkpointKind !== "action_window"
    ) {
      throw new Error("expected an action checkpoint");
    }
    const tsumo = checkpoint.actionWindow.legalActions.find(
      (action) => action.type === "tsumo"
    );
    if (!tsumo) {
      throw new Error("expected a legal tsumo");
    }
    await repository.saveCommandTransaction({
      matchId: match.matchId,
      checkpoint,
      command: { type: "act", seat: 0, actionId: tsumo.id },
    });

    const restoredRuntime = controlledRuntime(1_070_000, 1072);
    const restored = await MatchProcess.restoreSavedCheckpoint(match.matchId, {
      repository,
      runtime: restoredRuntime,
    });
    if (!restored) {
      throw new Error("expected a recovered win command");
    }
    const transition = restored.createCheckpoint();
    if (
      transition.status !== "playing" ||
      transition.checkpointKind !== "result_transition"
    ) {
      throw new Error("expected recovery at result transition");
    }
    expect(await repository.loadRecoveryRecord(match.matchId)).toMatchObject({
      checkpoint: { checkpointKind: "result_transition" },
      pendingCommand: null,
    });

    restoredRuntime.advance(transition.transitionRemainingMs);
    restoredRuntime.runNextTimer();
    await vi.waitFor(() => {
      expect(restored.createCheckpoint()).toMatchObject({
        checkpointKind: "ready_check",
      });
    });
    for (const seat of [0, 1, 2, 3] as const) {
      await restored.handleReady(seat);
    }
    await vi.waitFor(() => {
      expect(restored.createCheckpoint()).toMatchObject({
        checkpointKind: "action_window",
      });
    });
    expect(await repository.loadRecoveryRecord(match.matchId)).toMatchObject({
      checkpoint: {
        checkpointKind: "ready_check",
        readyAcked: [true, true, true, true],
      },
      pendingCommand: null,
    });
  });

  it("restores a partially-acknowledged post-hand ready check", async () => {
    const originalRuntime = controlledRuntime(80_000, 1101);
    const match = new MatchProcess(
      "checkpoint-next-ready",
      62,
      humanPlayers(),
      {
        repository: ephemeralMatchRepository,
        runtime: originalRuntime,
      }
    );
    setReadyCheckMs(0);
    setDelayAfterDiscardMs(0);
    await match.start();
    setNextHandDelayMs(5_000);
    const internals = match as unknown as {
      state: MatchState;
      afterHandEnd: () => Promise<void>;
    };
    internals.state.phase = "hand_ended";
    internals.state.lastHandResult = {
      reason: "exhaustive_draw",
      winner: null,
      loser: null,
      delta: [0, 0, 0, 0],
      tenpai: [false, false, false, false],
      abortKind: null,
      winHan: null,
      winYakuman: null,
    };
    const advancing = internals.afterHandEnd();
    await vi.waitFor(() => {
      const candidate = match.createCheckpoint();
      expect(candidate).toMatchObject({
        status: "playing",
        checkpointKind: "ready_check",
        readyContinuation: "next_hand",
      });
    });
    await match.handleReady(0);
    const checkpoint = match.createCheckpoint();
    if (
      checkpoint.status !== "playing" ||
      checkpoint.checkpointKind !== "ready_check"
    ) {
      throw new Error("expected a next-hand ready checkpoint");
    }

    const restoredRuntime = controlledRuntime(1_100_000, 1102);
    const restored = MatchProcess.restoreCheckpoint(checkpoint, {
      repository: ephemeralMatchRepository,
      runtime: restoredRuntime,
    });
    for (const seat of [1, 2, 3] as const) {
      await match.handleReady(seat);
      await restored.handleReady(seat);
    }
    await advancing;
    await vi.waitFor(() => {
      const candidate = restored.createCheckpoint();
      expect(candidate).toMatchObject({
        status: "playing",
        checkpointKind: "action_window",
      });
    });

    expect(restored.replayFromBuffer(0, 0)).toEqual(
      match.replayFromBuffer(0, 0)
    );
    expect(comparableSnapshot(restored, 0, restoredRuntime)).toEqual(
      comparableSnapshot(match, 0, originalRuntime)
    );
  });

  it("restores the remaining post-hand reveal before opening ready", async () => {
    const originalRuntime = controlledRuntime(85_000, 1151);
    const match = new MatchProcess(
      "checkpoint-post-hand-reveal",
      64,
      humanPlayers(),
      {
        repository: ephemeralMatchRepository,
        runtime: originalRuntime,
      }
    );
    setReadyCheckMs(0);
    setDelayAfterDiscardMs(0);
    await match.start();
    setNextHandDelayMs(5_000);
    const internals = match as unknown as {
      state: MatchState;
      pendingWinRevealMs: number;
      afterHandEnd: () => Promise<void>;
    };
    internals.state.phase = "hand_ended";
    internals.state.lastHandResult = {
      reason: "tsumo",
      winner: 0,
      loser: null,
      delta: [3000, -1000, -1000, -1000],
      tenpai: null,
      abortKind: null,
      winHan: 1,
      winYakuman: false,
    };
    internals.pendingWinRevealMs = 3_000;
    const advancing = internals.afterHandEnd();
    originalRuntime.advance(1_000);
    const checkpoint = match.createCheckpoint();
    if (
      checkpoint.status !== "playing" ||
      checkpoint.checkpointKind !== "result_transition"
    ) {
      throw new Error("expected a result-transition checkpoint");
    }
    expect(checkpoint.transitionKind).toBe("post_hand_reveal");
    expect(checkpoint.transitionRemainingMs).toBe(2_000);
    expect(checkpoint.nextReadyMs).toBe(5_000);

    const restoredRuntime = controlledRuntime(1_150_000, 1152);
    const restored = MatchProcess.restoreCheckpoint(checkpoint, {
      repository: ephemeralMatchRepository,
      runtime: restoredRuntime,
    });
    originalRuntime.advance(checkpoint.transitionRemainingMs);
    restoredRuntime.advance(checkpoint.transitionRemainingMs);
    originalRuntime.runNextTimer();
    restoredRuntime.runNextTimer();
    await vi.waitFor(() => {
      expect(match.createCheckpoint()).toMatchObject({
        status: "playing",
        checkpointKind: "ready_check",
        readyContinuation: "next_hand",
      });
      expect(restored.createCheckpoint()).toMatchObject({
        status: "playing",
        checkpointKind: "ready_check",
        readyContinuation: "next_hand",
      });
    });

    for (const seat of [0, 1, 2, 3] as const) {
      await match.handleReady(seat);
      await restored.handleReady(seat);
    }
    await advancing;
    await vi.waitFor(() => {
      expect(restored.createCheckpoint()).toMatchObject({
        status: "playing",
        checkpointKind: "action_window",
      });
    });
    expect(restored.replayFromBuffer(0, 0)).toEqual(
      match.replayFromBuffer(0, 0)
    );
    expect(comparableSnapshot(restored, 0, restoredRuntime)).toEqual(
      comparableSnapshot(match, 0, originalRuntime)
    );
  });

  it("rearms the post-hand reveal after checkpoint save failure", async () => {
    const gate = deferred();
    const capturedCheckpoints: MatchCheckpoint[] = [];
    const storage = createMemoryMatchRepository();
    let failNextSave = true;
    const repository: MatchRepository = {
      ...storage,
      saveCheckpoint: async (args) => {
        const { checkpoint } = args;
        capturedCheckpoints.push(checkpoint);
        if (failNextSave) {
          failNextSave = false;
          await gate.promise;
          return;
        }
        await storage.saveCheckpoint(args);
      },
    };
    const runtime = controlledRuntime(87_000, 1161);
    const match = new MatchProcess(
      "checkpoint-post-hand-reveal-failure",
      65,
      humanPlayers(),
      { repository, runtime }
    );
    setReadyCheckMs(0);
    setDelayAfterDiscardMs(0);
    await match.start();
    setNextHandDelayMs(5_000);
    const internals = match as unknown as {
      state: MatchState;
      pendingWinRevealMs: number;
      afterHandEnd: () => Promise<void>;
    };
    internals.state.phase = "hand_ended";
    internals.state.lastHandResult = {
      reason: "tsumo",
      winner: 0,
      loser: null,
      delta: [3000, -1000, -1000, -1000],
      tenpai: null,
      abortKind: null,
      winHan: 1,
      winYakuman: false,
    };
    internals.pendingWinRevealMs = 3_000;
    const advancing = internals.afterHandEnd();
    runtime.advance(1_000);

    const saving = match.pauseAndSaveCheckpoint();
    const captured = capturedCheckpoints[0];
    if (
      captured?.status !== "playing" ||
      captured.checkpointKind !== "result_transition"
    ) {
      throw new Error("expected a captured result transition");
    }
    expect(() => runtime.runNextTimer()).toThrow(/no active timer/);
    runtime.advance(30_000);
    gate.reject(new Error("result checkpoint write failed"));
    await expect(saving).rejects.toThrow("result checkpoint write failed");

    expect(match.isPaused).toBe(false);
    expect(runtime.scheduledDelays().at(-1)).toBe(
      captured.transitionRemainingMs
    );
    runtime.advance(captured.transitionRemainingMs);
    runtime.runNextTimer();
    await vi.waitFor(() => {
      expect(match.createCheckpoint()).toMatchObject({
        status: "playing",
        checkpointKind: "ready_check",
      });
    });
    for (const seat of [0, 1, 2, 3] as const) {
      await match.handleReady(seat);
    }
    await advancing;
    expect(match.createCheckpoint()).toMatchObject({
      status: "playing",
      checkpointKind: "action_window",
    });
  });

  it("rejects checkpoint writes during an unmodeled win-reaction sleep", async () => {
    const gate = deferred();
    let saveCount = 0;
    const repository: MatchRepository = {
      ...ephemeralMatchRepository,
      saveCheckpoint: async () => {
        saveCount += 1;
      },
    };
    const runtime = controlledRuntime(88_000, 1171);
    runtime.sleep = async () => gate.promise;
    const match = new MatchProcess(
      "checkpoint-win-reaction-guard",
      66,
      humanPlayers(),
      { repository, runtime }
    );
    setReadyCheckMs(0);
    setDelayAfterDiscardMs(0);
    await match.start();
    setDelayAfterDiscardMs(1_000);
    const sleeping = (
      match as unknown as {
        waitForWinReaction: (trigger: "draw") => Promise<void>;
      }
    ).waitForWinReaction("draw");
    await Promise.resolve();

    expect(() => match.createCheckpoint()).toThrow(
      /transition win_reaction/
    );
    expect(() => match.pauseAndSaveCheckpoint()).toThrow(
      /transition win_reaction/
    );
    expect(saveCount).toBe(0);

    gate.resolve();
    await sleeping;
    expect(match.createCheckpoint()).toMatchObject({
      status: "playing",
      checkpointKind: "action_window",
    });
  });

  it("rearms a ready continuation after checkpoint save failure", async () => {
    const gate = deferred();
    const capturedCheckpoints: MatchCheckpoint[] = [];
    const storage = createMemoryMatchRepository();
    let failNextSave = true;
    const repository: MatchRepository = {
      ...storage,
      saveCheckpoint: async (args) => {
        const { checkpoint } = args;
        capturedCheckpoints.push(checkpoint);
        if (failNextSave) {
          failNextSave = false;
          await gate.promise;
          return;
        }
        await storage.saveCheckpoint(args);
      },
    };
    const runtime = controlledRuntime(90_000, 1201);
    const match = new MatchProcess(
      "checkpoint-ready-save-failure",
      63,
      humanPlayers(),
      { repository, runtime }
    );
    setReadyCheckMs(5_000);
    setDelayAfterDiscardMs(0);
    const starting = match.start();
    await vi.waitFor(() => {
      const candidate = match.createCheckpoint();
      expect(candidate).toMatchObject({
        status: "playing",
        checkpointKind: "ready_check",
      });
    });

    const saving = match.pauseAndSaveCheckpoint();
    const captured = capturedCheckpoints[0];
    if (
      captured?.status !== "playing" ||
      captured.checkpointKind !== "ready_check"
    ) {
      throw new Error("expected a captured ready checkpoint");
    }
    expect(match.isPaused).toBe(true);
    await match.handleReady(0);
    expect(match.createCheckpoint()).toEqual(captured);
    expect(() => runtime.runNextTimer()).toThrow(/no active timer/);
    runtime.advance(30_000);
    gate.reject(new Error("ready checkpoint write failed"));
    await expect(saving).rejects.toThrow("ready checkpoint write failed");

    expect(match.isPaused).toBe(false);
    expect(runtime.scheduledDelays().at(-1)).toBe(captured.readyRemainingMs);
    for (const seat of [0, 1, 2, 3] as const) {
      await match.handleReady(seat);
    }
    await starting;
    expect(match.createCheckpoint()).toMatchObject({
      status: "playing",
      checkpointKind: "action_window",
    });
  });

  it("rejects unsupported versions and duplicate human identities", () => {
    const room = MatchProcess.createWaitingRoom(
      "checkpoint-invalid",
      9,
      dependencies
    );
    room.claimSeat("alice", "Alice");
    const checkpoint = room.createCheckpoint();

    expect(() =>
      parseMatchCheckpoint({ ...checkpoint, schemaVersion: 2 })
    ).toThrow();
    expect(() =>
      parseMatchCheckpoint({
        ...checkpoint,
        seats: [checkpoint.seats[0], checkpoint.seats[0], null, null],
      })
    ).toThrow(/Human user IDs must be unique/);
  });

  it("round-trips and continues a quiescent human action window", async () => {
    const originalRuntime = controlledRuntime(10_000, 123);
    const match = new MatchProcess(
      "checkpoint-playing",
      11,
      humanPlayers(),
      {
        repository: ephemeralMatchRepository,
        runtime: originalRuntime,
      }
    );
    setReadyCheckMs(0);
    setDelayAfterDiscardMs(0);
    await match.start();
    originalRuntime.advance(2_000);

    const checkpoint = match.createCheckpoint();
    if (
      checkpoint.status !== "playing" ||
      checkpoint.checkpointKind !== "action_window"
    ) {
      throw new Error("expected a playing checkpoint");
    }
    const restoredRuntime = controlledRuntime(500_000, 999);
    const restored = MatchProcess.restoreCheckpoint(
      JSON.parse(JSON.stringify(checkpoint)),
      {
        repository: ephemeralMatchRepository,
        runtime: restoredRuntime,
      }
    );

    expect(checkpoint.actionWindow.elapsedMs).toBe(2_000);
    expect(checkpoint.actionWindow.visibleRemainingMs).toBe(3_000);
    expect(restoredRuntime.scheduledDelays().at(-1)).toBe(
      checkpoint.actionWindow.expiryRemainingMs
    );
    expect(restoredRuntime.captureRandomState()).toBe(
      originalRuntime.captureRandomState()
    );
    expect(restored.buildRoomState(0).seats[0].occupant).toMatchObject({
      kind: "human",
      connected: false,
    });
    expect(comparableSnapshot(restored, 0, restoredRuntime)).toEqual(
      comparableSnapshot(match, 0, originalRuntime)
    );
    expect(restored.replayFromBuffer(0, 0)).toEqual(
      match.replayFromBuffer(0, 0)
    );

    const discard = checkpoint.actionWindow.legalActions.find(
      (action) => action.type === "discard"
    );
    if (!discard) {
      throw new Error("expected a legal discard");
    }
    await match.handleAct(checkpoint.actionWindow.seat, discard.id);
    await restored.handleAct(checkpoint.actionWindow.seat, discard.id);

    expect(restored.replayFromBuffer(0, 0)).toEqual(
      match.replayFromBuffer(0, 0)
    );
    for (const seat of [0, 1, 2, 3] as const) {
      expect(comparableSnapshot(restored, seat, restoredRuntime)).toEqual(
        comparableSnapshot(match, seat, originalRuntime)
      );
    }
  });

  it("resumes the remaining deadline and applies the same default action", async () => {
    const originalRuntime = controlledRuntime(20_000, 321);
    const match = new MatchProcess(
      "checkpoint-expiry",
      21,
      humanPlayers(),
      {
        repository: ephemeralMatchRepository,
        runtime: originalRuntime,
      }
    );
    setReadyCheckMs(0);
    setDelayAfterDiscardMs(0);
    await match.start();
    originalRuntime.advance(2_000);
    const checkpoint = match.createCheckpoint();
    if (
      checkpoint.status !== "playing" ||
      checkpoint.checkpointKind !== "action_window"
    ) {
      throw new Error("expected a playing checkpoint");
    }

    const restoredRuntime = controlledRuntime(900_000, 654);
    const restored = MatchProcess.restoreCheckpoint(checkpoint, {
      repository: ephemeralMatchRepository,
      runtime: restoredRuntime,
    });
    const beforeCount = checkpoint.eventLog.length;
    originalRuntime.advance(checkpoint.actionWindow.expiryRemainingMs);
    restoredRuntime.advance(checkpoint.actionWindow.expiryRemainingMs);
    originalRuntime.runNextTimer();
    restoredRuntime.runNextTimer();

    await vi.waitFor(() => {
      expect(match.replayFromBuffer(0, 0).length).toBeGreaterThan(beforeCount);
      expect(restored.replayFromBuffer(0, 0).length).toBeGreaterThan(
        beforeCount
      );
    });
    expect(restored.replayFromBuffer(0, 0)).toEqual(
      match.replayFromBuffer(0, 0)
    );
    for (const seat of [0, 1, 2, 3] as const) {
      expect(comparableSnapshot(restored, seat, restoredRuntime)).toEqual(
        comparableSnapshot(match, seat, originalRuntime)
      );
    }
  });

  it("restores randomness before continuing through bot turns", async () => {
    const originalRuntime = controlledRuntime(40_000, 777);
    const match = new MatchProcess(
      "checkpoint-bot-continuation",
      31,
      oneHumanPlayers(),
      {
        repository: ephemeralMatchRepository,
        runtime: originalRuntime,
      }
    );

    setReadyCheckMs(0);
    setDelayAfterDiscardMs(0);
    await match.start();
    const checkpoint = match.createCheckpoint();
    if (
      checkpoint.status !== "playing" ||
      checkpoint.checkpointKind !== "action_window"
    ) {
      throw new Error("expected a playing checkpoint");
    }

    const restoredRuntime = controlledRuntime(700_000, 999);
    const restored = MatchProcess.restoreCheckpoint(checkpoint, {
      repository: ephemeralMatchRepository,
      runtime: restoredRuntime,
    });
    const discard = checkpoint.actionWindow.legalActions.find(
      (action) => action.type === "discard"
    );
    if (!discard) {
      throw new Error("expected a legal discard");
    }

    await match.handleAct(0, discard.id);
    await restored.handleAct(0, discard.id);

    expect(restored.replayFromBuffer(0, 0)).toEqual(
      match.replayFromBuffer(0, 0)
    );
    expect(comparableSnapshot(restored, 0, restoredRuntime)).toEqual(
      comparableSnapshot(match, 0, originalRuntime)
    );
    expect(restoredRuntime.captureRandomState()).toBe(
      originalRuntime.captureRandomState()
    );
  });

  it("preserves explicit AFK until the restored player opts back in", async () => {
    const originalRuntime = controlledRuntime(45_000, 801);
    const match = new MatchProcess(
      "checkpoint-explicit-afk",
      32,
      humanPlayers(),
      {
        repository: ephemeralMatchRepository,
        runtime: originalRuntime,
      }
    );
    setReadyCheckMs(0);
    setDelayAfterDiscardMs(0);
    await match.start();
    await match.handleAfk(1, true);

    const checkpoint = match.createCheckpoint();
    if (checkpoint.status !== "playing") {
      throw new Error("expected a playing checkpoint");
    }
    expect(checkpoint.connectionPolicy.disconnected[1]).toBe(true);
    expect(checkpoint.connectionPolicy.afkSelfReported[1]).toBe(true);

    const restored = MatchProcess.restoreCheckpoint(checkpoint, {
      repository: ephemeralMatchRepository,
      runtime: controlledRuntime(800_000, 802),
    });
    restored.attachHuman(1, () => undefined);
    expect(restored.buildRoomState(1).seats[1].occupant).toMatchObject({
      kind: "human",
      connected: false,
    });

    await restored.handleAfk(1, false);
    expect(restored.buildRoomState(1).seats[1].occupant).toMatchObject({
      kind: "human",
      connected: true,
    });
    const resumed = restored.createCheckpoint();
    if (resumed.status !== "playing") {
      throw new Error("expected a resumed playing checkpoint");
    }
    expect(resumed.connectionPolicy.disconnected[1]).toBe(false);
    expect(resumed.connectionPolicy.afkSelfReported[1]).toBe(false);
  });

  it("does not mark AFK or apply its default before the command is durable", async () => {
    const storage = createMemoryMatchRepository();
    const gate = deferred();
    let captured:
      | Parameters<MatchRepository["saveCommandTransaction"]>[0]
      | null = null;
    const repository: MatchRepository = {
      ...storage,
      saveCommandTransaction: async (args) => {
        captured = args;
        await gate.promise;
        await storage.saveCommandTransaction(args);
      },
    };
    const runtime = controlledRuntime(45_500, 805);
    const match = new MatchProcess(
      "checkpoint-afk-write-ahead",
      321,
      humanPlayers(),
      { repository, runtime }
    );
    setReadyCheckMs(0);
    setDelayAfterDiscardMs(0);
    await match.start();
    const checkpoint = match.createCheckpoint();
    if (
      checkpoint.status !== "playing" ||
      checkpoint.checkpointKind !== "action_window"
    ) {
      throw new Error("expected an action checkpoint");
    }
    const seat = checkpoint.actionWindow.seat;
    const drawn = checkpoint.state.lastDrawn[seat];
    const safeDefault =
      checkpoint.actionWindow.legalActions.find(
        (action) =>
          action.type === "discard" &&
          action.tile === drawn &&
          (action.discardSource === "draw" ||
            action.discardSource === undefined)
      ) ??
      checkpoint.actionWindow.legalActions.find(
        (action) => action.type === "discard"
      );
    if (!safeDefault) {
      throw new Error("expected a safe discard default");
    }
    const beforeEvents = match.replayFromBuffer(0, 0);

    const markingAfk = match.handleAfk(seat, true);
    await Promise.resolve();

    expect(captured).toMatchObject({
      matchId: match.matchId,
      checkpoint,
      command: {
        type: "afk",
        seat,
        afk: true,
        defaultActionId: safeDefault.id,
      },
    });
    const frozen = match.createCheckpoint();
    if (frozen.status !== "playing") {
      throw new Error("expected frozen playing authority");
    }
    expect(frozen.connectionPolicy.disconnected[seat]).toBe(false);
    expect(frozen.connectionPolicy.afkSelfReported[seat]).toBe(false);
    expect(match.replayFromBuffer(0, 0)).toEqual(beforeEvents);
    expect(() => runtime.runNextTimer()).toThrow(/no active timer/);

    gate.resolve();
    await markingAfk;

    const committed = match.createCheckpoint();
    if (committed.status !== "playing") {
      throw new Error("expected a playing AFK checkpoint");
    }
    expect(committed.connectionPolicy.disconnected[seat]).toBe(true);
    expect(committed.connectionPolicy.afkSelfReported[seat]).toBe(true);
    expect(match.replayFromBuffer(0, 0).length).toBeGreaterThan(
      beforeEvents.length
    );
    expect(await repository.loadRecoveryRecord(match.matchId)).toMatchObject({
      pendingCommand: null,
    });
  });

  it("replays a durable AFK default after process loss", async () => {
    const repository = createMemoryMatchRepository();
    const originalRuntime = controlledRuntime(45_750, 806);
    const match = new MatchProcess(
      "checkpoint-afk-command-replay",
      322,
      humanPlayers(),
      { repository, runtime: originalRuntime }
    );
    setReadyCheckMs(0);
    setDelayAfterDiscardMs(0);
    await match.start();
    const checkpoint = match.createCheckpoint();
    if (
      checkpoint.status !== "playing" ||
      checkpoint.checkpointKind !== "action_window"
    ) {
      throw new Error("expected an action checkpoint");
    }
    const seat = checkpoint.actionWindow.seat;
    const drawn = checkpoint.state.lastDrawn[seat];
    const safeDefault =
      checkpoint.actionWindow.legalActions.find(
        (action) =>
          action.type === "discard" &&
          action.tile === drawn &&
          (action.discardSource === "draw" ||
            action.discardSource === undefined)
      ) ??
      checkpoint.actionWindow.legalActions.find(
        (action) => action.type === "discard"
      );
    if (!safeDefault) {
      throw new Error("expected a safe discard default");
    }
    await repository.saveCommandTransaction({
      matchId: match.matchId,
      checkpoint,
      command: {
        type: "afk",
        seat,
        afk: true,
        defaultActionId: safeDefault.id,
      },
    });

    const expectedRuntime = controlledRuntime(900_000, 807);
    const expected = MatchProcess.restoreCheckpoint(checkpoint, {
      repository: ephemeralMatchRepository,
      runtime: expectedRuntime,
    });
    await expected.handleAfk(seat, true);
    const restoredRuntime = controlledRuntime(900_000, 808);
    const restored = await MatchProcess.restoreSavedCheckpoint(match.matchId, {
      repository,
      runtime: restoredRuntime,
    });
    if (!restored) {
      throw new Error("expected a restored AFK command");
    }

    expect(restored.replayFromBuffer(0, 0)).toEqual(
      expected.replayFromBuffer(0, 0)
    );
    expect(comparableSnapshot(restored, 0, restoredRuntime)).toEqual(
      comparableSnapshot(expected, 0, expectedRuntime)
    );
    const restoredCheckpoint = restored.createCheckpoint();
    if (restoredCheckpoint.status !== "playing") {
      throw new Error("expected a restored playing checkpoint");
    }
    expect(restoredCheckpoint.connectionPolicy.disconnected[seat]).toBe(true);
    expect(restoredCheckpoint.connectionPolicy.afkSelfReported[seat]).toBe(
      true
    );
    expect(await repository.loadRecoveryRecord(match.matchId)).toMatchObject({
      pendingCommand: null,
    });
  });

  it("retries a failed AFK command commit", async () => {
    const storage = createMemoryMatchRepository();
    let commitAttempts = 0;
    const repository: MatchRepository = {
      ...storage,
      saveCheckpoint: async (args) => {
        commitAttempts += 1;
        if (commitAttempts === 1) {
          throw new Error("AFK command commit failed");
        }
        await storage.saveCheckpoint(args);
      },
    };
    const runtime = controlledRuntime(45_900, 811);
    const match = new MatchProcess(
      "checkpoint-afk-commit-retry",
      324,
      humanPlayers(),
      { repository, runtime }
    );
    setReadyCheckMs(0);
    setDelayAfterDiscardMs(0);
    await match.start();
    const checkpoint = match.createCheckpoint();
    if (
      checkpoint.status !== "playing" ||
      checkpoint.checkpointKind !== "action_window"
    ) {
      throw new Error("expected an action checkpoint");
    }
    const seat = checkpoint.actionWindow.seat;

    await expect(match.handleAfk(seat, true)).rejects.toThrow(
      "AFK command commit failed"
    );

    expect(match.isPaused).toBe(true);
    expect(match.hasPendingCommandCommit).toBe(true);
    expect(await repository.loadRecoveryRecord(match.matchId)).toMatchObject({
      checkpoint: { checkpointKind: "action_window" },
      pendingCommand: { type: "afk", seat, afk: true },
    });

    await expect(match.retryPendingCommandCommit()).resolves.toBe(true);
    expect(commitAttempts).toBe(2);
    const committed = match.createCheckpoint();
    if (committed.status !== "playing") {
      throw new Error("expected a committed AFK checkpoint");
    }
    expect(committed.connectionPolicy.disconnected[seat]).toBe(true);
    expect(committed.connectionPolicy.afkSelfReported[seat]).toBe(true);
  });

  it("does not apply a liveness default after the match is paused", async () => {
    const repository = createMemoryMatchRepository();
    const runtime = controlledRuntime(45_950, 812);
    const match = new MatchProcess(
      "checkpoint-liveness-pause",
      325,
      humanPlayers(),
      { repository, runtime }
    );
    setReadyCheckMs(0);
    setDelayAfterDiscardMs(0);
    await match.start();
    let resolveProbe!: (alive: boolean) => void;
    const probe = new Promise<boolean>((resolve) => {
      resolveProbe = resolve;
    });
    const seat = match.createCheckpoint();
    if (
      seat.status !== "playing" ||
      seat.checkpointKind !== "action_window"
    ) {
      throw new Error("expected an action checkpoint");
    }
    match.attachHuman(seat.actionWindow.seat, () => undefined, () => probe);
    const internals = match as unknown as {
      bufferMs: [number, number, number, number];
      handleDeadlineExpiry: (seat: 0 | 1 | 2 | 3) => Promise<void>;
      livenessProbeInflight: [boolean, boolean, boolean, boolean];
    };
    internals.bufferMs[seat.actionWindow.seat] = 0;
    const beforeCount = match.replayFromBuffer(0, 0).length;
    const expiring = internals.handleDeadlineExpiry(seat.actionWindow.seat);
    await vi.waitFor(() => {
      expect(internals.livenessProbeInflight[seat.actionWindow.seat]).toBe(
        true
      );
    });

    await match.pauseAndSaveCheckpoint();
    resolveProbe(false);
    await expiring;

    expect(match.isPaused).toBe(true);
    expect(match.replayFromBuffer(0, 0)).toHaveLength(beforeCount);
    expect(await repository.loadRecoveryRecord(match.matchId)).toMatchObject({
      checkpoint: { checkpointKind: "action_window" },
      pendingCommand: null,
    });
  });

  it("serializes a client action behind an automatic default", async () => {
    const gate = deferred();
    const runtime = controlledRuntime(45_975, 813);
    const match = new MatchProcess(
      "checkpoint-automatic-action-race",
      326,
      humanPlayers(),
      { repository: ephemeralMatchRepository, runtime }
    );
    setReadyCheckMs(0);
    setDelayAfterDiscardMs(0);
    await match.start();
    const checkpoint = match.createCheckpoint();
    if (
      checkpoint.status !== "playing" ||
      checkpoint.checkpointKind !== "action_window"
    ) {
      throw new Error("expected an action checkpoint");
    }
    const seat = checkpoint.actionWindow.seat;
    const drawn = checkpoint.state.lastDrawn[seat];
    const safeDefault =
      checkpoint.actionWindow.legalActions.find(
        (action) =>
          action.type === "discard" &&
          action.tile === drawn &&
          (action.discardSource === "draw" ||
            action.discardSource === undefined)
      ) ??
      checkpoint.actionWindow.legalActions.find(
        (action) => action.type === "discard"
      );
    if (!safeDefault) {
      throw new Error("expected a safe discard default");
    }
    const beforeDiscards = match
      .replayFromBuffer(0, 0)
      .filter(({ event }) => event.type === "discard").length;
    const internals = match as unknown as {
      handleActDirect: (
        seat: 0 | 1 | 2 | 3,
        actionId: string
      ) => Promise<void>;
      automaticDefaultInFlight: boolean;
      automaticDefaultPromise: Promise<void> | null;
      automaticDefaultHandoffPromise: Promise<void> | null;
    };

    internals.automaticDefaultInFlight = true;
    internals.automaticDefaultPromise = new Promise<void>(() => undefined);
    internals.automaticDefaultHandoffPromise = gate.promise;
    let clientSettled = false;
    const clientAction = match.handleAct(seat, safeDefault.id).finally(() => {
      clientSettled = true;
    });
    await Promise.resolve();
    expect(clientSettled).toBe(false);

    await internals.handleActDirect(seat, safeDefault.id);
    gate.resolve();
    await clientAction;

    const afterDiscards = match
      .replayFromBuffer(0, 0)
      .filter(({ event }) => event.type === "discard").length;
    expect(afterDiscards).toBe(beforeDiscards + 1);
  });

  it("restores a disconnected action owner into its automatic deadline", async () => {
    const originalRuntime = controlledRuntime(46_000, 809);
    const match = new MatchProcess(
      "checkpoint-disconnected-action",
      323,
      oneHumanPlayers(),
      {
        repository: ephemeralMatchRepository,
        runtime: originalRuntime,
      }
    );
    setReadyCheckMs(0);
    setDelayAfterDiscardMs(0);
    await match.start();
    await match.handleAfk(0, true);
    const checkpoint = match.createCheckpoint();
    if (
      checkpoint.status !== "playing" ||
      checkpoint.checkpointKind !== "action_window"
    ) {
      throw new Error("expected a disconnected action checkpoint");
    }
    expect(checkpoint.actionWindow.seat).toBe(0);
    expect(checkpoint.connectionPolicy.disconnected[0]).toBe(true);

    const restoredRuntime = controlledRuntime(910_000, 810);
    const restored = MatchProcess.restoreCheckpoint(checkpoint, {
      repository: ephemeralMatchRepository,
      runtime: restoredRuntime,
    });
    expect(restoredRuntime.scheduledDelays().at(-1)).toBe(
      checkpoint.actionWindow.expiryRemainingMs
    );
    const beforeCount = checkpoint.eventLog.length;
    restoredRuntime.runNextTimer();
    await vi.waitFor(() => {
      expect(restored.replayFromBuffer(0, 0).length).toBeGreaterThan(
        beforeCount
      );
    });
  });

  it("restores network disconnect policy and clears it on reattach", async () => {
    const originalRuntime = controlledRuntime(46_000, 811);
    const match = new MatchProcess(
      "checkpoint-network-disconnect",
      33,
      humanPlayers(),
      {
        repository: ephemeralMatchRepository,
        runtime: originalRuntime,
      }
    );
    setReadyCheckMs(0);
    setDelayAfterDiscardMs(0);
    await match.start();
    const oldSocket = (): void => undefined;
    match.attachHuman(2, oldSocket);
    const internals = match as unknown as {
      livenessProbeMisses: [number, number, number, number];
    };
    internals.livenessProbeMisses[2] = 1;
    match.detachHuman(2, oldSocket);

    const checkpoint = match.createCheckpoint();
    if (checkpoint.status !== "playing") {
      throw new Error("expected a playing checkpoint");
    }
    expect(checkpoint.connectionPolicy.disconnected[2]).toBe(true);
    expect(checkpoint.connectionPolicy.afkSelfReported[2]).toBe(false);
    expect(checkpoint.connectionPolicy.livenessProbeMisses[2]).toBe(1);

    const restored = MatchProcess.restoreCheckpoint(checkpoint, {
      repository: ephemeralMatchRepository,
      runtime: controlledRuntime(810_000, 812),
    });
    const restoredBeforeAttach = restored.createCheckpoint();
    if (restoredBeforeAttach.status !== "playing") {
      throw new Error("expected a restored playing checkpoint");
    }
    expect(restoredBeforeAttach.connectionPolicy.disconnected[2]).toBe(true);
    expect(restoredBeforeAttach.connectionPolicy.livenessProbeMisses[2]).toBe(1);

    restored.attachHuman(2, () => undefined, async () => true);
    expect(restored.buildRoomState(2).seats[2].occupant).toMatchObject({
      kind: "human",
      connected: true,
    });
    const restoredAfterAttach = restored.createCheckpoint();
    if (restoredAfterAttach.status !== "playing") {
      throw new Error("expected an attached playing checkpoint");
    }
    expect(restoredAfterAttach.connectionPolicy.disconnected[2]).toBe(false);
    expect(restoredAfterAttach.connectionPolicy.livenessProbeMisses[2]).toBe(0);
  });

  it("atomically pauses while saving and restores from the repository", async () => {
    const storage = createMemoryMatchRepository();
    const gate = deferred();
    const capturedCheckpoints: MatchCheckpoint[] = [];
    const repository: MatchRepository = {
      ...storage,
      saveCheckpoint: async (args) => {
        capturedCheckpoints.push(args.checkpoint);
        await gate.promise;
        await storage.saveCheckpoint(args);
      },
    };
    const originalRuntime = controlledRuntime(50_000, 888);
    const match = new MatchProcess(
      "checkpoint-atomic-save",
      41,
      humanPlayers(),
      { repository, runtime: originalRuntime }
    );
    setReadyCheckMs(0);
    setDelayAfterDiscardMs(0);
    await match.start();
    originalRuntime.advance(1_000);
    const eventCount = match.replayFromBuffer(0, 0).length;

    const saving = match.pauseAndSaveCheckpoint();
    expect(match.pauseAndSaveCheckpoint()).toBe(saving);
    expect(match.isPaused).toBe(true);
    const captured = capturedCheckpoints[0];
    if (
      captured?.status !== "playing" ||
      captured.checkpointKind !== "action_window"
    ) {
      throw new Error("expected the repository to receive a playing checkpoint");
    }
    const discard = captured.actionWindow.legalActions.find(
      (action) => action.type === "discard"
    );
    if (!discard) {
      throw new Error("expected a legal discard");
    }
    await match.handleAct(captured.actionWindow.seat, discard.id);
    expect(match.replayFromBuffer(0, 0)).toHaveLength(eventCount);
    expect(() => originalRuntime.runNextTimer()).toThrow(/no active timer/);

    gate.resolve();
    const checkpoint = await saving;
    expect(await repository.loadCheckpoint(match.matchId)).toEqual(checkpoint);
    expect(match.isPaused).toBe(true);

    const restoredRuntime = controlledRuntime(800_000, 999);
    const restored = await MatchProcess.restoreSavedCheckpoint(match.matchId, {
      repository,
      runtime: restoredRuntime,
    });
    if (!restored) {
      throw new Error("expected a saved match");
    }
    expect(restored.isPaused).toBe(false);
    expect(comparableSnapshot(restored, 0, restoredRuntime)).toEqual(
      comparableSnapshot(match, 0, originalRuntime)
    );
    await match.deleteSavedCheckpoint();
    expect(await repository.loadCheckpoint(match.matchId)).toBeNull();
  });

  it("rolls back a failed save without consuming action time", async () => {
    const gate = deferred();
    const capturedCheckpoints: MatchCheckpoint[] = [];
    const storage = createMemoryMatchRepository();
    let failNextSave = true;
    const repository: MatchRepository = {
      ...storage,
      saveCheckpoint: async (args) => {
        const { checkpoint } = args;
        capturedCheckpoints.push(checkpoint);
        if (failNextSave) {
          failNextSave = false;
          await gate.promise;
          return;
        }
        await storage.saveCheckpoint(args);
      },
    };
    const runtime = controlledRuntime(60_000, 222);
    const match = new MatchProcess(
      "checkpoint-save-failure",
      51,
      humanPlayers(),
      { repository, runtime }
    );
    setReadyCheckMs(0);
    setDelayAfterDiscardMs(0);
    await match.start();
    runtime.advance(2_000);

    const saving = match.pauseAndSaveCheckpoint();
    const captured = capturedCheckpoints[0];
    if (
      captured?.status !== "playing" ||
      captured.checkpointKind !== "action_window"
    ) {
      throw new Error("expected a captured playing checkpoint");
    }
    runtime.advance(30_000);
    gate.reject(new Error("checkpoint write failed"));
    await expect(saving).rejects.toThrow("checkpoint write failed");

    expect(match.isPaused).toBe(false);
    expect(runtime.scheduledDelays().at(-1)).toBe(
      captured.actionWindow.expiryRemainingMs
    );
    expect(
      comparableSnapshot(match, captured.actionWindow.seat, runtime)
        .deadlineRemaining
    ).toBe(captured.actionWindow.visibleRemainingMs);

    const beforeCount = match.replayFromBuffer(0, 0).length;
    const discard = captured.actionWindow.legalActions.find(
      (action) => action.type === "discard"
    );
    if (!discard) {
      throw new Error("expected a legal discard");
    }
    await match.handleAct(captured.actionWindow.seat, discard.id);
    expect(match.replayFromBuffer(0, 0).length).toBeGreaterThan(beforeCount);
  });

  it("does not mutate until the pending action is durable", async () => {
    const storage = createMemoryMatchRepository();
    const gate = deferred();
    let captured: Parameters<MatchRepository["saveCommandTransaction"]>[0] | null =
      null;
    const repository: MatchRepository = {
      ...storage,
      saveCommandTransaction: async (args) => {
        captured = args;
        await gate.promise;
        await storage.saveCommandTransaction(args);
      },
    };
    const runtime = controlledRuntime(70_000, 223);
    const match = new MatchProcess(
      "checkpoint-command-write-ahead",
      52,
      humanPlayers(),
      { repository, runtime }
    );
    setReadyCheckMs(0);
    setDelayAfterDiscardMs(0);
    await match.start();
    const checkpoint = match.createCheckpoint();
    if (
      checkpoint.status !== "playing" ||
      checkpoint.checkpointKind !== "action_window"
    ) {
      throw new Error("expected an action checkpoint");
    }
    const discard = checkpoint.actionWindow.legalActions.find(
      (action) => action.type === "discard"
    );
    if (!discard) {
      throw new Error("expected a legal discard");
    }
    const beforeEvents = match.replayFromBuffer(0, 0);

    const acting = match.handleAct(checkpoint.actionWindow.seat, discard.id);
    await Promise.resolve();

    expect(captured).toMatchObject({
      matchId: match.matchId,
      checkpoint,
      command: {
        type: "act",
        seat: checkpoint.actionWindow.seat,
        actionId: discard.id,
      },
    });
    expect(match.isPaused).toBe(true);
    expect(match.replayFromBuffer(0, 0)).toEqual(beforeEvents);
    expect(() => runtime.runNextTimer()).toThrow(/no active timer/);
    let connectionWaitSettled = false;
    const connectionReady = match.waitUntilConnectionReady().then((ready) => {
      connectionWaitSettled = true;
      return ready;
    });
    await Promise.resolve();
    expect(connectionWaitSettled).toBe(false);

    gate.resolve();
    await acting;

    await expect(connectionReady).resolves.toBe(true);
    expect(
      match.claimSeat(
        `human-${checkpoint.actionWindow.seat}`,
        "Reconnected human"
      )
    ).toBe(checkpoint.actionWindow.seat);
    expect(match.isPaused).toBe(false);
    expect(match.replayFromBuffer(0, 0).length).toBeGreaterThan(
      beforeEvents.length
    );
    expect(await repository.loadRecoveryRecord(match.matchId)).toMatchObject({
      pendingCommand: null,
    });
  });

  it("replays a durable pending action after process loss", async () => {
    const repository = createMemoryMatchRepository();
    const originalRuntime = controlledRuntime(80_000, 224);
    const match = new MatchProcess(
      "checkpoint-command-replay",
      53,
      humanPlayers(),
      { repository, runtime: originalRuntime }
    );
    setReadyCheckMs(0);
    setDelayAfterDiscardMs(0);
    await match.start();
    const checkpoint = match.createCheckpoint();
    if (
      checkpoint.status !== "playing" ||
      checkpoint.checkpointKind !== "action_window"
    ) {
      throw new Error("expected an action checkpoint");
    }
    const discard = checkpoint.actionWindow.legalActions.find(
      (action) => action.type === "discard"
    );
    if (!discard) {
      throw new Error("expected a legal discard");
    }
    await repository.saveCommandTransaction({
      matchId: match.matchId,
      checkpoint,
      command: {
        type: "act",
        seat: checkpoint.actionWindow.seat,
        actionId: discard.id,
      },
    });

    const expectedRuntime = controlledRuntime(900_000, 225);
    const expected = MatchProcess.restoreCheckpoint(checkpoint, {
      repository: ephemeralMatchRepository,
      runtime: expectedRuntime,
    });
    await expected.handleAct(checkpoint.actionWindow.seat, discard.id);

    const restoredRuntime = controlledRuntime(900_000, 226);
    const restored = await MatchProcess.restoreSavedCheckpoint(match.matchId, {
      repository,
      runtime: restoredRuntime,
    });
    if (!restored) {
      throw new Error("expected a recovered match");
    }

    expect(restored.replayFromBuffer(0, 0)).toEqual(
      expected.replayFromBuffer(0, 0)
    );
    expect(comparableSnapshot(restored, 0, restoredRuntime)).toEqual(
      comparableSnapshot(expected, 0, expectedRuntime)
    );
    expect(await repository.loadRecoveryRecord(match.matchId)).toMatchObject({
      pendingCommand: null,
    });
  });

  it("stays paused until a failed command commit is retried", async () => {
    const storage = createMemoryMatchRepository();
    let commitAttempts = 0;
    const repository: MatchRepository = {
      ...storage,
      saveCheckpoint: async (args) => {
        commitAttempts += 1;
        if (commitAttempts === 1) {
          throw new Error("command commit failed");
        }
        await storage.saveCheckpoint(args);
      },
    };
    const runtime = controlledRuntime(90_000, 227);
    const match = new MatchProcess(
      "checkpoint-command-commit-retry",
      54,
      humanPlayers(),
      { repository, runtime }
    );
    setReadyCheckMs(0);
    setDelayAfterDiscardMs(0);
    await match.start();
    const checkpoint = match.createCheckpoint();
    if (
      checkpoint.status !== "playing" ||
      checkpoint.checkpointKind !== "action_window"
    ) {
      throw new Error("expected an action checkpoint");
    }
    const discard = checkpoint.actionWindow.legalActions.find(
      (action) => action.type === "discard"
    );
    if (!discard) {
      throw new Error("expected a legal discard");
    }
    const beforeCount = match.replayFromBuffer(0, 0).length;

    await expect(
      match.handleAct(checkpoint.actionWindow.seat, discard.id)
    ).rejects.toThrow("command commit failed");

    expect(match.isPaused).toBe(true);
    expect(match.hasPendingCommandCommit).toBe(true);
    expect(match.replayFromBuffer(0, 0).length).toBeGreaterThan(beforeCount);
    const pendingRecovery = await repository.loadRecoveryRecord(match.matchId);
    expect(pendingRecovery).toMatchObject({
      checkpoint: {
        matchId: checkpoint.matchId,
        status: "playing",
        checkpointKind: "action_window",
        nextSeq: checkpoint.nextSeq,
      },
      pendingCommand: {
        type: "act",
        seat: checkpoint.actionWindow.seat,
        actionId: discard.id,
      },
    });

    await expect(match.retryPendingCommandCommit()).resolves.toBe(true);
    expect(commitAttempts).toBe(2);
    expect(match.isPaused).toBe(false);
    expect(match.hasPendingCommandCommit).toBe(false);
    expect(await repository.loadRecoveryRecord(match.matchId)).toMatchObject({
      pendingCommand: null,
    });
    await expect(match.retryPendingCommandCommit()).resolves.toBe(false);
  });

  it("replaces a saved checkpoint with a terminal tombstone", async () => {
    const repository = createMemoryMatchRepository();
    const match = new MatchProcess(
      "checkpoint-terminal",
      71,
      humanPlayers(),
      { repository, runtime: controlledRuntime(120_000, 1701) }
    );
    setReadyCheckMs(0);
    setDelayAfterDiscardMs(0);
    await match.start();
    const checkpoint = match.createCheckpoint();
    await repository.saveCheckpoint({ matchId: match.matchId, checkpoint });
    const internals = match as unknown as {
      finalizeSession: (reason: "single_game") => Promise<void>;
    };

    await internals.finalizeSession("single_game");

    expect(match.status).toBe("finished");
    expect(match.hasPendingFinalization).toBe(false);
    expect(await repository.loadCheckpoint(match.matchId)).toBeNull();
    await expect(
      repository.saveCheckpoint({ matchId: match.matchId, checkpoint })
    ).rejects.toThrow(/terminal match/);
    const sessionEnds = match
      .replayFromBuffer(0, 0)
      .filter(({ event }) => event.type === "session_end");
    expect(sessionEnds).toHaveLength(1);
    await expect(match.retryPendingFinalization()).resolves.toBe(true);
    expect(
      match
        .replayFromBuffer(0, 0)
        .filter(({ event }) => event.type === "session_end")
    ).toHaveLength(1);
  });

  it("keeps finalization pending until a failed tombstone can be retried", async () => {
    const storage = createMemoryMatchRepository();
    let terminalAttempts = 0;
    const repository: MatchRepository = {
      ...storage,
      markCheckpointTerminal: async (args) => {
        terminalAttempts += 1;
        if (terminalAttempts === 1) {
          throw new Error("terminal write failed");
        }
        await storage.markCheckpointTerminal(args);
      },
    };
    const match = new MatchProcess(
      "checkpoint-terminal-retry",
      72,
      humanPlayers(),
      { repository, runtime: controlledRuntime(130_000, 1702) }
    );
    setReadyCheckMs(0);
    setDelayAfterDiscardMs(0);
    await match.start();
    const checkpoint = match.createCheckpoint();
    await repository.saveCheckpoint({ matchId: match.matchId, checkpoint });
    const internals = match as unknown as {
      finalizeSession: (reason: "single_game") => Promise<void>;
    };

    await expect(internals.finalizeSession("single_game")).rejects.toThrow(
      "terminal write failed"
    );

    expect(match.status).toBe("playing");
    expect(match.hasPendingFinalization).toBe(true);
    expect(await repository.loadCheckpoint(match.matchId)).toEqual(checkpoint);
    expect(
      match
        .replayFromBuffer(0, 0)
        .some(({ event }) => event.type === "session_end")
    ).toBe(false);

    await expect(match.retryPendingFinalization()).resolves.toBe(true);
    expect(terminalAttempts).toBe(2);
    expect(match.status).toBe("finished");
    expect(match.hasPendingFinalization).toBe(false);
    expect(await repository.loadCheckpoint(match.matchId)).toBeNull();
    expect(
      match
        .replayFromBuffer(0, 0)
        .filter(({ event }) => event.type === "session_end")
    ).toHaveLength(1);
    await expect(match.retryPendingFinalization()).resolves.toBe(true);
    expect(terminalAttempts).toBe(2);
  });

  it("rejects corrupted active sequence and phase state", async () => {
    const match = new MatchProcess(
      "checkpoint-corrupt",
      22,
      humanPlayers(),
      {
        repository: ephemeralMatchRepository,
        runtime: controlledRuntime(30_000, 456),
      }
    );
    setReadyCheckMs(0);
    setDelayAfterDiscardMs(0);
    await match.start();
    const checkpoint = match.createCheckpoint();
    if (
      checkpoint.status !== "playing" ||
      checkpoint.checkpointKind !== "action_window"
    ) {
      throw new Error("expected a playing checkpoint");
    }

    expect(() =>
      parseMatchCheckpoint({ ...checkpoint, nextSeq: checkpoint.nextSeq + 1 })
    ).toThrow(/Next sequence must equal/);
    expect(() =>
      parseMatchCheckpoint({
        ...checkpoint,
        state: { ...checkpoint.state, phase: "awaiting_draw" },
      })
    ).toThrow(/require awaiting_discard/);
    const disconnected = [...checkpoint.connectionPolicy.disconnected];
    disconnected[checkpoint.actionWindow.seat] = true;
    const disconnectedCheckpoint = parseMatchCheckpoint({
        ...checkpoint,
        connectionPolicy: {
          ...checkpoint.connectionPolicy,
          disconnected,
        },
      });
    expect(disconnectedCheckpoint).toMatchObject({
      checkpointKind: "action_window",
      connectionPolicy: { disconnected },
    });
  });

  it("rejects a call window attached to the wrong engine phase", async () => {
    const match = new MatchProcess(
      "checkpoint-unsafe",
      12,
      humanPlayers(),
      dependencies
    );
    setReadyCheckMs(0);
    setDelayAfterDiscardMs(0);
    await match.start();
    const internals = match as unknown as {
      callWindow: Array<unknown[] | null>;
    };
    internals.callWindow[1] = [];

    expect(() => match.createCheckpoint()).toThrow(
      /playing state is not quiescent \(engine phase awaiting_discard\)/
    );
  });
});