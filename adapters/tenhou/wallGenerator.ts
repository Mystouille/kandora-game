/**
 * Tenhou deck/wall shuffling — official algorithm.
 *
 * Tenhou published their wall-generation algorithm in 2022 so
 * replays can be deterministically reconstructed by third parties.
 * The recipe (per `tenhou-tile-wall/gen32.cpp` by tomohxx and the
 * validation data at https://tenhou.net/stat/rand/validation.txt):
 *
 *   1. The `<SHUFFLE seed="mt19937ar-sha512-n288-base64,..."/>`
 *      element in the XML log encodes a 2496-byte (624-uint32)
 *      seed for an MT19937ar root PRNG.
 *   2. Decode base64 → 2496 bytes. Read each 4-byte block as a
 *      **little-endian** uint32, yielding the 624-element key.
 *      (The C++ reads big-endian then byte-reverses; net effect
 *      is a little-endian load.)
 *   3. Initialise MT19937ar with `init_by_array(key, 624)`.
 *   4. For each kyoku (hand), in order:
 *      a. Pull 288 uint32s from the root MT → `src` (1152 bytes).
 *      b. Hash 9 consecutive 128-byte slices of `src` with SHA-512;
 *         concatenate the 9 × 64-byte digests into a 576-byte
 *         buffer `rnd`. Read as 144 little-endian uint32s.
 *      c. Build `yama[i] = i` for `i ∈ [0,135]`, then for
 *         `i ∈ [0,134]`: `swap(yama[i], yama[i + (rnd[i] % (136-i))])`.
 *      d. `dice0 = rnd[135] % 6 + 1`, `dice1 = rnd[136] % 6 + 1`.
 *
 * The shuffled `yama[0..135]` is laid out (verified against
 * https://tenhou.net/stat/rand/validation.txt + a known replay):
 *   - `yama[135..84]` — dealt tiles, read **in reverse** in a
 *     4-4-4-1 pattern: `yama[135..132]` = seat 0's first 4,
 *     `yama[131..128]` = seat 1's first 4, ..., `yama[84]` =
 *     seat 3's 13th tile. (Tenhou's INIT publishes hai0..hai3 as
 *     a set so the adapter doesn't need to recompute them — but
 *     we expose `dealHandsFromYama` for verification.)
 *   - `yama[83..14]` — live wall, drawn **in reverse**: the
 *     first draw is `yama[83]`, the 70th is `yama[14]`. This is
 *     what we expose as the protocol-level `liveWall`.
 *   - `yama[13..0]` — dead wall (rinshan + dora/ura indicators).
 *
 * Implementation notes:
 *   - Uses Node's `crypto` (server-side only — the Tenhou adapter
 *     runs in the ingestion pipeline / replay route loader).
 *   - All uint32 math is performed with `>>> 0` and `Math.imul` to
 *     keep values in the unsigned 32-bit domain (JS numbers are
 *     float64 by default).
 */

import { createHash } from "node:crypto";

import type { Tile } from "~/game/protocol/messages";

// ---------------------------------------------------------------------------
// Tile id (0–135) → protocol Tile
// ---------------------------------------------------------------------------

const SUITS = ["m", "p", "s"] as const;

function tileFromId(id: number): Tile {
  if (id === 16) {
    return "0m" as Tile;
  }
  if (id === 52) {
    return "0p" as Tile;
  }
  if (id === 88) {
    return "0s" as Tile;
  }
  const type = Math.floor(id / 4);
  if (type < 27) {
    const suit = SUITS[Math.floor(type / 9)];
    const num = (type % 9) + 1;
    return `${num}${suit}` as Tile;
  }
  return `${type - 26}z` as Tile;
}

// ---------------------------------------------------------------------------
// MT19937ar — Matsumoto & Nishimura's "improved initialization" variant.
// Ported from mt19937ar.c (BSD-licensed, 2002/1/26 release).
// ---------------------------------------------------------------------------

const MT_N = 624;
const MT_M = 397;
const MATRIX_A = 0x9908b0df;
const UPPER_MASK = 0x80000000;
const LOWER_MASK = 0x7fffffff;

class MT19937ar {
  private readonly mt: Uint32Array = new Uint32Array(MT_N);
  private mti: number = MT_N + 1;

  initGenrand(s: number): void {
    this.mt[0] = s >>> 0;
    for (let i = 1; i < MT_N; i++) {
      // mt[i] = (1812433253 * (mt[i-1] ^ (mt[i-1] >> 30)) + i)
      const prev = this.mt[i - 1];
      const x = prev ^ (prev >>> 30);
      this.mt[i] = (Math.imul(1812433253, x) + i) >>> 0;
    }
    this.mti = MT_N;
  }

