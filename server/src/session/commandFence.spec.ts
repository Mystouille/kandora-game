import { describe, expect, it, vi } from "vitest";
import { CommandCoordinator } from "./commandCoordinator";
import { ActionWindowRegistry } from "../timing/actionWindows";
import { createControlledRuntime } from "~/game/testing/timing/controlledRuntime";

describe("queued input owner fences", () => {
  it("rejects a retired owner after a queue wait without poisoning authority", async () => {
    const runtime = createControlledRuntime();
    const windows = new ActionWindowRegistry(
      runtime,
      () => undefined,
      () => false
    );
    let release!: () => void;
    const holding = new Promise<void>((resolve) => {
      release = resolve;
    });
    const execute = vi.fn<() => Promise<void>>(async () => undefined);
    execute.mockImplementationOnce(async () => holding);
    let ownerCurrent = true;
    const stale = vi.fn();
    const commands = new CommandCoordinator(windows, {
      sequence: () => 0,
      status: () => "playing",
      isPaused: () => false,
      pendingCheckpointSave: () => null,
      accept: () => true,
      execute,
      afkDefaultAction: () => null,
      persistRecovery: async () => undefined,
    });
    const first = commands.handleAct(1, "first");
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    const oldOwner = commands.handleAct(0, "old-owner", {
      current: () => ownerCurrent,
      onStale: stale,
    });
    ownerCurrent = false;
    release();
    await first;
    await expect(oldOwner).rejects.toThrow(/replaced owner/);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(stale).toHaveBeenCalledOnce();
    expect(commands.recoveryRequired).toBe(false);
  });
});
