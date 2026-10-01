import { describe, expect, it, vi } from "vitest";
import type { LegalAction, Seat } from "~/game/protocol/messages";
import type { MatchRuntime } from "../runtime";
import { ActionWindowRegistry } from "./actionWindows";
import { TimeBank } from "./timeBank";

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
  const policy = {
    baseMs: 5_000,
    graceMs: 200,
    declarationMs: 5_000,
    automatedMs: 700,
  };
  const actions: LegalAction[] = [
    {
      id: "discard:draw:1m",
      type: "discard",
      tile: "1m",
      discardSource: "draw",
    },
  ];
  return {
    windows,
    policy,
    actions,
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

describe("legacy ActionWindowRegistry", () => {
  it("owns the visible base deadline and the bank-plus-grace timer together", () => {
    const f = fixture();
    f.windows.open(0, f.actions, "turn", f.policy, 20_000, false);
    expect(f.windows.view(0)).toMatchObject({
      kind: "turn",
      startedAt: 1_000,
      deadline: 6_000,
      timerPending: true,
    });
    expect(f.scheduled[0].delayMs).toBe(25_200);
  });

  it("fences cancelled callbacks even when the runtime still dispatches them", () => {
    const f = fixture();
    f.windows.open(0, f.actions, "turn", f.policy, 20_000, false);
    const old = f.scheduled[0];
    f.windows.open(0, [], "turn", f.policy, 20_000, false);
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
    f.windows.open(
      1,
      [{ id: "pass", type: "pass" }],
      "turn",
      f.policy,
      0,
      false
    );
    f.windows.open(
      2,
      [{ id: "ron:0", type: "ron" }],
      "turn",
      f.policy,
      0,
      false
    );
    f.windows.cancelTimer(1);
    f.scheduled[0].callback();
    f.scheduled[1].callback();
    expect(f.expired).toHaveBeenCalledExactlyOnceWith(2);
    expect(f.windows.legals(1)).toEqual([{ id: "pass", type: "pass" }]);
  });

  it("keeps disconnected cadence and fixed declarations separate from bank policy", () => {
    const f = fixture();
    f.windows.open(0, f.actions, "turn", f.policy, 20_000, true);
    f.windows.open(
      1,
      [{ id: "declare:tenpai", type: "declare_tenpai" }],
      "ryuukyoku_declaration",
      f.policy,
      20_000,
      true
    );
    expect(f.scheduled.map((timer) => timer.delayMs)).toEqual([700, 5_000]);
    const bank = new TimeBank(20_000);
    f.setNow(9_000);
    f.windows.consumeLegacyBuffer(1, bank, f.policy);
    expect(bank.balance(1)).toBe(20_000);
    expect(f.windows.view(1).startedAt).toBeNull();
  });

  it("retains legal actions without scheduling when the legacy base is disabled", () => {
    const f = fixture();
    f.windows.open(0, f.actions, "turn", { ...f.policy, baseMs: 0 }, 0, false);
    expect(f.windows.legals(0)).toEqual(f.actions);
    expect(f.windows.view(0)).toMatchObject({
      kind: "turn",
      startedAt: null,
      deadline: null,
      timerPending: false,
    });
    expect(f.scheduled).toEqual([]);
  });

  it("consumes a window at most once while preserving legacy rounding", () => {
    const f = fixture();
    const bank = new TimeBank(20_000);
    f.windows.open(0, f.actions, "turn", f.policy, bank.balance(0), false);
    f.setNow(6_300);
    f.windows.consumeLegacyBuffer(0, bank, f.policy);
    f.setNow(10_000);
    f.windows.consumeLegacyBuffer(0, bank, f.policy);
    expect(bank.balance(0)).toBe(19_000);
  });

  it("rebases restored elapsed and remaining times once without granting a new window", () => {
    const f = fixture();
    f.windows.restore(2, {
      kind: "turn",
      legalActions: f.actions,
      elapsedMs: 4_100,
      visibleRemainingMs: 900,
      expiryRemainingMs: 21_100,
    });
    expect(f.windows.view(2)).toMatchObject({
      startedAt: -3_100,
      deadline: 1_900,
      timerPending: true,
    });
    expect(f.scheduled[0].delayMs).toBe(21_100);
    f.pause();
    f.scheduled[0].callback();
    expect(f.expired).not.toHaveBeenCalled();
  });

  it("uses one rebasing timestamp for concurrent restored call windows", () => {
    const f = fixture();
    const saved = {
      kind: "turn" as const,
      legalActions: f.actions,
      elapsedMs: 4_100,
      visibleRemainingMs: 900,
      expiryRemainingMs: 21_100,
    };
    const restoredAt = 1_000;
    f.windows.restore(1, saved, restoredAt);
    f.setNow(1_500);
    f.windows.restore(2, saved, restoredAt);
    expect(f.windows.view(1).startedAt).toBe(-3_100);
    expect(f.windows.view(2).startedAt).toBe(-3_100);
    expect(f.windows.view(1).deadline).toBe(1_900);
    expect(f.windows.view(2).deadline).toBe(1_900);
  });

  it("does not expose writable legal-action storage", () => {
    const f = fixture();
    f.windows.open(0, f.actions, "turn", f.policy, 0, false);
    f.actions[0].id = "changed";
    const projection = f.windows.legals(0);
    projection[0].id = "changed-again";
    projection.push({ id: "pass", type: "pass" });
    expect(f.windows.legals(0)[0].id).toBe("discard:draw:1m");
    expect(f.windows.legals(0)).toHaveLength(1);
  });
});
