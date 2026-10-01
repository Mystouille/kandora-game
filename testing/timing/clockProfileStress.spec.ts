import { afterEach, describe, expect, it, vi } from "vitest";
import { ServerClock } from "~/game/client/time/serverClock";
import { actionTimerView } from "~/game/client/time/actionWindowViewModel";
import { createAuthorityClock } from "~/game/server/src/timing/authorityClock";
import {
  SUPPORTED_FAIRNESS_PROFILES,
  degradedReasons,
  transportDelayMs,
} from "./fairnessProfiles";
import type { ActionWindowView } from "~/game/protocol/timing";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("clock/window synchronization under controlled supported profiles", () => {
  it.each(SUPPORTED_FAIRNESS_PROFILES)(
    "$name retains the 100 ms synchronized-clock bound",
    (profile) => {
      let elapsed = 0;
      let wall = 1_000_000;
      const authority = createAuthorityClock({
        epoch: "profile-authority",
        wallNow: () => wall,
        monotonicNow: () => elapsed,
      });
      const clock = new ServerClock({ monotonicNow: () => elapsed + 7_000 });
      vi.spyOn(Date, "now").mockImplementation(() => wall);
      expect(degradedReasons(profile)).toEqual([]);
      for (let sample = 0; sample < 12; sample += 1) {
        const probeId = `profile-${sample}`;
        clock.createProbe(probeId);
        elapsed += transportDelayMs(profile, "upstream", sample);
        const serverReceivedAt = authority.now();
        elapsed += 2;
        const serverSentAt = authority.now();
        elapsed += transportDelayMs(profile, "downstream", sample + 1);
        expect(
          clock.observe({
            type: "clock_sample",
            probeId,
            clockEpoch: authority.epoch,
            serverReceivedAt,
            serverSentAt,
          })
        ).toEqual({ accepted: true });
        const estimate = clock.now();
        expect(estimate).not.toBeNull();
        expect(
          Math.abs((estimate ?? NaN) - authority.now())
        ).toBeLessThanOrEqual(100);
        if (sample === 3) {
          wall += 300_000;
        } else if (sample === 7) {
          wall -= 600_000;
        }
      }
      expect(clock.quality()?.clockEpoch).toBe(authority.epoch);
    }
  );

  it("rejects outstanding old-epoch responses after rebinding without reviving a terminal decision", () => {
    let elapsed = 0;
    const clock = new ServerClock({ monotonicNow: () => elapsed });
    clock.createProbe("initial");
    elapsed = 20;
    clock.observe({
      type: "clock_sample",
      probeId: "initial",
      clockEpoch: "epoch-a",
      serverReceivedAt: 1_000_010,
      serverSentAt: 1_000_010,
    });
    clock.createProbe("old-in-flight");
    clock.createProbe("replacement");
    elapsed = 40;
    expect(
      clock.observe({
        type: "clock_sample",
        probeId: "replacement",
        clockEpoch: "epoch-b",
        serverReceivedAt: 9_000_030,
        serverSentAt: 9_000_030,
      })
    ).toEqual({ accepted: true });
    elapsed = 70;
    expect(
      clock.observe({
        type: "clock_sample",
        probeId: "old-in-flight",
        clockEpoch: "epoch-a",
        serverReceivedAt: 1_000_030,
        serverSentAt: 1_000_030,
      })
    ).toEqual({ accepted: false, reason: "unknown-probe" });
    expect(clock.now()).toBe(9_000_070);
    const terminal: ActionWindowView = {
      id: "resolved-decision",
      clockEpoch: "epoch-b",
      timingVersion: 2,
      seat: 0,
      kind: "turn",
      state: "resolved",
      infoSentAt: 9_000_000,
      opensAt: 9_000_000,
      baseEndsAt: 9_005_000,
      budgetEndsAt: 9_025_000,
      expiresAt: 9_025_200,
      bankAtOpenMs: 20_000,
      allowanceMs: 200,
      generation: 1,
      legalActionIds: ["discard"],
    };
    expect(actionTimerView(terminal, clock.now() ?? NaN).ready).toBe(false);
  });

  it("expires stale samples during a foreground gap rather than inventing a fresh clock", () => {
    let elapsed = 0;
    const clock = new ServerClock({ monotonicNow: () => elapsed });
    clock.createProbe("before-background");
    elapsed = 100;
    clock.observe({
      type: "clock_sample",
      probeId: "before-background",
      clockEpoch: "epoch",
      serverReceivedAt: 1_000_050,
      serverSentAt: 1_000_050,
    });
    elapsed += 30_001;
    expect(clock.now()).toBeNull();
    expect(clock.quality()).toBeNull();
    clock.createProbe("foreground");
    elapsed += 100;
    expect(
      clock.observe({
        type: "clock_sample",
        probeId: "foreground",
        clockEpoch: "epoch",
        serverReceivedAt: 1_000_000 + elapsed - 50,
        serverSentAt: 1_000_000 + elapsed - 50,
      })
    ).toEqual({ accepted: true });
    expect(clock.now()).toBe(1_000_000 + elapsed);
  });
});
