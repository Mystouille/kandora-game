import { describe, expect, it } from "vitest";
import { ActionWindowRegistry } from "~/game/server/src/timing/actionWindows";
import { DecisionTiming } from "~/game/server/src/timing/decisionTiming";
import { TimeBank } from "~/game/server/src/timing/timeBank";
import {
  TimingDiagnostics,
  type TimingDiagnostic,
} from "~/game/server/src/timing/timingDiagnostics";
import type { ActionWindowView } from "~/game/protocol/timing";
import { createControlledRuntime } from "./controlledRuntime";

const policy = {
  baseMs: 5_000,
  graceMs: 200,
  declarationMs: 5_000,
  automatedMs: 700,
};
const actions = [{ id: "discard:1m", type: "discard" as const, tile: "1m" }];

describe("legacy shadow comparison remains observational", () => {
  it.each([false, true])(
    "shadow=%s preserves the legacy window, metadata, bank debit, and one default",
    async (shadow) => {
      const runtime = createControlledRuntime(1_000_000);
      const expired: number[] = [];
      const windows = new ActionWindowRegistry(
        runtime,
        (seat) => expired.push(seat),
        () => false
      );
      const bank = new TimeBank(20_000);
      const observed: Readonly<TimingDiagnostic>[] = [];
      const timing = new DecisionTiming(
        "shadow-epoch",
        "isolated-shadow",
        runtime,
        windows,
        bank,
        "legacy",
        {
          shadow,
          observer: (event) => observed.push(event),
        }
      );
      windows.open(0, actions, "turn", policy, bank.balance(0), false);
      const legacy = windows.view(0);
      const timers = runtime.pendingDelays();
      expect(timing.open(0, actions, "turn", policy, false)).toBe(false);
      expect(windows.view(0)).toEqual(legacy);
      expect(runtime.pendingDelays()).toEqual(timers);
      expect(timing.metadata(0, 1)).toEqual(
        shadow ? { clock: timing.stamp() } : {}
      );
      expect(timing.capture().windows).toEqual([null, null, null, null]);
      await runtime.advanceBy(5_500);
      timing.reserve(0, actions[0].id, {
        receivedAt: runtime.now(),
        clientSessionId: "private-session-marker",
      });
      expect(windows.hasReservedInput(0)).toBe(false);
      windows.consumeLegacyBuffer(0, bank, policy);
      expect(bank.balance(0)).toBe(19_000);
      await runtime.advanceBy(30_000);
      expect(expired).toEqual([0]);
      expect(timing.metadata(0, 2)).toEqual(
        shadow ? { clock: timing.stamp() } : {}
      );
      expect(observed.length).toBe(shadow ? 2 : 0);
      expect(observed.every((event) => event.outcome === "shadow")).toBe(true);
      expect(JSON.stringify(observed)).not.toContain("private-session-marker");
      expect(JSON.stringify(observed)).not.toContain("discard:1m");
    }
  );

  it("retains only the newest 64 sanitized diagnostics and returns immutable observations", () => {
    const diagnostics = new TimingDiagnostics(
      "isolated-diagnostics",
      "diag-epoch"
    );
    const window: ActionWindowView = {
      id: "diag-window",
      clockEpoch: "diag-epoch",
      timingVersion: 2,
      seat: 0,
      kind: "turn",
      state: "open",
      infoSentAt: 1_000_000,
      opensAt: 1_000_000,
      baseEndsAt: 1_005_000,
      budgetEndsAt: 1_025_000,
      expiresAt: 1_025_200,
      bankAtOpenMs: 20_000,
      allowanceMs: 200,
      generation: 1,
      legalActionIds: ["private-hand-marker"],
    };
    for (let index = 0; index < 100; index += 1) {
      diagnostics.record(
        "reserved",
        1_000_000 + index,
        window,
        {},
        {
          receivedAt: 1_000_000 + index,
          windowId: window.id,
          clockEpoch: window.clockEpoch,
          clientSessionId: "private-owner-marker",
        }
      );
    }
    const recent = diagnostics.recent();
    expect(recent).toHaveLength(64);
    expect(recent[0].at).toBe(1_000_036);
    expect(recent[63].at).toBe(1_000_099);
    expect(recent.every((event) => Object.isFrozen(event))).toBe(true);
    expect(JSON.stringify(recent)).not.toContain("private-hand-marker");
    expect(JSON.stringify(recent)).not.toContain("private-owner-marker");
    expect(recent[63]).toMatchObject({
      matchId: "isolated-diagnostics",
      clockEpoch: "diag-epoch",
      windowId: "diag-window",
      receivedAt: 1_000_099,
      allowanceMs: 200,
    });
  });
});
