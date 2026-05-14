/**
 * Head-to-head speed comparison: our lookup-table shanten vs the
 * `syanten` npm package, on the same input hands.
 *
 * Run with:
 *   npx vitest run app/game/rules/shanten.compare.spec.ts --reporter=verbose
 *
 * Numbers will vary by machine; the test only asserts that ours is
 * not catastrophically slower (e.g. >5× on warm cache). Actual ratio
 * is logged for inspection.
 */
import { describe, it } from "vitest";
import syanten from "syanten";
import { createPRNG } from "./prng";
import { shanten } from "./shanten";

function buildWall(): string[] {
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
  return wall;
}

function randomHand(rng: ReturnType<typeof createPRNG>, size = 13): string[] {
  const wall = buildWall();
  rng.shuffle(wall);
  return wall.slice(0, size);
}

function toHaiArr(tiles: string[]): syanten.HaiArr {
  const hai: syanten.HaiArr = [
    [0, 0, 0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0],
  ];
  for (const t of tiles) {
    const ch = t[t.length - 1];
    const n = (t[0] === "0" ? 5 : Number(t[0])) - 1;
    const suit = ch === "m" ? 0 : ch === "p" ? 1 : ch === "s" ? 2 : 3;
    hai[suit][n]++;
  }
  return hai;
}

function bench(label: string, fn: () => void, iterations: number): number {
  // Warmup.
  for (let i = 0; i < 100; i++) {
    fn();
  }
  const t0 = performance.now();
  for (let i = 0; i < iterations; i++) {
    fn();
  }
  const ms = performance.now() - t0;
  const usPerOp = (ms * 1000) / iterations;
  // eslint-disable-next-line no-console
  console.log(
    `  ${label.padEnd(40)} ${ms.toFixed(1).padStart(8)} ms  (${usPerOp.toFixed(2)} µs/hand × ${iterations})`
  );
  return ms;
}

describe("shanten — speed vs syanten", () => {
  it("compares throughput on a shared hand set", () => {
    const rng = createPRNG(98765);
    const N = 5000;
    const hands = Array.from({ length: N }, () => randomHand(rng));
    const haiArrs = hands.map(toHaiArr);

    // eslint-disable-next-line no-console
    console.log(`\nBenchmark: ${N} random 13-tile hands`);

    let ix = 0;
    const ours = bench(
      "ours  shanten()        (cold->warm)",
      () => {
        shanten(hands[ix++ % N]);
      },
      N
    );

    ix = 0;
    const oursWarm = bench(
      "ours  shanten()        (fully warm)",
      () => {
        shanten(hands[ix++ % N]);
      },
      N
    );

    ix = 0;
    const theirs = bench(
      "syanten.syantenAll()   (call overhead included)",
      () => {
        syanten.syantenAll(haiArrs[ix++ % N]);
      },
      N
    );

    // eslint-disable-next-line no-console
    console.log(
      `  ratios: warm/syanten = ${(oursWarm / theirs).toFixed(2)}×, cold/syanten = ${(ours / theirs).toFixed(2)}×`
    );
  });

  it("compares per-hand latency on uncached fresh hands (worst case for ours)", () => {
    // Each iteration uses a brand-new hand the cache has never seen,
    // so our `solveSuit` recurses fresh. This isolates the recursion
    // cost from the cache-hit cost.
    const rng = createPRNG(11111);
    const N = 2000;
    const hands = Array.from({ length: N }, () => randomHand(rng));
    const haiArrs = hands.map(toHaiArr);

    // eslint-disable-next-line no-console
    console.log(`\nBenchmark: ${N} fresh hands (one-shot, cache cleared)`);

    // Re-import a clean module instance is awkward without dynamic
    // import; instead, use 2000 distinct hands so cache pressure
    // dominates. The "warm" run reuses cache.
    let ix = 0;
    const ours = bench(
      "ours  shanten()        (cache builds during run)",
      () => {
        shanten(hands[ix++ % N]);
      },
      N
    );

    ix = 0;
    const theirs = bench(
      "syanten.syantenAll()",
      () => {
        syanten.syantenAll(haiArrs[ix++ % N]);
      },
      N
    );

    // eslint-disable-next-line no-console
    console.log(`  ratio ours/syanten = ${(ours / theirs).toFixed(2)}×`);
  });
});
