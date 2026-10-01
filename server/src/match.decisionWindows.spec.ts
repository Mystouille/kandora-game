import { afterEach, describe, expect, it } from "vitest";
import { MatchProcess, setReadyCheckMs } from "./match";
import { ephemeralMatchRepository } from "./repository";
import type { MatchRuntime } from "./runtime";

function setup(epoch = "timing-test-epoch", initialNow = 1_000) {
  let now = initialNow;
  const runtime: MatchRuntime = {
    clockEpoch: epoch,
    now: () => now,
    random: () => 0.5,
    captureRandomState: () => 0,
    restoreRandomState: () => undefined,
    schedule: () => ({ cancel: () => undefined }),
    sleep: async (delayMs) => {
      now += delayMs;
    },
  };
  const dependencies = {
    repository: ephemeralMatchRepository,
    runtime,
    timingMode: "windows-v2" as const,
  };
  const match = new MatchProcess(
    "fair-window",
    42,
    [0, 1, 2, 3].map((seat) => ({
      userId: `human-${seat}`,
      displayName: `Human ${seat}`,
      isBot: false,
    })),
    dependencies
  );
  for (const seat of [0, 1, 2, 3] as const) {
    match.configurePlayerTiming(seat, "direct", () => null);
  }
  return {
    match,
    dependencies,
    advanceTo: (at: number) => {
      now = at;
    },
  };
}

describe("integrated authoritative decisions", () => {
  afterEach(() => setReadyCheckMs(5_000));

  it("starts the human base budget at draw landing, not raw draw emission", async () => {
    setReadyCheckMs(0);
    const { match } = setup();
    await match.start();
    const frame = match.buildSnapshotForSeat(0);
    expect(frame.actionWindow?.opensAt).toBe(1_800);
    expect(frame.actionWindow?.baseEndsAt).toBe(6_800);
    expect(frame.actionWindow?.allowanceMs).toBe(0);
    expect(frame.clock).toEqual({
      clockEpoch: "timing-test-epoch",
      serverNow: 1_500,
    });
    expect(frame.presentation?.events[0]).toMatchObject({
      kind: "draw",
      startsAt: 1_500,
      readyAt: 1_800,
    });
  });

  it("rejects premature input and charges exact overage from the captured receipt", async () => {
    setReadyCheckMs(0);
    const { match, advanceTo } = setup();
    await match.start();
    const initial = match.buildSnapshotForSeat(0);
    const action = initial.legalActions.find(
      (legal) => legal.type === "discard"
    );
    if (!action || !initial.actionWindow) {
      throw new Error("Expected an active human discard window");
    }
    await expect(
      match.handleAct(0, action.id, match.actionReceipt(0, 1_799))
    ).rejects.toThrow(/not open/);
    const receivedAt = initial.actionWindow.baseEndsAt + 100;
    const receipt = match.actionReceipt(0, receivedAt);
    advanceTo(receivedAt + 2_000);
    await match.handleAct(0, action.id, receipt);
    expect(match.buildSnapshotForSeat(0).bufferMs).toBe(19_900);
  });

  it("preserves the outstanding identity and remaining budget across restore", async () => {
    setReadyCheckMs(0);
    const { match, dependencies, advanceTo } = setup();
    await match.start();
    advanceTo(2_000);
    const checkpoint = match.createCheckpoint();
    expect(checkpoint.decisionTiming?.mode).toBe("windows-v2");
    const before = match.buildSnapshotForSeat(0).actionWindow;
    const restored = MatchProcess.restoreCheckpoint(
      JSON.parse(JSON.stringify(checkpoint)),
      dependencies
    );
    const after = restored.buildSnapshotForSeat(0).actionWindow;
    expect(after?.id).toBe(before?.id);
    expect(after?.baseEndsAt).toBe(before?.baseEndsAt);
    expect(after?.bankAtOpenMs).toBe(before?.bankAtOpenMs);
    expect(after?.allowanceMs).toBe(before?.allowanceMs);
  });
});
