import { afterEach, describe, expect, it, vi } from "vitest";
import { createPRNG, type MatchState } from "~/game/rules";
import { getPreset, presetToRuleSet } from "~/game/rules/presets";
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
    match.handleReady(0);
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
      match.handleReady(seat);
      restored.handleReady(seat);
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
    match.handleReady(0);
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
      match.handleReady(seat);
      restored.handleReady(seat);
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

  it("rearms a ready continuation after checkpoint save failure", async () => {
    const gate = deferred();
    const capturedCheckpoints: MatchCheckpoint[] = [];
    const repository: MatchRepository = {
      ...createMemoryMatchRepository(),
      saveCheckpoint: async ({ checkpoint }) => {
        capturedCheckpoints.push(checkpoint);
        await gate.promise;
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
    match.handleReady(0);
    expect(match.createCheckpoint()).toEqual(captured);
    expect(() => runtime.runNextTimer()).toThrow(/no active timer/);
    runtime.advance(30_000);
    gate.reject(new Error("ready checkpoint write failed"));
    await expect(saving).rejects.toThrow("ready checkpoint write failed");

    expect(match.isPaused).toBe(false);
    expect(runtime.scheduledDelays().at(-1)).toBe(captured.readyRemainingMs);
    for (const seat of [0, 1, 2, 3] as const) {
      match.handleReady(seat);
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
    const repository: MatchRepository = {
      ...createMemoryMatchRepository(),
      saveCheckpoint: async ({ checkpoint }) => {
        capturedCheckpoints.push(checkpoint);
        await gate.promise;
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