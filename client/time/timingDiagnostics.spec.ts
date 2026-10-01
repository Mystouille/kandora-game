import { afterEach, describe, expect, it, vi } from "vitest";
import {
  observeClientTiming,
  recentClientTiming,
  reportClientTiming,
  reportClockQuality,
} from "./timingDiagnostics";

afterEach(() => vi.restoreAllMocks());

describe("shared client timing diagnostics", () => {
  it("bounds and deduplicates observations without exposing mutable history", () => {
    vi.spyOn(console, "debug").mockImplementation(() => undefined);
    const observe = vi.fn();
    const release = observeClientTiming(observe);
    try {
      for (let seq = 0; seq < 80; seq++) {
        const event = {
          kind: "late-presentation" as const,
          clockEpoch: "bounded-diagnostics",
          seq,
          latenessMs: 300,
        };
        reportClientTiming(event);
        reportClientTiming(event);
      }
      expect(observe).toHaveBeenCalledTimes(80);
      const recent = recentClientTiming();
      expect(recent).toHaveLength(64);
      expect(recent[0].seq).toBe(16);
      expect(Object.isFrozen(recent[0])).toBe(true);
      expect(recentClientTiming()).not.toBe(recent);
    } finally {
      release();
    }
  });

  it("shares cloud and Nearby degraded-quality reporting without treating it as authority", () => {
    vi.spyOn(console, "debug").mockImplementation(() => undefined);
    const observe = vi.fn();
    const release = observeClientTiming(observe);
    try {
      reportClockQuality(null);
      reportClockQuality({
        clockEpoch: "supported-diagnostics",
        roundTripMs: 300,
        uncertaintyMs: 150,
        sampledAt: 0,
      });
      expect(observe).not.toHaveBeenCalled();
      reportClockQuality({
        clockEpoch: "degraded-diagnostics",
        roundTripMs: 800,
        uncertaintyMs: 400,
        sampledAt: 0,
      });
      expect(observe).toHaveBeenCalledExactlyOnceWith({
        kind: "clock-quality",
        clockEpoch: "degraded-diagnostics",
        roundTripMs: 800,
        uncertaintyMs: 400,
      });
    } finally {
      release();
    }
  });

  it("logs observer failures while continuing delivery to the other observers", () => {
    vi.spyOn(console, "debug").mockImplementation(() => undefined);
    const logged = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const failure = new Error("client diagnostic sink failed");
    const stopBroken = observeClientTiming(() => {
      throw failure;
    });
    const good = vi.fn();
    const stopGood = observeClientTiming(good);
    try {
      expect(() =>
        reportClientTiming({
          kind: "epoch-mismatch",
          clockEpoch: "observer-failure-diagnostics",
          windowId: "window-1",
        })
      ).not.toThrow();
      expect(logged).toHaveBeenCalledWith(
        "[game-client-timing] diagnostic observer failed",
        failure
      );
      expect(good).toHaveBeenCalledOnce();
    } finally {
      stopBroken();
      stopGood();
    }
  });
});
