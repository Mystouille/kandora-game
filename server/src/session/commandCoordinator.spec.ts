import { describe, expect, it, vi } from "vitest";
import type { MatchCheckpoint } from "../checkpoint";
import type { PendingMatchCommand } from "../repository";
import type { MatchRuntime } from "../runtime";
import { ActionWindowRegistry } from "../timing/actionWindows";
import {
  CommandCoordinator,
  type CommandExecutionPort,
} from "./commandCoordinator";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

function fixture() {
  let seq = 0;
  let paused = false;
  let checkpointSave: Promise<MatchCheckpoint> | null = null;
  const execute = vi.fn<(command: PendingMatchCommand) => Promise<void>>(
    async () => undefined
  );
  const accept = vi.fn<(command: PendingMatchCommand) => boolean>(() => true);
  const persistRecovery = vi.fn(async () => undefined);
  const runtime: MatchRuntime = {
    now: () => 0,
    random: () => 0,
    captureRandomState: () => 0,
    restoreRandomState: () => undefined,
    sleep: async () => undefined,
    schedule: () => ({ cancel: () => undefined }),
  };
  const windows = new ActionWindowRegistry(
    runtime,
    () => undefined,
    () => paused
  );
  const port: CommandExecutionPort = {
    sequence: () => seq,
    status: () => "playing",
    isPaused: () => paused || coordinator.recoveryRequired,
    pendingCheckpointSave: () => checkpointSave,
    accept,
    execute,
    afkDefaultAction: () => "discard:draw:1m",
    persistRecovery,
  };
  const coordinator = new CommandCoordinator(windows, port);
  return {
    coordinator,
    windows,
    execute,
    accept,
    persistRecovery,
    advanceSequence: () => {
      seq += 1;
    },
    pause: () => {
      paused = true;
    },
    startCheckpointSave: () => {
      checkpointSave = new Promise(() => undefined);
    },
  };
}

