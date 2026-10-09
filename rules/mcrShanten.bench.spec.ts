import { describe, expect, it } from "vitest";
import { mcrShanten } from "~/core/mahjong/rules/mcrShanten";
import { createPRNG } from "./prng";

function randomHand(rng: ReturnType<typeof createPRNG>, size = 13): string[] {
  const wall: string[] = [];
  for (const suit of ["m", "p", "s"] as const) {
    for (let rank = 1; rank <= 9; rank++) {
      for (let copy = 0; copy < 4; copy++) {
        wall.push(`${rank}${suit}`);
      }
    }
  }
  for (let rank = 1; rank <= 7; rank++) {
    for (let copy = 0; copy < 4; copy++) {
      wall.push(`${rank}z`);
    }
  }
  rng.shuffle(wall);
  return wall.slice(0, size);
}

describe("MCR shanten performance", () => {
  it("keeps 5000 structural probes inside the existing CI budget", () => {
    const rng = createPRNG(20261009);
    const hands = Array.from({ length: 5000 }, () => randomHand(rng));
    const started = performance.now();
    for (const hand of hands) {
      mcrShanten(hand);
    }
    expect(performance.now() - started).toBeLessThan(5000);
  });
});
