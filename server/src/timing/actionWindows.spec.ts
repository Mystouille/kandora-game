import { describe, expect, it, vi } from "vitest";
import type { LegalAction, Seat } from "~/game/protocol/messages";
import type { MatchRuntime } from "../runtime";
import { ActionWindowRegistry } from "./actionWindows";

function fixture() {
  let now = 1_000;
  let paused = false;
  const scheduled: Array<{
    callback: () => void;
    delayMs: number;
    cancel: ReturnType<typeof vi.fn>;
  }> = [];
  const expired = vi.fn<(seat: Seat) => void>();
  const runtime: MatchRuntime = {
    now: () => now,
    random: () => 0,
    captureRandomState: () => 0,
    restoreRandomState: () => undefined,
    sleep: async () => undefined,
    schedule: (callback, delayMs) => {
      const cancel = vi.fn();
      scheduled.push({ callback, delayMs, cancel });
      return { cancel };
    },
  };
  const windows = new ActionWindowRegistry(runtime, expired, () => paused);
  const actions: LegalAction[] = [
    {
      id: "discard:draw:1m",
      type: "discard",
      tile: "1m",
      discardSource: "draw",
    },
  ];
  const timing = {
    id: "match:0:1",
    clockEpoch: "epoch-1",
    timingVersion: 2 as const,
    kind: "turn" as const,
    infoSentAt: 1_000,
    opensAt: 1_300,
    baseEndsAt: 6_300,
    budgetEndsAt: 26_300,
    expiresAt: 26_500,
    bankAtOpenMs: 20_000,
    allowanceMs: 200,
  };
  return {
    windows,
    actions,
    timing,
    scheduled,
    expired,
    setNow: (value: number) => {
      now = value;
    },
    pause: () => {
      paused = true;
    },
  };
}

describe("ActionWindowRegistry", () => {
  it("owns an authoritative window and its expiry timer together", () => {
    const f = fixture();
    const opened = f.windows.openTimed(0, f.actions, f.timing);
    expect(opened).toMatchObject({
      kind: "turn",
      state: "scheduled",
      opensAt: 1_300,
      baseEndsAt: 6_300,
      expiresAt: 26_500,
    });
    expect(f.windows.view(0)).toMatchObject({
      kind: "turn",
      startedAt: 1_300,
      deadline: 6_300,
      timerPending: true,
    });
    expect(f.scheduled[0].delayMs).toBe(25_500);
  });

  it("fences cancelled callbacks even when the runtime still dispatches them", () => {
    const f = fixture();
    f.windows.openTimed(0, f.actions, f.timing);
    const old = f.scheduled[0];
    f.windows.clear(0);
    old.callback();
    expect(old.cancel).toHaveBeenCalledOnce();
    expect(f.expired).not.toHaveBeenCalled();
    expect(f.windows.view(0)).toMatchObject({
      kind: null,
      startedAt: null,
      deadline: null,
      timerPending: false,
    });
    expect(f.windows.legals(0)).toEqual([]);
  });

  it("keeps concurrent seats independent", () => {
    const f = fixture();
    f.windows.openTimed(1, [{ id: "pass", type: "pass" }], {
      ...f.timing,
      id: "match:1:1",
    });
    f.windows.openTimed(2, [{ id: "ron:0", type: "ron" }], {
      ...f.timing,
      id: "match:2:1",
    });
    f.windows.cancelTimer(1);
    f.scheduled[0].callback();
    f.scheduled[1].callback();
    expect(f.expired).toHaveBeenCalledExactlyOnceWith(2);
    expect(f.windows.legals(1)).toEqual([{ id: "pass", type: "pass" }]);
  });

  it("restores legal actions before the timing snapshot is installed", () => {
    const f = fixture();
    f.windows.restoreLegals(2, {
      kind: "turn",
      legalActions: f.actions,
    });
    expect(f.windows.legals(2)).toEqual(f.actions);
    expect(f.windows.view(2)).toMatchObject({
      kind: "turn",
      startedAt: null,
      deadline: null,
      timerPending: false,
    });
    expect(f.scheduled).toEqual([]);
  });

  it("does not expose writable legal-action storage", () => {
    const f = fixture();
    f.windows.openTimed(0, f.actions, f.timing);
    f.actions[0].id = "changed";
    const projection = f.windows.legals(0);
    projection[0].id = "changed-again";
    projection.push({ id: "pass", type: "pass" });
    expect(f.windows.legals(0)[0].id).toBe("discard:draw:1m");
    expect(f.windows.legals(0)).toHaveLength(1);
  });

  it("does not dispatch an expired window while paused", () => {
    const f = fixture();
    f.windows.openTimed(0, f.actions, f.timing);
    f.pause();
    f.setNow(f.timing.expiresAt);
    f.scheduled[0].callback();
    expect(f.expired).not.toHaveBeenCalled();
  });
});
