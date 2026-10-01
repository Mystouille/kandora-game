import { describe, expect, it } from "vitest";
import type { ActionWindowView } from "~/game/protocol/timing";
import {
  ActionWindowRegistry,
  DecisionWindowError,
} from "~/game/server/src/timing/actionWindows";
import { DecisionTiming } from "~/game/server/src/timing/decisionTiming";
import { TimeBank } from "~/game/server/src/timing/timeBank";
import type { LatencyProfile } from "~/game/server/src/transport/latencyProfile";
import { createControlledRuntime } from "./controlledRuntime";
import { actionTimerView } from "~/game/client/time/actionWindowViewModel";
import {
  SUPPORTED_FAIRNESS_PROFILES,
  DEGRADED_FAIRNESS_PROFILES,
  degradedReasons,
  transportDelayMs,
} from "./fairnessProfiles";

const policy = {
  baseMs: 5_000,
  graceMs: 200,
  declarationMs: 5_000,
  automatedMs: 700,
};
const actions = [{ id: "discard:1m", type: "discard" as const, tile: "1m" }];

function fixture(bankMs = 20_000) {
  const runtime = createControlledRuntime(1_000_000);
  const defaults: number[] = [];
  const bank = new TimeBank(bankMs);
  const windows = new ActionWindowRegistry(
    runtime,
    (seat) => defaults.push(seat),
    () => false
  );
  const timing = new DecisionTiming(
    "epoch-a",
    "stress-match",
    runtime,
    windows,
    bank,
    "windows-v2"
  );
  return { runtime, defaults, bank, windows, timing };
}

function openWindow(context: ReturnType<typeof fixture>): ActionWindowView {
  context.timing.connection(0, "remote", () => null);
  expect(context.timing.open(0, actions, "turn", policy, false)).toBe(true);
  const window = context.windows.timedView(0);
  if (!window) {
    throw new Error("Expected an explicit stress decision");
  }
  return window;
}

describe("controlled fairness envelope", () => {
  it.each(SUPPORTED_FAIRNESS_PROFILES)(
    "$name really stays within the declared delay/frame envelope",
    (profile) => {
      expect(degradedReasons(profile)).toEqual([]);
      expect(profile.framesPerSecond).toBeGreaterThanOrEqual(30);
      for (let up = 0; up < 4; up += 1) {
        for (let down = 0; down < 4; down += 1) {
          const upstream = transportDelayMs(profile, "upstream", up);
          const downstream = transportDelayMs(profile, "downstream", down);
          expect(upstream + downstream).toBeGreaterThanOrEqual(
            profile.roundTripMs
          );
          expect(
            upstream + downstream - profile.roundTripMs
          ).toBeLessThanOrEqual(50);
          expect(Math.abs(upstream - downstream)).toBeLessThanOrEqual(50);
        }
      }
    }
  );

  it.each(DEGRADED_FAIRNESS_PROFILES)(
    "$name is explicitly outside SC-002, not silently counted as supported",
    (profile) => {
      expect(degradedReasons(profile).length).toBeGreaterThan(0);
    }
  );
});

