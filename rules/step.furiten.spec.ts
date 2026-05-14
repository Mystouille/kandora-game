/**
 * Furiten tests:
 *   - **Self-discard furiten**: any wait tile sitting in the
 *     player's own discard pile blocks all rons (full-furiten).
 *   - **Riichi missed-ron furiten**: a riichi seat that does not
 *     ron on a passing wait tile is permanently locked into
 *     furiten for the rest of the hand. Implemented via the
 *     `furitenLocked` state field, set whenever the engine
 *     consumes `lastDiscard` (next draw or chi/pon/kan).
 *
 * Non-riichi temporary furiten (between missed ron and next own
 * discard) is not enforced as a permanent lock; the on-demand
 * self-discard check still catches the most common variant
 * once the ronnable tile sits in the player's own discards.
 */

import { describe, expect, it } from "vitest";
import { createInitialState, type MatchState } from "./state";
import { step } from "./step";
import type { Tile } from "./types";

function tiles(s: string): Tile[] {
  const out: Tile[] = [];
  let digits = "";
  for (const ch of s) {
    if (ch >= "0" && ch <= "9") {
      digits += ch;
    } else {
      for (const d of digits) {
        out.push(`${d}${ch}`);
      }
      digits = "";
    }
  }
  return out;
}

function craft(opts: {
  hands: Tile[][];
  discards?: Tile[][];
  turn: 0 | 1 | 2 | 3;
  phase: "awaiting_draw" | "awaiting_discard";
  dealer?: 0 | 1 | 2 | 3;
  lastDiscard?: { seat: 0 | 1 | 2 | 3; tile: Tile };
  riichiDeclared?: [boolean, boolean, boolean, boolean];
}): MatchState {
  const base = createInitialState(0);
  const dealer = opts.dealer ?? 0;
  return {
    ...base,
    hands: opts.hands.map((h) => [...h]),
    discards: opts.discards?.map((d) => [...d]) ?? [[], [], [], []],
    liveWall: Array.from({ length: 30 }, () => "1m" as Tile),
    turn: opts.turn,
    phase: opts.phase,
    dealer,
    lastDiscard: opts.lastDiscard ?? null,
    riichiDeclared: opts.riichiDeclared ?? [false, false, false, false],
    doraIndicators: [],
    uraDoraIndicators: [],
    scores: [25000, 25000, 25000, 25000],
    lastHandResult: null,
    furitenLocked: [false, false, false, false],
  };
}

describe("furiten — self-discard", () => {
  it("rejects ron when a wait tile sits in own discard pile", () => {
    // Seat 1 chiitoitsu waiting on 7z. They have a 7z in their own
    // discards → permanent self-discard furiten on this hand.
    const concealed = tiles("11m22p33s44m55p66s");
    const winTile: Tile = "7z";
    const state = craft({
      hands: [
        tiles("9p9p9p9p9p9p9p9p9p9p9p9p9p"),
        [...concealed, "7z"], // 13-tile tenpai
        tiles("9p9p9p9p9p9p9p9p9p9p9p9p9p"),
        tiles("9p9p9p9p9p9p9p9p9p9p9p9p9p"),
      ],
      discards: [[], ["7z"], [], []],
      turn: 1,
      phase: "awaiting_draw",
      dealer: 0,
      lastDiscard: { seat: 0, tile: winTile },
    });
    const { state: next, events } = step(state, { type: "ron", seat: 1 });
    // Action rejected → no state change, no events.
    expect(next.phase).toBe("awaiting_draw");
    expect(events).toEqual([]);
  });

  it("allows ron when no wait is in own discards", () => {
    const concealed = tiles("11m22p33s44m55p66s");
    const winTile: Tile = "7z";
    const state = craft({
      hands: [
        tiles("9p9p9p9p9p9p9p9p9p9p9p9p9p"),
        [...concealed, "7z"],
        tiles("9p9p9p9p9p9p9p9p9p9p9p9p9p"),
        tiles("9p9p9p9p9p9p9p9p9p9p9p9p9p"),
      ],
      discards: [[], ["1z", "2z"], [], []],
      turn: 1,
      phase: "awaiting_draw",
      dealer: 0,
      lastDiscard: { seat: 0, tile: winTile },
    });
    const { state: next } = step(state, { type: "ron", seat: 1 });
    expect(next.phase).toBe("hand_ended");
  });
});

