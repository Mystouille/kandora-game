import { describe, expect, it } from "vitest";
import { normalizeEpochMilliseconds } from "./timestamp";

describe("normalizeEpochMilliseconds", () => {
  it("normalizes seconds, milliseconds, and accidental microseconds", () => {
    expect(normalizeEpochMilliseconds(1_697_609_642)).toBe(1_697_609_642_000);
    expect(normalizeEpochMilliseconds(1_697_609_642_240)).toBe(
      1_697_609_642_240
    );
    expect(normalizeEpochMilliseconds(1_697_609_642_240_000)).toBe(
      1_697_609_642_240
    );
  });

  it("rejects missing and non-finite values", () => {
    expect(normalizeEpochMilliseconds(0)).toBe(0);
    expect(normalizeEpochMilliseconds(Number.NaN)).toBe(0);
    expect(normalizeEpochMilliseconds(Number.POSITIVE_INFINITY)).toBe(0);
  });
});
