import { describe, expect, it } from "vitest";
import { ServerClock } from "./serverClock";

describe("client server-clock estimate", () => {
  it("estimates authority time from four stamps without device wall time", () => {
    let now = 0;
    const clock = new ServerClock({ monotonicNow: () => now });
    const probe = clock.createProbe("probe-1");
    expect(probe.probeId).toBe("probe-1");
    now = 100;
    expect(
      clock.observe({
        type: "clock_sample",
        probeId: "probe-1",
        clockEpoch: "epoch-1",
        serverReceivedAt: 10_050,
        serverSentAt: 10_050,
      })
    ).toEqual({ accepted: true });
    expect(clock.now()).toBe(10_100);
    now = 200;
    expect(clock.now()).toBe(10_200);
    expect(clock.quality()?.roundTripMs).toBe(100);
    expect(clock.quality()?.uncertaintyMs).toBe(50);
  });

  it("reports unmatched samples and preserves its valid estimate", () => {
    const clock = new ServerClock({ monotonicNow: () => 0 });
    expect(
      clock.observe({
        type: "clock_sample",
        probeId: "unknown",
        clockEpoch: "epoch-1",
        serverReceivedAt: 1_000,
        serverSentAt: 1_000,
      })
    ).toEqual({ accepted: false, reason: "unknown-probe" });
    expect(clock.now()).toBeNull();
  });

  it("replaces the reference on a new authority epoch", () => {
    let now = 0;
    const clock = new ServerClock({ monotonicNow: () => now });
    clock.createProbe("first");
    now = 20;
    clock.observe({
      type: "clock_sample",
      probeId: "first",
      clockEpoch: "epoch-1",
      serverReceivedAt: 1_010,
      serverSentAt: 1_010,
    });
    clock.createProbe("second");
    now = 40;
    clock.observe({
      type: "clock_sample",
      probeId: "second",
      clockEpoch: "epoch-2",
      serverReceivedAt: 2_010,
      serverSentAt: 2_010,
    });
    expect(clock.now()).toBe(2_020);
    expect(clock.quality()?.clockEpoch).toBe("epoch-2");
    clock.invalidate();
    expect(clock.now()).toBeNull();
  });

  it("prefers low-latency samples over a noisy late response", () => {
    let now = 0;
    const clock = new ServerClock({ monotonicNow: () => now });
    clock.createProbe("fast");
    now = 20;
    clock.observe({
      type: "clock_sample",
      probeId: "fast",
      clockEpoch: "epoch-1",
      serverReceivedAt: 10_010,
      serverSentAt: 10_010,
    });
    clock.createProbe("slow");
    now = 220;
    clock.observe({
      type: "clock_sample",
      probeId: "slow",
      clockEpoch: "epoch-1",
      serverReceivedAt: 10_180,
      serverSentAt: 10_180,
    });
    expect(clock.now()).toBe(10_220);
    expect(clock.quality()?.roundTripMs).toBe(20);
  });
});