describe("legacy CommandCoordinator", () => {
  it("retains a reserved explicit window when another seat advances the global sequence", async () => {
    const f = fixture();
    f.windows.openTimed(1, [{ id: "second", type: "pass" }], {
      id: "call-window-1",
      clockEpoch: "epoch-1",
      timingVersion: 2,
      kind: "call",
      infoSentAt: 0,
      opensAt: 0,
      baseEndsAt: 5_000,
      budgetEndsAt: 25_000,
      expiresAt: 25_200,
      bankAtOpenMs: 20_000,
      allowanceMs: 200,
    });
    const gate = deferred();
    f.execute.mockImplementationOnce(async () => gate.promise);
    const first = f.coordinator.handleAct(0, "first");
    await vi.waitFor(() => expect(f.execute).toHaveBeenCalledTimes(1));
    const second = f.coordinator.handleAct(1, "second");
    f.advanceSequence();
    gate.resolve();
    await Promise.all([first, second]);
    expect(
      f.execute.mock.calls.map(([command]) =>
        command.type === "act" ? command.actionId : command.type
      )
    ).toEqual(["first", "second"]);
  });

  it("serializes live actions and revalidates their legality after the wait", async () => {
    const f = fixture();
    const gate = deferred();
    f.execute.mockImplementationOnce(async () => gate.promise);
    const first = f.coordinator.handleAct(0, "first");
    await vi.waitFor(() => {
      expect(f.execute).toHaveBeenCalledTimes(1);
    });
    const second = f.coordinator.handleAct(1, "second");
    expect(f.execute).toHaveBeenCalledTimes(1);
    gate.resolve();
    await Promise.all([first, second]);
    expect(f.execute.mock.calls.map(([command]) => command)).toEqual([
      { type: "act", seat: 0, actionId: "first" },
      { type: "act", seat: 1, actionId: "second" },
    ]);
  });

  it("drops an action received against an earlier sequence instead of replaying it", async () => {
    const f = fixture();
    const gate = deferred();
    f.execute.mockImplementationOnce(async () => gate.promise);
    const first = f.coordinator.handleAct(0, "first");
    await vi.waitFor(() => {
      expect(f.execute).toHaveBeenCalledTimes(1);
    });
    const stale = f.coordinator.handleAct(1, "stale");
    f.advanceSequence();
    gate.resolve();
    await Promise.all([first, stale]);
    expect(f.execute).toHaveBeenCalledTimes(1);
  });

  it("lets a ready acknowledgement cross an open-input handoff without deadlocking", async () => {
    const f = fixture();
    const ready = deferred();
    f.execute.mockImplementation(async (command) => {
      if (command.type === "act") {
        await f.coordinator.commitOpenInputBoundary();
        await ready.promise;
      } else if (command.type === "ready") {
        ready.resolve();
      }
    });
    const acting = f.coordinator.handleAct(0, "first");
    await vi.waitFor(() => {
      expect(f.coordinator.transaction).toBeNull();
      expect(f.execute).toHaveBeenCalledTimes(1);
    });
    await f.coordinator.handleReady(0);
    await acting;
    expect(f.persistRecovery).toHaveBeenCalledOnce();
  });

  it("does not replay a stale ready acknowledgement after a command advances", async () => {
    const f = fixture();
    const gate = deferred();
    f.execute.mockImplementationOnce(async () => gate.promise);
    const acting = f.coordinator.handleAct(0, "first");
    await vi.waitFor(() => {
      expect(f.execute).toHaveBeenCalledTimes(1);
    });
    const ready = f.coordinator.handleReady(0);
    f.advanceSequence();
    gate.resolve();
    await Promise.all([acting, ready]);
    expect(f.execute).toHaveBeenCalledTimes(1);
  });

  it("retains AFK and vote retries across sequence changes", async () => {
    const f = fixture();
    const gate = deferred();
    f.execute.mockImplementationOnce(async () => gate.promise);
    const acting = f.coordinator.handleAct(0, "first");
    await vi.waitFor(() => {
      expect(f.execute).toHaveBeenCalledTimes(1);
    });
    const afk = f.coordinator.handleAfk(1, true);
    const vote = f.coordinator.handleVoteContinue(2, "yes");
    f.advanceSequence();
    gate.resolve();
    await Promise.all([acting, afk, vote]);
    expect(f.execute.mock.calls.map(([command]) => command.type)).toEqual([
      "act",
      "afk",
      "vote_continue",
    ]);
  });

  it("serializes commands behind automatic defaults and releases their handoff", async () => {
    const f = fixture();
    const gate = deferred();
    const automatic = f.coordinator.runAutomaticDefault(
      async () => gate.promise
    );
    expect(f.coordinator.automaticInFlight).toBe(true);
    const acting = f.coordinator.handleAct(0, "first");
    expect(f.execute).not.toHaveBeenCalled();
    gate.resolve();
    await Promise.all([automatic, acting]);
    expect(f.execute).toHaveBeenCalledOnce();
    expect(f.coordinator.automatic).toBeNull();
    expect(f.coordinator.automaticInFlight).toBe(false);
  });

  it("blocks mutation while a checkpoint save or pause is active", async () => {
    const saving = fixture();
    saving.startCheckpointSave();
    await saving.coordinator.handleAct(0, "first");
    const paused = fixture();
    paused.pause();
    await paused.coordinator.handleReady(0);
    expect(saving.execute).not.toHaveBeenCalled();
    expect(paused.execute).not.toHaveBeenCalled();
  });

  it("surfaces execution failures and leaves recovery-only authority", async () => {
    const f = fixture();
    const failure = new Error("durable command failed");
    f.execute.mockRejectedValueOnce(failure);
    await expect(f.coordinator.handleAct(0, "first")).rejects.toThrow(
      "MatchProcess: durable command failed"
    );
    expect(f.coordinator.recoveryRequired).toBe(true);
    expect(f.coordinator.recoveryError?.cause).toBe(failure);
    await f.coordinator.handleAct(0, "retry");
    expect(f.execute).toHaveBeenCalledOnce();
  });

  it("revalidates commands at execution and rejects a now-illegal action explicitly", async () => {
    const f = fixture();
    f.accept.mockReturnValueOnce(true).mockReturnValueOnce(false);
    await expect(f.coordinator.handleAct(0, "first")).rejects.toThrow(
      "pending action first is no longer legal for seat 0"
    );
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.coordinator.recoveryRequired).toBe(true);
  });

  it("replays a saved legacy command through the same owner and persistence barrier", async () => {
    const f = fixture();
    await f.coordinator.restorePendingCommand({
      type: "afk",
      seat: 0,
      afk: true,
      defaultActionId: "discard:draw:1m",
    });
    expect(f.execute).toHaveBeenCalledOnce();
    expect(f.persistRecovery).toHaveBeenCalledOnce();
    expect(f.coordinator.transaction).toBeNull();
  });
});
