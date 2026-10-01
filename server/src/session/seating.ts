import type { Seat } from "~/game/protocol/messages";

export function deterministicShuffle<T>(
  items: readonly T[],
  seed: number
): T[] {
  let s = seed >>> 0;
  const next = (): number => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function waitingRoomSeatPermutation(
  seed: number
): [Seat, Seat, Seat, Seat] {
  const shuffled = deterministicShuffle<Seat>([0, 1, 2, 3], seed);
  return [shuffled[0], shuffled[1], shuffled[2], shuffled[3]];
}
