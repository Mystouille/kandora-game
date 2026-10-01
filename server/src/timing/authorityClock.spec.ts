import { describe, expect, it } from "vitest";
import { createAuthorityClock } from "./authorityClock";

describe("authority clock", () => {
  it("uses monotonic elapsed time despite wall-clock jumps", () => {
    let wall = 1_000_000;
    let monotonic = 100;
    const clock = createAuthorityClock({
      epoch: "epoch-1",
      wallNow: () => wall,
      monotonicNow: () => monotonic,
    });
    monotonic += 50;
    wall += 300_000;
    expect(clock.now()).toBe(1_000_050);
    wall -= 600_000;
    monotonic += 50;
    expect(clock.now()).toBe(1_000_100);
    expect(clock.wallNow()).toBe(wall);
    expect(clock.epoch).toBe("epoch-1");
  });

  it("rejects invalid or regressing injected monotonic time", () => {
    let monotonic = 100;
    const clock = createAuthorityClock({
      epoch: "epoch-1",
      wallNow: () => 1_000,
      monotonicNow: () => monotonic,
    });
    monotonic = 99;
    expect(() => clock.now()).toThrow(/monotonic/i);
  });
});
