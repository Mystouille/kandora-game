/**
 * Deterministic PRNG for the rules engine.
 *
 * mulberry32: 32-bit state, uniform output, fast. Plenty for shuffling
 * a 136-tile wall and for any future lottery-style draws (hand seed
 * reproducibility is what matters; cryptographic strength is not).
 *
 * Seed reproducibility is contractual: `(seed, actions[])` must always
 * recreate the exact same match. Tests in `prng.spec.ts` lock the
 * stream against regressions.
 */

export interface PRNG {
  /** Next uniform float in [0, 1). */
  next(): number;
  /** Next integer in [0, max). */
  nextInt(max: number): number;
  /** Fisher-Yates in place. */
  shuffle<T>(arr: T[]): T[];
}

export function createPRNG(seed: number): PRNG {
  let a = seed >>> 0;
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    nextInt(max: number): number {
      return Math.floor(next() * max);
    },
    shuffle<T>(arr: T[]): T[] {
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
      }
      return arr;
    },
  };
}

/**
 * Stable string-to-seed hash — used by the WS layer to derive a
 * reproducible seed from a `matchId`. Public here so tests and
 * tooling can recreate the same wall the server would.
 */
export function hashStringToSeed(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