describe("authority window receipt/default and recovery stress", () => {
  it.each([-1, 0, 1])(
    "arbitrates ingress at expiry %+i ms without runner queue time",
    async (offset) => {
      const context = fixture(0);
      let window: ActionWindowView | undefined;
      context.runtime.schedule(
        () => {
          if (!window) {
            throw new Error("The scheduled ingress has no decision identity");
          }
          const receipt = {
            windowId: window.id,
            clockEpoch: window.clockEpoch,
            receivedAt: context.runtime.now(),
          };
          if (offset <= 0) {
            context.windows.reserve(0, actions[0].id, receipt);
          } else {
            expect(() =>
              context.windows.reserve(0, actions[0].id, receipt)
            ).toThrow(DecisionWindowError);
          }
        },
        policy.baseMs + 200 + offset
      );
      window = openWindow(context);
      await context.runtime.advanceBy(
        window.expiresAt - context.runtime.now() + offset
      );
      if (offset <= 0) {
        await context.runtime.advanceBy(50_000);
        expect(context.defaults).toEqual([]);
        context.windows.consumeTimedBuffer(0, context.bank);
        expect(context.windows.timedView(0)?.state).toBe("resolved");
      } else {
        expect(context.defaults).toEqual([0]);
        expect(context.windows.timedView(0)?.state).toBe("expired");
      }
      expect(context.bank.snapshot()).toEqual([0, 0, 0, 0]);
    }
  );

  it("caps a usable beyond-envelope profile at 500 ms without expanding bank or base", () => {
    const context = fixture();
    context.timing.connection(0, "remote", () => ({
      roundTripMs: 2_000,
      jitterMs: 500,
      measuredAt: context.runtime.now(),
      samples: 16,
    }));
    context.timing.open(0, actions, "turn", policy, false);
    const window = context.windows.timedView(0);
    expect(window?.allowanceMs).toBe(500);
    expect((window?.baseEndsAt ?? NaN) - (window?.opensAt ?? NaN)).toBe(5_000);
    expect((window?.budgetEndsAt ?? NaN) - (window?.baseEndsAt ?? NaN)).toBe(
      20_000
    );
    expect((window?.expiresAt ?? NaN) - (window?.budgetEndsAt ?? NaN)).toBe(
      500
    );
  });

  it("freezes allowance, reserves before a long queue, and charges fractional overage exactly once", async () => {
    const context = fixture();
    let profile: LatencyProfile | null = {
      roundTripMs: 300,
      jitterMs: 50,
      measuredAt: context.runtime.now(),
      samples: 8,
    };
    context.timing.connection(0, "remote", () => profile);
    context.timing.open(0, actions, "turn", policy, false);
    const original = context.windows.timedView(0);
    if (!original) {
      throw new Error("Expected a measured-profile window");
    }
    expect(original.allowanceMs).toBe(325);
    profile = {
      roundTripMs: 5_000,
      jitterMs: 1_000,
      measuredAt: context.runtime.now(),
      samples: 16,
    };
    const receivedAt = original.baseEndsAt + original.allowanceMs + 137;
    await context.runtime.advanceBy(receivedAt - context.runtime.now());
    context.windows.reserve(0, actions[0].id, {
      receivedAt,
      windowId: original.id,
      clockEpoch: original.clockEpoch,
    });
    for (let operation = 0; operation < 100; operation += 1) {
      context.runtime.schedule(() => undefined, operation * 10);
    }
    await context.runtime.advanceBy(50_000);
    expect(context.windows.timedView(0)?.expiresAt).toBe(original.expiresAt);
    expect(context.windows.timedView(0)?.allowanceMs).toBe(325);
    context.timing.consume(0);
    context.timing.consume(0);
    expect(context.bank.snapshot()).toEqual([19_863, 20_000, 20_000, 20_000]);
    expect(context.defaults).toEqual([]);
  });

  it("uses precisely 200 ms for missing/stale/noisy samples but zero for a known direct host", () => {
    const context = fixture();
    const fallback = openWindow(context);
    expect(fallback.allowanceMs).toBe(200);
    context.timing.connection(0, "remote", () => ({
      roundTripMs: 100,
      jitterMs: 0,
      measuredAt: context.runtime.now() - 30_001,
      samples: 8,
    }));
    context.timing.open(0, actions, "turn", policy, false);
    expect(context.windows.timedView(0)?.allowanceMs).toBe(200);
    context.timing.connection(0, "remote", () => ({
      roundTripMs: NaN,
      jitterMs: 500,
      measuredAt: context.runtime.now(),
      samples: 16,
    }));
    context.timing.open(0, actions, "turn", policy, false);
    expect(context.windows.timedView(0)?.allowanceMs).toBe(200);
    context.timing.connection(0, "direct", () => null);
    context.timing.open(0, actions, "turn", policy, false);
    expect(context.windows.timedView(0)?.allowanceMs).toBe(0);
  });

  it("rebases partial bank elapsed through two epochs without replenishment or double debit", async () => {
    const source = fixture();
    const original = openWindow(source);
    await source.runtime.advanceBy(5_777);
    const savedAt = source.runtime.now();
    const saved = source.windows.timedView(0);
    if (!saved) {
      throw new Error("Expected a recoverable partial-bank window");
    }
    const restored = fixture();
    await restored.runtime.advanceBy(7_000_000);
    restored.windows.restoreTimed(0, actions, saved, savedAt, "epoch-b");
    const rebased = restored.windows.timedView(0);
    if (!rebased) {
      throw new Error("Expected the same rebased decision");
    }
    expect(rebased.id).toBe(original.id);
    expect(rebased.clockEpoch).toBe("epoch-b");
    expect(rebased.baseEndsAt - restored.runtime.now()).toBe(-777);
    expect(rebased.expiresAt - restored.runtime.now()).toBe(
      original.expiresAt - savedAt
    );
    expect(rebased.allowanceMs).toBe(200);
    const second = fixture();
    await second.runtime.advanceBy(11_000_000);
    second.windows.restoreTimed(
      0,
      actions,
      rebased,
      restored.runtime.now(),
      "epoch-c"
    );
    await second.runtime.advanceBy(123);
    const current = second.windows.timedView(0);
    if (!current) {
      throw new Error("Expected the twice-restored decision");
    }
    second.windows.reserve(0, actions[0].id, {
      receivedAt: second.runtime.now(),
      windowId: current.id,
      clockEpoch: "epoch-c",
    });
    second.windows.consumeTimedBuffer(0, second.bank);
    second.windows.consumeTimedBuffer(0, second.bank);
    expect(second.bank.balance(0)).toBe(19_300);
    expect(second.defaults).toEqual([]);
  });

  it.each(["resolved", "expired", "cancelled"] as const)(
    "never resurrects a %s checkpoint window",
    async (state) => {
      const source = fixture();
      const original = openWindow(source);
      if (state === "resolved") {
        await source.runtime.advanceBy(5_337);
        source.windows.reserve(0, actions[0].id, {
          receivedAt: source.runtime.now(),
          windowId: original.id,
          clockEpoch: original.clockEpoch,
        });
        source.windows.consumeTimedBuffer(0, source.bank);
        expect(source.bank.balance(0)).toBe(19_863);
      } else if (state === "expired") {
        await source.runtime.advanceBy(
          original.expiresAt - source.runtime.now()
        );
        expect(source.defaults).toEqual([0]);
      }
      const saved = source.windows.timedView(0);
      if (!saved) {
        throw new Error("The terminal window was not captured");
      }
      const terminal = { ...saved, state };
      const restored = fixture();
      restored.bank.restore(source.bank.snapshot());
      await restored.runtime.advanceBy(7_000_000);
      restored.windows.restoreTimed(
        0,
        actions,
        terminal,
        source.runtime.now(),
        "new-epoch"
      );
      const window = restored.windows.timedView(0);
      if (!window) {
        throw new Error("The restored terminal identity was lost");
      }
      expect(window.id).toBe(original.id);
      expect(window.state).toBe(state);
      expect(window.clockEpoch).toBe("new-epoch");
      expect(window.allowanceMs).toBe(original.allowanceMs);
      expect(actionTimerView(window, restored.runtime.now()).ready).toBe(false);
      if (state !== "expired") {
        expect(() =>
          restored.windows.reserve(0, actions[0].id, {
            receivedAt: restored.runtime.now(),
            windowId: window.id,
            clockEpoch: window.clockEpoch,
          })
        ).toThrow(DecisionWindowError);
        expect(restored.windows.legals(0)).toEqual([]);
        expect(restored.windows.view(0).timerPending).toBe(false);
      }
      await restored.runtime.advanceBy(30_000);
      expect(restored.defaults).toEqual(state === "expired" ? [0] : []);
      restored.windows.consumeTimedBuffer(0, restored.bank);
      restored.windows.consumeTimedBuffer(0, restored.bank);
      expect(() =>
        restored.windows.reserve(0, actions[0].id, {
          receivedAt: window.expiresAt,
          windowId: window.id,
          clockEpoch: window.clockEpoch,
        })
      ).toThrow(DecisionWindowError);
      expect(restored.bank.balance(0)).toBe(
        state === "expired" ? 0 : source.bank.balance(0)
      );
    }
  );

  it("refuses a backdated receipt after the default has already resolved an expired window", async () => {
    const context = fixture(0);
    const window = openWindow(context);
    await context.runtime.advanceBy(window.expiresAt - context.runtime.now());
    expect(context.defaults).toEqual([0]);
    expect(context.windows.timedView(0)?.state).toBe("expired");
    context.windows.consumeTimedBuffer(0, context.bank);
    expect(() =>
      context.windows.reserve(0, actions[0].id, {
        receivedAt: window.expiresAt,
        windowId: window.id,
        clockEpoch: window.clockEpoch,
      })
    ).toThrow(DecisionWindowError);
  });

  it("fences a previous generation's input and timer from the next decision", async () => {
    const context = fixture(0);
    const old = openWindow(context);
    await context.runtime.advanceBy(100);
    const current = openWindow(context);
    expect(current.id).not.toBe(old.id);
    expect(() =>
      context.windows.reserve(0, actions[0].id, {
        receivedAt: context.runtime.now(),
        windowId: old.id,
        clockEpoch: old.clockEpoch,
      })
    ).toThrow(DecisionWindowError);
    await context.runtime.advanceBy(old.expiresAt - context.runtime.now());
    expect(context.defaults).toEqual([]);
    await context.runtime.advanceBy(current.expiresAt - context.runtime.now());
    expect(context.defaults).toEqual([0]);
  });
});
