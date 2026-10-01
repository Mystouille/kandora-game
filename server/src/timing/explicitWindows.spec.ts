import { describe, expect, it } from "vitest";
import { createControlledRuntime } from "~/game/testing/timing/controlledRuntime";
import { ActionWindowRegistry } from "./actionWindows";
import { TimeBank } from "./timeBank";

function setup() {
  const runtime = createControlledRuntime(0);
  const expired: number[] = [];
  const windows = new ActionWindowRegistry(
    runtime,
    (seat) => expired.push(seat),
    () => false
  );
  const bank = new TimeBank(20_000);
  const timing = windows.openTimed(
    0,
    [
      {
        id: "discard:1m",
        type: "discard",
        tile: "1m",
      },
    ],
    {
      id: "window-1",
      clockEpoch: "epoch-1",
      timingVersion: 2,
      kind: "turn",
      infoSentAt: 500,
      opensAt: 1_000,
      baseEndsAt: 6_000,
      budgetEndsAt: 26_000,
      expiresAt: 26_200,
      bankAtOpenMs: 20_000,
      allowanceMs: 200,
    }
  );
  return { runtime, windows, bank, timing, expired };
}

describe("explicit authoritative windows", () => {
  it("retains a full base budget after the landed readiness point", async () => {
    const { runtime, windows } = setup();
    expect(windows.timedView(0)?.state).toBe("scheduled");
    expect(windows.view(0).deadline).toBe(6_000);
    await runtime.advanceBy(1_000);
    expect(windows.timedView(0)?.state).toBe("open");
    expect(windows.view(0).startedAt).toBe(1_000);
  });

  it.each([
    { receivedAt: 999, windowId: "window-1", clockEpoch: "epoch-1" },
    { receivedAt: 6_300, windowId: "old-window", clockEpoch: "epoch-1" },
    { receivedAt: 6_300, windowId: "window-1", clockEpoch: "old-epoch" },
    { receivedAt: 26_201, windowId: "window-1", clockEpoch: "epoch-1" },
  ])("rejects early, stale and expired receipts: %j", (receipt) => {
    const { windows } = setup();
    expect(() => windows.reserve(0, "discard:1m", receipt)).toThrow();
  });

  it("uses receipt time before queue delay and debits 100 ms once", async () => {
    const { runtime, windows, bank, expired } = setup();
    await runtime.advanceBy(6_300);
    windows.reserve(0, "discard:1m", {
      receivedAt: 6_300,
      windowId: "window-1",
      clockEpoch: "epoch-1",
    });
    await runtime.advanceBy(30_000);
    windows.consumeTimedBuffer(0, bank);
    windows.consumeTimedBuffer(0, bank);
    expect(bank.balance(0)).toBe(19_900);
    expect(expired).toEqual([]);
  });

  it("does not replenish a restored window's bank or allowance", async () => {
    const { runtime, windows, timing } = setup();
    await runtime.advanceBy(500);
    windows.restoreTimed(0, windows.legals(0), timing, 0, "epoch-2");
    const restored = windows.timedView(0);
    expect(restored?.id).toBe(timing.id);
    expect(restored?.bankAtOpenMs).toBe(20_000);
    expect(restored?.allowanceMs).toBe(200);
    expect(restored?.expiresAt).toBe(26_700);
    expect(restored?.clockEpoch).toBe("epoch-2");
  });
});
