import { describe, expect, it } from "vitest";
import { latencyAllowanceMs } from "./latencyAllowancePolicy";
import { LatencySampler } from "../transport/latencyProfile";

describe("frozen latency allowance policy", () => {
  it("does not promote startup processing spikes into a stable network profile", () => {
    let now = 0;
    const sampler = new LatencySampler(() => now);
    for (const [index, delay] of [700, 710, 720, 300, 305, 310].entries()) {
      sampler.sent(String(index));
      now += delay;
      sampler.received(String(index));
    }
    expect(sampler.profile()).toMatchObject({
      samples: 3,
      roundTripMs: 305,
      jitterMs: 5,
    });
  });

  it("uses exactly 200 ms for an unusable remote profile and zero for local", () => {
    const context = {
      network: "remote" as const,
      profile: null,
      infoSentAt: 500,
      opensAt: 1_000,
      now: 1_000,
    };
    expect(latencyAllowanceMs(context)).toBe(200);
    expect(latencyAllowanceMs({ ...context, network: "direct" })).toBe(0);
  });

  it.each([
    [0, 0],
    [100, 50],
    [300, 150],
    [1_000, 500],
    [2_000, 500],
  ])("bounds a %i ms measured round trip to %i ms", (roundTripMs, expected) => {
    expect(
      latencyAllowanceMs({
        network: "remote",
        profile: { roundTripMs, jitterMs: 0, measuredAt: 900, samples: 3 },
        infoSentAt: 500,
        opensAt: 1_000,
        now: 1_000,
      })
    ).toBe(expected);
  });

  it("accounts for outbound lateness when information delivery had no lead", () => {
    expect(
      latencyAllowanceMs({
        network: "remote",
        profile: { roundTripMs: 300, jitterMs: 0, measuredAt: 900, samples: 3 },
        infoSentAt: 1_000,
        opensAt: 1_000,
        now: 1_000,
      })
    ).toBe(300);
  });

  it("rejects unmatched samples and expires old measured profiles", () => {
    let now = 0;
    const sampler = new LatencySampler(() => now);
    expect(sampler.received("unknown")).toBe(false);
    for (let index = 0; index < 3; index++) {
      sampler.sent(String(index));
      now += 100;
      expect(sampler.received(String(index))).toBe(true);
    }
    expect(sampler.profile()?.roundTripMs).toBe(100);
    now += 30_001;
    expect(sampler.profile()).toBeNull();
  });
});
