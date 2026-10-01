import { describe, expect, it, vi } from "vitest";
import { TimingDiagnostics } from "./timingDiagnostics";
import { timingConfiguration } from "./configuration";
import { ActionWindowViewSchema } from "~/game/protocol/timing";
import { createControlledRuntime } from "~/game/testing/timing/controlledRuntime";
import { DecisionTiming } from "./decisionTiming";
import { ActionWindowRegistry } from "./actionWindows";
import { TimeBank } from "./timeBank";

describe("correlated timing diagnostics and rollout configuration", () => {
  it("does not turn a failed diagnostic sink into a gameplay failure", () => {
    const logged = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    try {
      const diagnostics = new TimingDiagnostics(
        "match-1",
        "epoch-1",
        false,
        () => {
          throw new Error("Broken log sink");
        }
      );
      expect(() => diagnostics.record("opened", 1_000)).not.toThrow();
      expect(logged).toHaveBeenCalled();
      expect(diagnostics.recent()).toHaveLength(1);
    } finally {
      logged.mockRestore();
    }
  });
  it("compares proposed readiness in shadow mode without changing the legacy budget or pose", () => {
    const runtime = createControlledRuntime(1_000);
    const windows = new ActionWindowRegistry(
      runtime,
      () => undefined,
      () => false
    );
    const bank = new TimeBank(20_000);
    const observe = vi.fn();
    const timing = new DecisionTiming(
      "epoch-1",
      "match-1",
      runtime,
      windows,
      bank,
      "legacy",
      {
        shadow: true,
        observer: observe,
      }
    );
    timing.record({ type: "draw", seat: 0, tile: "1m", wallRemaining: 69 }, 0);
    expect(
      timing.open(
        0,
        [{ id: "discard:1m", type: "discard", tile: "1m" }],
        "turn",
        { baseMs: 5_000, graceMs: 200, declarationMs: 5_000, automatedMs: 700 },
        false
      )
    ).toBe(false);
    expect(windows.timedView(0)).toBeNull();
    expect(bank.balance(0)).toBe(20_000);
    expect(timing.metadata(0, 0)).toEqual({
      clock: { clockEpoch: "epoch-1", serverNow: 1_000 },
    });
    expect(observe).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "shadow",
        opensAt: 1_300,
        legacyOpensAt: 1_000,
        baseEndsAt: 6_300,
      })
    );
  });

  it("records only timing metadata, not private actions or client-reported authority", () => {
    const observe = vi.fn();
    const diagnostics = new TimingDiagnostics(
      "match-1",
      "epoch-1",
      false,
      observe
    );
    const window = ActionWindowViewSchema.parse({
      id: "window-1",
      clockEpoch: "epoch-1",
      timingVersion: 2,
      seat: 0,
      kind: "turn",
      state: "open",
      infoSentAt: 500,
      opensAt: 1_000,
      baseEndsAt: 6_000,
      budgetEndsAt: 26_000,
      expiresAt: 26_200,
      bankAtOpenMs: 20_000,
      allowanceMs: 200,
      generation: 1,
      legalActionIds: ["discard:secret-tile"],
    });
    diagnostics.record("opened", 500, window);
    diagnostics.record(
      "reserved",
      6_300,
      window,
      {},
      {
        receivedAt: 6_300,
        ownerGeneration: 7,
      }
    );
    expect(JSON.stringify(diagnostics.recent())).not.toContain("secret-tile");
    expect(observe).toHaveBeenLastCalledWith(
      expect.objectContaining({
        matchId: "match-1",
        clockEpoch: "epoch-1",
        windowId: "window-1",
        receivedAt: 6_300,
        connectionGeneration: 7,
      })
    );
  });

  it("bounds local history and retains whole-match default and shadow controls", () => {
    const diagnostics = new TimingDiagnostics("match-1", "epoch-1");
    for (let index = 0; index < 100; index++) {
      diagnostics.record("restored", index);
    }
    expect(diagnostics.recent()).toHaveLength(64);
    expect(timingConfiguration({})).toEqual({
      timingMode: "legacy",
      timingShadow: false,
    });
    expect(timingConfiguration({ GAME_TIMING_SHADOW: "true" })).toMatchObject({
      timingMode: "legacy",
      timingShadow: true,
    });
    expect(() =>
      timingConfiguration({
        GAME_TIMING_MODE: "windows-v2",
        GAME_TIMING_SHADOW: "true",
      })
    ).toThrow(/legacy/);
    expect(() =>
      timingConfiguration({ GAME_TIMING_DIAGNOSTICS: "silently-default" })
    ).toThrow();
  });

  it("records an expired default and one resolution without duplicate bank accounting", async () => {
    const runtime = createControlledRuntime(1_000);
    const windows = new ActionWindowRegistry(
      runtime,
      () => undefined,
      () => false
    );
    const bank = new TimeBank(0);
    const timing = new DecisionTiming(
      "epoch-1",
      "match-1",
      runtime,
      windows,
      bank,
      "windows-v2"
    );
    timing.open(
      0,
      [{ id: "discard:1m", type: "discard", tile: "1m" }],
      "turn",
      { baseMs: 5_000, graceMs: 200, declarationMs: 5_000, automatedMs: 700 },
      false
    );
    await runtime.advanceBy(5_200);
    timing.consume(0);
    timing.consume(0);
    expect(timing.diagnostics.recent().map(({ outcome }) => outcome)).toEqual([
      "opened",
      "expired",
      "resolved",
    ]);
    expect(bank.balance(0)).toBe(0);
  });
});