  initByArray(key: Uint32Array): void {
    this.initGenrand(19650218);
    let i = 1;
    let j = 0;
    let k = MT_N > key.length ? MT_N : key.length;
    for (; k > 0; k--) {
      // mt[i] = (mt[i] ^ ((mt[i-1] ^ (mt[i-1]>>30)) * 1664525)) + key[j] + j
      const prev = this.mt[i - 1];
      const mix = Math.imul(prev ^ (prev >>> 30), 1664525);
      this.mt[i] = ((this.mt[i] ^ mix) + key[j] + j) >>> 0;
      i++;
      j++;
      if (i >= MT_N) {
        this.mt[0] = this.mt[MT_N - 1];
        i = 1;
      }
      if (j >= key.length) {
        j = 0;
      }
    }
    for (k = MT_N - 1; k > 0; k--) {
      // mt[i] = (mt[i] ^ ((mt[i-1] ^ (mt[i-1]>>30)) * 1566083941)) - i
      const prev = this.mt[i - 1];
      const mix = Math.imul(prev ^ (prev >>> 30), 1566083941);
      this.mt[i] = ((this.mt[i] ^ mix) - i) >>> 0;
      i++;
      if (i >= MT_N) {
        this.mt[0] = this.mt[MT_N - 1];
        i = 1;
      }
    }
    this.mt[0] = 0x80000000;
    this.mti = MT_N;
  }

  genrandInt32(): number {
    if (this.mti >= MT_N) {
      const mag01 = [0, MATRIX_A];
      let y: number;
      let kk: number;
      for (kk = 0; kk < MT_N - MT_M; kk++) {
        y = (this.mt[kk] & UPPER_MASK) | (this.mt[kk + 1] & LOWER_MASK);
        this.mt[kk] = (this.mt[kk + MT_M] ^ (y >>> 1) ^ mag01[y & 0x1]) >>> 0;
      }
      for (; kk < MT_N - 1; kk++) {
        y = (this.mt[kk] & UPPER_MASK) | (this.mt[kk + 1] & LOWER_MASK);
        this.mt[kk] =
          (this.mt[kk + (MT_M - MT_N)] ^ (y >>> 1) ^ mag01[y & 0x1]) >>> 0;
      }
      y = (this.mt[MT_N - 1] & UPPER_MASK) | (this.mt[0] & LOWER_MASK);
      this.mt[MT_N - 1] =
        (this.mt[MT_M - 1] ^ (y >>> 1) ^ mag01[y & 0x1]) >>> 0;
      this.mti = 0;
    }
    let y = this.mt[this.mti++];
    y ^= y >>> 11;
    y = (y ^ ((y << 7) & 0x9d2c5680)) >>> 0;
    y = (y ^ ((y << 15) & 0xefc60000)) >>> 0;
    y ^= y >>> 18;
    return y >>> 0;
  }
}

// ---------------------------------------------------------------------------
// Wall generation
// ---------------------------------------------------------------------------

/** Strip the `mt19937ar-sha512-n288-base64,` prefix if present. */
function stripSeedPrefix(seedAttr: string): string {
  const comma = seedAttr.indexOf(",");
  return comma >= 0 ? seedAttr.slice(comma + 1) : seedAttr;
}

/** Decode a Tenhou seed-attribute base64 payload into a 624-uint32 key. */
function decodeRootKey(seedAttr: string): Uint32Array {
  const b64 = stripSeedPrefix(seedAttr).trim();
  // Tenhou's seeds are wrapped across multiple lines in the XML —
  // base64 decoders tolerate inner whitespace but we strip it
  // defensively in case the input is hand-edited.
  const bytes = Buffer.from(b64.replace(/\s+/g, ""), "base64");
  if (bytes.length < MT_N * 4) {
    throw new Error(
      `Tenhou SHUFFLE seed is too short: got ${bytes.length} bytes, expected ≥ ${MT_N * 4}.`
    );
  }
  const key = new Uint32Array(MT_N);
  for (let i = 0; i < MT_N; i++) {
    // Little-endian uint32 load (see header comment).
    key[i] = bytes.readUInt32LE(i * 4);
  }
  return key;
}

/** SHA-512 of `len` bytes from `src` starting at `srcOffset`. */
function sha512Bytes(src: Buffer, srcOffset: number, len: number): Buffer {
  const slice = src.subarray(srcOffset, srcOffset + len);
  return createHash("sha512").update(slice).digest();
}

