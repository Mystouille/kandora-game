import { describe, expect, it } from "vitest";
import { createControlledRuntime } from "~/game/testing/timing/controlledRuntime";
import { PromptWindows } from "./promptWindows";

function fixture(initialNow = 1_000, epoch = "epoch-1") {
  const runtime = createControlledRuntime(initialNow);
  const prompts = new PromptWindows("match-1", epoch, runtime, () => ({
    network: "remote",
    profile: null,
  }));
  return { runtime, prompts };
}

describe("authoritative fixed prompts", () => {
  it("issues independent fixed ready windows with no bank and one frozen allowance", () => {
    const { prompts } = fixture();
    prompts.open("ready", [0, 2], 5_000);
    expect(prompts.view(0)).toMatchObject({
      kind: "ready",
      opensAt: 1_000,
      baseEndsAt: 6_000,
      budgetEndsAt: 6_000,
      expiresAt: 6_200,
      bankAtOpenMs: 0,
      allowanceMs: 200,
      legalActionIds: ["ready"],
    });
    expect(prompts.view(1)).toBeNull();
    expect(prompts.view(2)?.id).not.toBe(prompts.view(0)?.id);
    expect(prompts.deadline("ready")).toBe(6_200);
  });

  it("reserves a timely acknowledgement before a delayed command can expire it", async () => {
    const { runtime, prompts } = fixture();
    prompts.open("ready", [0, 1], 5_000);
    const window = prompts.view(0);
    if (!window) {
      throw new Error("Expected ready window");
    }
    prompts.reserve(0, "ready", {
      receivedAt: 6_199,
      windowId: window.id,
      clockEpoch: window.clockEpoch,
    });
    await runtime.advanceBy(10_000);
    expect(prompts.hasReserved("ready")).toBe(true);
    prompts.resolve(0);
    expect(prompts.hasReserved("ready")).toBe(false);
    expect(prompts.deadline("ready")).toBe(6_200);
    expect(() =>
      prompts.reserve(1, "ready", {
        receivedAt: 6_201,
        windowId: prompts.view(1)?.id,
        clockEpoch: "epoch-1",
      })
    ).toThrow(/expired/);
  });

  it("supports vote replacement without minting a new window or deadline", () => {
    const { prompts } = fixture();
    prompts.open("session_vote", [0, 1], 10_000);
    const window = prompts.view(0);
    if (!window) {
      throw new Error("Expected vote window");
    }
    prompts.reserve(0, "yes", {
      receivedAt: 2_000,
      windowId: window.id,
      clockEpoch: "epoch-1",
    });
    prompts.releaseVote(0);
    prompts.reserve(0, "no", {
      receivedAt: 2_500,
      windowId: window.id,
      clockEpoch: "epoch-1",
    });
    expect(prompts.view(0)?.id).toBe(window.id);
    expect(prompts.view(0)?.expiresAt).toBe(window.expiresAt);
  });

  it("restores remaining time into a new clock epoch without resetting the budget", async () => {
    const original = fixture();
    original.prompts.open("ready", [0, 1], 5_000);
    await original.runtime.advanceBy(2_000);
    original.prompts.resolve(0);
    const saved = original.prompts.capture();
    const restored = fixture(50_000, "epoch-2");
    restored.prompts.restore(saved, original.runtime.now());
    expect(restored.prompts.view(0)?.state).toBe("resolved");
    expect(restored.prompts.view(1)).toMatchObject({
      id: saved.windows[1]?.id,
      clockEpoch: "epoch-2",
      baseEndsAt: 53_000,
      expiresAt: 53_200,
      allowanceMs: 200,
    });
  });

  it("does not allow a client reply or repeated snapshot to extend a prompt", () => {
    const { prompts } = fixture();
    prompts.open("ready", [0], 5_000);
    const before = prompts.view(0);
    expect(prompts.view(0)).toEqual(before);
    expect(() =>
      prompts.reserve(0, "ready", {
        receivedAt: 1_500,
        windowId: "stale",
        clockEpoch: "epoch-1",
      })
    ).toThrow(/Stale/);
    expect(prompts.view(0)?.expiresAt).toBe(before?.expiresAt);
    prompts.clear("ready");
    expect(() =>
      prompts.reserve(0, "ready", {
        receivedAt: 1_500,
        windowId: before?.id,
        clockEpoch: "epoch-1",
      })
    ).toThrow();
  });

  it("migrates only known remaining legacy prompt time without issuing a new allowance", () => {
    const { prompts } = fixture(50_000, "epoch-2");
    prompts.restoreLegacy("ready", [1], 2_000);
    expect(prompts.view(1)).toMatchObject({
      opensAt: 50_000,
      baseEndsAt: 52_000,
      expiresAt: 52_000,
      allowanceMs: 0,
      bankAtOpenMs: 0,
    });
    prompts.restoreLegacy("session_vote", [1], 0);
    expect(prompts.deadline("session_vote")).toBe(50_000);
  });

  it("does not release another owner's equal-millisecond reservation", () => {
    const { prompts } = fixture();
    prompts.open("ready", [0], 5_000);
    const receipt = {
      receivedAt: 1_000,
      windowId: prompts.view(0)?.id,
      clockEpoch: "epoch-1",
      ownerGeneration: 2,
    };
    prompts.reserve(0, "ready", receipt);
    expect(() =>
      prompts.reserve(0, "ready", { ...receipt, ownerGeneration: 1 })
    ).toThrow(/pending/);
    prompts.releaseReservation(0, { ...receipt, ownerGeneration: 1 });
    expect(prompts.hasReserved("ready")).toBe(true);
    prompts.releaseReservation(0, receipt);
    expect(prompts.hasReserved("ready")).toBe(false);
  });
});
