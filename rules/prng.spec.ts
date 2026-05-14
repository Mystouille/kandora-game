import { describe, expect, it } from "vitest";
import { createPRNG, hashStringToSeed } from "./prng";

describe("createPRNG", () => {
  it("is deterministic for a given seed", () => {
    const a = createPRNG(42);
    const b = createPRNG(42);
    const seqA = Array.from({ length: 10 }, () => a.next());
    const seqB = Array.from({ length: 10 }, () => b.next());
    expect(seqA).toEqual(seqB);
  });

  it("locks the published mulberry32 stream for seed=1", () => {
    // Regression guard: changing the PRNG breaks every saved match.
    const rng = createPRNG(1);
    const out = Array.from({ length: 4 }, () => rng.next());
    expect(out).toEqual([
      0.6270739405881613, 0.002735721180215478, 0.5274470399599522,
      0.9810509674716741,
    ]);
  });

  it("shuffles in place and is a permutation of the input", () => {
    const original = Array.from({ length: 20 }, (_, i) => i);
    const arr = [...original];
    const out = createPRNG(7).shuffle(arr);
    expect(out).toBe(arr);
    expect([...out].sort((a, b) => a - b)).toEqual(original);
  });

  it("nextInt stays in [0, max)", () => {
    const rng = createPRNG(123);
    for (let i = 0; i < 1000; i++) {
      const v = rng.nextInt(7);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(7);
    }
  });
});

describe("hashStringToSeed", () => {
  it("is deterministic", () => {
    expect(hashStringToSeed("kandora")).toBe(hashStringToSeed("kandora"));
  });

  it("differs for distinct inputs", () => {
    expect(hashStringToSeed("a")).not.toBe(hashStringToSeed("b"));
  });
});
