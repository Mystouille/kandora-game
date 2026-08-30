import { afterEach, describe, expect, it, vi } from "vitest";
import type { GameEvent } from "~/game/protocol/messages";
import {
  MatchProcess,
  setDelayAfterDiscardMs,
  setReadyCheckMs,
} from "./match";
import {
  ephemeralMatchRepository,
  type MatchEventJournalStore,
} from "./repository";
import type { MatchRuntime } from "./runtime";

describe("MatchProcess runtime", () => {
  afterEach(() => {
    setReadyCheckMs(5_000);
    setDelayAfterDiscardMs(350);
  });

  it("uses injected randomness for authoritative dice rolls", async () => {
    const randomValues = [0, 0.999];
    const runtime: MatchRuntime = {
      now: () => 1_000,
      random: () => randomValues.shift() ?? 0,
      captureRandomState: () => randomValues.length,
      restoreRandomState: () => undefined,
      schedule: () => ({ cancel: () => undefined }),
      sleep: async () => undefined,
    };
    const match = new MatchProcess(
      "runtime-dice",
      42,
      [0, 1, 2, 3].map((seat) => ({
        userId: `human-${seat}`,
        displayName: `Human ${seat}`,
        isBot: false,
      })),
      { repository: ephemeralMatchRepository, runtime },
      undefined,
      undefined,
      "tenhou-hanchan"
    );
    setReadyCheckMs(0);

    await match.start();

    const handStart = match
      .replayFromBuffer(0)
      .map(({ event }) => event)
      .find(
        (event): event is Extract<GameEvent, { type: "hand_start" }> =>
          event.type === "hand_start"
      );
    expect(handStart?.dice).toEqual([1, 6]);
  });

  it("does not await an in-flight event journal append", async () => {
    let releaseWrite!: () => void;
    const heldWrite = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const appendMatchEvents = vi.fn(async () => {
      await heldWrite;
    });
    const eventJournalStore: MatchEventJournalStore = {
      appendMatchEvents,
      loadMatchEventJournalState: async () => null,
    };
    const match = new MatchProcess(
      "runtime-journal",
      43,
      [0, 1, 2, 3].map((seat) => ({
        userId: `human-${seat}`,
        displayName: `Human ${seat}`,
        isBot: false,
      })),
      {
        repository: ephemeralMatchRepository,
        eventJournalStore,
      },
      undefined,
      undefined,
      "tenhou-hanchan"
    );
    setReadyCheckMs(0);

    await match.start();

    expect(appendMatchEvents).toHaveBeenCalledTimes(1);
    expect(match.replayFromBuffer(0).length).toBeGreaterThan(1);
    releaseWrite();
  });

  it("flushes the event journal before saving an explicit checkpoint", async () => {
    let releaseWrite!: () => void;
    const heldWrite = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const eventJournalStore: MatchEventJournalStore = {
      appendMatchEvents: async () => {
        await heldWrite;
      },
      loadMatchEventJournalState: async () => null,
    };
    const saveCheckpoint = vi.fn(async () => undefined);
    const match = new MatchProcess(
      "runtime-journal-pause",
      45,
      [0, 1, 2, 3].map((seat) => ({
        userId: `human-${seat}`,
        displayName: `Human ${seat}`,
        isBot: false,
      })),
      {
        repository: { ...ephemeralMatchRepository, saveCheckpoint },
        eventJournalStore,
      },
      undefined,
      undefined,
      "tenhou-hanchan"
    );
    setReadyCheckMs(0);
    await match.start();

    const pausing = match.pauseAndSaveCheckpoint();
    await Promise.resolve();
    expect(saveCheckpoint).not.toHaveBeenCalled();

    releaseWrite();
    await pausing;
    expect(saveCheckpoint).toHaveBeenCalledTimes(1);
    expect(match.isPaused).toBe(true);
  });

  it("waits for active command execution before creating a checkpoint", async () => {
    const savedCheckpoints: Array<
      ReturnType<MatchProcess["createCheckpoint"]>
    > = [];
    const match = new MatchProcess(
      "runtime-command-pause",
      46,
      [0, 1, 2, 3].map((seat) => ({
        userId: `human-${seat}`,
        displayName: `Human ${seat}`,
        isBot: false,
      })),
      {
        repository: {
          ...ephemeralMatchRepository,
          saveCheckpoint: async ({ checkpoint }) => {
            savedCheckpoints.push(checkpoint);
          },
        },
      },
      undefined,
      undefined,
      "tenhou-hanchan"
    );
    setReadyCheckMs(0);
    setDelayAfterDiscardMs(0);
    await match.start();
    const before = match.createCheckpoint();
    if (
      before.status !== "playing" ||
      before.checkpointKind !== "action_window"
    ) {
      throw new Error("expected an action window");
    }
    const discard = before.actionWindow.legalActions.find(
      (action) => action.type === "discard"
    );
    if (discard === undefined) {
      throw new Error("expected a discard action");
    }
    let releaseCommand!: () => void;
    const commandGate = new Promise<void>((resolve) => {
      releaseCommand = resolve;
    });
    const internals = match as unknown as {
      handleActDirect(seat: 0 | 1 | 2 | 3, actionId: string): Promise<void>;
    };
    const handleActDirect = internals.handleActDirect.bind(match);
    let commandExecutions = 0;
    internals.handleActDirect = async (seat, actionId) => {
      commandExecutions += 1;
      await commandGate;
      await handleActDirect(seat, actionId);
    };

    const acting = match.handleAct(before.actionWindow.seat, discard.id);
    await vi.waitFor(() => {
      expect(commandExecutions).toBe(1);
    });
    const pausing = match.pauseAndSaveCheckpoint();
    await Promise.resolve();
    expect(savedCheckpoints).toHaveLength(0);
    await match.handleAct(before.actionWindow.seat, discard.id);
    expect(commandExecutions).toBe(1);

    releaseCommand();
    await acting;
    await pausing;
    expect(savedCheckpoints).toHaveLength(1);
    const savedCheckpoint = savedCheckpoints[0];
    if (savedCheckpoint.status !== "playing") {
      throw new Error("expected a playing checkpoint");
    }
    expect(savedCheckpoint.nextSeq).toBeGreaterThan(before.nextSeq);
    expect(match.isPaused).toBe(true);
  });

  it("does not call checkpoint storage for an accepted command", async () => {
    const saveCheckpoint = vi.fn(async () => {
      throw new Error("checkpoint storage must not be on the command path");
    });
    const saveCommandTransaction = vi.fn(async () => {
      throw new Error("command storage must not be on the command path");
    });
    const match = new MatchProcess(
      "runtime-command-storage",
      44,
      [0, 1, 2, 3].map((seat) => ({
        userId: `human-${seat}`,
        displayName: `Human ${seat}`,
        isBot: false,
      })),
      {
        repository: {
          ...ephemeralMatchRepository,
          saveCheckpoint,
          saveCommandTransaction,
        },
      },
      undefined,
      undefined,
      "tenhou-hanchan"
    );
    setReadyCheckMs(0);
    setDelayAfterDiscardMs(0);
    await match.start();
    const checkpoint = match.createCheckpoint();
    if (
      checkpoint.status !== "playing" ||
      checkpoint.checkpointKind !== "action_window"
    ) {
      throw new Error("expected an action window");
    }
    const discard = checkpoint.actionWindow.legalActions.find(
      (action) => action.type === "discard"
    );
    if (discard === undefined) {
      throw new Error("expected a discard action");
    }
    const beforeEvents = match.replayFromBuffer(0).length;

    await match.handleAct(checkpoint.actionWindow.seat, discard.id);

    expect(match.replayFromBuffer(0).length).toBeGreaterThan(beforeEvents);
    expect(saveCommandTransaction).not.toHaveBeenCalled();
    expect(saveCheckpoint).not.toHaveBeenCalled();
    expect(match.isPaused).toBe(false);
  });
});