describe("furiten — riichi missed-ron lock", () => {
  it("locks riichi seat after passing a winning discard", () => {
    // Seat 1 in riichi, waiting on 7z. Seat 0 discards 7z; seat 1
    // does not ron. Seat 2 then draws → engine should set
    // furitenLocked[1] = true.
    const concealed = tiles("11m22p33s44m55p66s");
    const state = craft({
      hands: [
        tiles("9p9p9p9p9p9p9p9p9p9p9p9p9p"),
        [...concealed, "7z"],
        tiles("9p9p9p9p9p9p9p9p9p9p9p9p9p"),
        tiles("9p9p9p9p9p9p9p9p9p9p9p9p9p"),
      ],
      turn: 2,
      phase: "awaiting_draw",
      dealer: 0,
      lastDiscard: { seat: 0, tile: "7z" },
      riichiDeclared: [false, true, false, false],
    });
    const { state: next } = step(state, { type: "draw", seat: 2 });
    expect(next.furitenLocked[1]).toBe(true);
    // The lock should now block any future ron by seat 1.
  });

  it("does NOT lock non-riichi seats on missed ron (temporary only)", () => {
    const concealed = tiles("11m22p33s44m55p66s");
    const state = craft({
      hands: [
        tiles("9p9p9p9p9p9p9p9p9p9p9p9p9p"),
        [...concealed, "7z"],
        tiles("9p9p9p9p9p9p9p9p9p9p9p9p9p"),
        tiles("9p9p9p9p9p9p9p9p9p9p9p9p9p"),
      ],
      turn: 2,
      phase: "awaiting_draw",
      dealer: 0,
      lastDiscard: { seat: 0, tile: "7z" },
      riichiDeclared: [false, false, false, false],
    });
    const { state: next } = step(state, { type: "draw", seat: 2 });
    expect(next.furitenLocked).toEqual([false, false, false, false]);
  });

  it("furitenLocked blocks future ron even on a fresh tile", () => {
    // Seat 1 already locked from a prior missed ron. Even though
    // the new winning tile (7z) is not in their discards and they
    // are not in riichi anymore (hypothetically), the lock stands.
    const concealed = tiles("11m22p33s44m55p66s");
    const state: MatchState = {
      ...craft({
        hands: [
          tiles("9p9p9p9p9p9p9p9p9p9p9p9p9p"),
          [...concealed, "7z"],
          tiles("9p9p9p9p9p9p9p9p9p9p9p9p9p"),
          tiles("9p9p9p9p9p9p9p9p9p9p9p9p9p"),
        ],
        turn: 1,
        phase: "awaiting_draw",
        dealer: 0,
        lastDiscard: { seat: 0, tile: "7z" },
      }),
      furitenLocked: [false, true, false, false],
    };
    const { state: next, events } = step(state, { type: "ron", seat: 1 });
    expect(next.phase).toBe("awaiting_draw");
    expect(events).toEqual([]);
  });
});

describe("furiten — call paths preserve the lock", () => {
  it("furitenLocked persists across pon", () => {
    // After a pon by seat 2, the engine still tracks furitenLocked.
    // Seat 1 was locked; meld by seat 2 must not clear it.
    const state: MatchState = {
      ...craft({
        hands: [
          tiles("9p9p9p9p9p9p9p9p9p9p9p9p9p"),
          tiles("1m1m2p2p3s3s4m4m5p5p6s6s7z"),
          tiles("9p9p9p9p9p9p9p9p9p9p9p9p9p"),
          tiles("9p9p9p9p9p9p9p9p9p9p9p9p9p"),
        ],
        turn: 1,
        phase: "awaiting_draw",
        dealer: 0,
        lastDiscard: { seat: 0, tile: "9p" },
      }),
      furitenLocked: [false, true, false, false],
    };
    const { state: next } = step(state, {
      type: "pon",
      seat: 2,
      tiles: ["9p", "9p"],
    });
    expect(next.furitenLocked[1]).toBe(true);
  });
});