export interface TenhouWall {
  /** Full shuffled 136-tile array (`yama[0..135]`) as protocol tiles. */
  yama: Tile[];
  /**
   * Live wall (`yama[52..121]`) in draw order — the next-to-be-drawn
   * tile is at index 0. Matches the protocol-level `liveWall`
   * convention used elsewhere (`app/game/rules/wall.ts`).
   */
  liveWall: Tile[];
  /** Dead wall (`yama[122..135]`). */
  deadWall: Tile[];
  /** Dice values 1–6, as Tenhou's INIT publishes them. */
  dice: [number, number];
}

/**
 * Generate the walls for the first `numKyoku` hands of a Tenhou
 * game, given the SHUFFLE seed attribute (with or without the
 * `mt19937ar-sha512-n288-base64,` prefix).
 *
 * Walls must be generated **in order** because each kyoku consumes
 * 288 uint32s from the shared root MT state.
 */
export function generateTenhouWalls(
  seedAttr: string,
  numKyoku: number
): TenhouWall[] {
  const key = decodeRootKey(seedAttr);
  const mt = new MT19937ar();
  mt.initByArray(key);

  const walls: TenhouWall[] = [];
  for (let kyoku = 0; kyoku < numKyoku; kyoku++) {
    // Step a: pull 288 uint32s from root MT into a 1152-byte buffer.
    // Each uint32 is laid out little-endian to match the C++ which
    // casts a uint32 array to a byte pointer on a LE machine.
    const src = Buffer.alloc(288 * 4);
    for (let i = 0; i < 288; i++) {
      src.writeUInt32LE(mt.genrandInt32(), i * 4);
    }

    // Step b: 9 SHA-512 hashes of 128-byte slices, concatenated
    // into a 576-byte buffer interpreted as 144 LE uint32s.
    const rndBytes = Buffer.alloc(9 * 64);
    for (let i = 0; i < 9; i++) {
      const digest = sha512Bytes(src, i * 128, 128);
      digest.copy(rndBytes, i * 64);
    }
    const rnd = new Uint32Array(144);
    for (let i = 0; i < 144; i++) {
      rnd[i] = rndBytes.readUInt32LE(i * 4);
    }

    // Step c: Fisher-Yates forward shuffle of [0..135].
    const yama = new Uint8Array(136);
    for (let i = 0; i < 136; i++) {
      yama[i] = i;
    }
    for (let i = 0; i < 135; i++) {
      const j = i + (rnd[i] % (136 - i));
      const tmp = yama[i];
      yama[i] = yama[j];
      yama[j] = tmp;
    }

    // Step d: dice (returned 1-indexed).
    const dice: [number, number] = [(rnd[135] % 6) + 1, (rnd[136] % 6) + 1];

    const tiles = Array.from(yama, tileFromId);
    // Live wall in draw order: `tiles[83]` is the first draw,
    // `tiles[14]` is the 70th. Reverse-slice yields the protocol
    // convention (`liveWall[0]` = next-to-be-drawn).
    const liveWall: Tile[] = [];
    for (let i = 83; i >= 14; i--) {
      liveWall.push(tiles[i]);
    }
    // Dead wall in array order (yama[0..13]).
    const deadWall = tiles.slice(0, 14);
    walls.push({
      yama: tiles,
      liveWall,
      deadWall,
      dice,
    });
  }
  return walls;
}

/**
 * Test-only: derive each player's starting 13-tile hand from a
 * shuffled `yama` using Tenhou's reverse 4-4-4-1 deal pattern.
 * Used to verify a generated wall against the `hai0..hai3`
 * published in the corresponding `<INIT>` element.
 *
 * The dealer always takes tiles first, so when `dealer !== 0` the
 * deal cycle rotates: `yama[135..132]` go to the dealer, the next
 * 4 to the player to their right (`(dealer + 1) % 4`), etc.
 */
export function dealHandsFromYama(
  yama: readonly Tile[],
  dealer: 0 | 1 | 2 | 3 = 0
): [Tile[], Tile[], Tile[], Tile[]] {
  const hands: [Tile[], Tile[], Tile[], Tile[]] = [[], [], [], []];
  // Walk yama backwards from 135. Three rounds of 4-tile blocks
  // per player (starting with the dealer), then one final tile each.
  let cursor = 135;
  for (let block = 0; block < 3; block++) {
    for (let offset = 0; offset < 4; offset++) {
      const seat = ((dealer + offset) % 4) as 0 | 1 | 2 | 3;
      for (let k = 0; k < 4; k++) {
        hands[seat].push(yama[cursor--]);
      }
    }
  }
  for (let offset = 0; offset < 4; offset++) {
    const seat = ((dealer + offset) % 4) as 0 | 1 | 2 | 3;
    hands[seat].push(yama[cursor--]);
  }
  return hands;
}
