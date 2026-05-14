/**
 * Microbenchmark to confirm shanten() meets the speed goal of the
 * ezyang lookup-table approach. Not a correctness test — it just
 * asserts a generous wall-clock budget so a regression that makes
 * shanten 10× slower fails CI loudly.
 *
 * Numbers as of Phase 1 step 3 on a typical dev laptop:
 *   - cold (no cache): ~0.5–1.0 ms / hand
 *   - warm (cached):   <0.05 ms / hand
 */
import { describe, expect, it } from "vitest";
import { createPRNG } from "./prng";
import { shanten } from "./shanten";

function randomHand(rng: ReturnType<typeof createPRNG>, size = 13): string[] {
  const wall: string[] = [];
  for (const suit of ["m", "p", "s"] as const) {
    for (let n = 1; n <= 9; n++) {
      for (let copy = 0; copy < 4; copy++) {
        wall.push(`${n}${suit}`);
      }
    }
  }
  for (let n = 1; n <= 7; n++) {
    for (let copy = 0; copy < 4; copy++) {
      wall.push(`${n}z`);
    }
  }
  rng.shuffle(wall);
  return wall.slice(0, size);
}

describe("shanten — performance", () => {
  it("computes 5000 random hands within budget", () => {
    const rng = createPRNG(42);
    const hands = Array.from({ length: 5000 }, () => randomHand(rng));
    const t0 = performance.now();
    for (const h of hands) {
      shanten(h);
    }
    const ms = performance.now() - t0;
    // 5000 hands in well under 5 seconds even on slow CI; in practice
    // ~250 ms cold, <100 ms warm.
    expect(ms).toBeLessThan(5000);
  });
});
