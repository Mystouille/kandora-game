/**
 * Tests for haitei raoyue (last-tile tsumo) and houtei raoyui
 * (last-discard ron), plus the rinshan / haitei collision when the
 * kan happens with an already-empty live wall.
 *
 * The engine sets `state.lastDrawFromDeadWall` at every draw site;
 * the tsumo handler combines that with `liveWall.length === 0` to
 * award haitei vs rinshan correctly, and the ron handler awards
 * houtei whenever the live wall is empty and the win is not a
 * chankan.
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

/**
 * Build a state where the live wall is already empty and seats
 * have a discard pile, so the first-uninterrupted-go-around check
 * fails (no tenhou/chiihou interference).
 */
function craftEndOfWallState(opts: {
  hands: Tile[][];
  turn: 0 | 1 | 2 | 3;
  phase: "awaiting_draw" | "awaiting_discard";
  dealer?: 0 | 1 | 2 | 3;
  lastDrawn?: Tile;
  lastDiscard?: { seat: 0 | 1 | 2 | 3; tile: Tile };
  liveWall?: Tile[];
  lastDrawFromDeadWall?: boolean;
}): MatchState {
  const base = createInitialState(0);
  const dealer = opts.dealer ?? 0;
  // A non-empty discard pile per seat is enough to break the
  // first-go-around predicate (which would otherwise hand out
  // tenhou/chiihou/renhou and swamp the haitei han delta).
  const filler: Tile = "8m";
  const discards: Tile[][] = [[filler], [filler], [filler], [filler]];
  return {
    ...base,
    hands: opts.hands.map((h) => [...h]),
    discards,
    liveWall: opts.liveWall ?? [],
    turn: opts.turn,
    phase: opts.phase,
    dealer,
    lastDrawn: [null, null, null, null].map((_, i) =>
      i === opts.turn && opts.lastDrawn ? opts.lastDrawn : null
    ) as (Tile | null)[],
    lastDrawFromDeadWall: opts.lastDrawFromDeadWall ?? false,
    lastDiscard: opts.lastDiscard ?? null,
    lastHandResult: null,
  };
}

describe("step — haitei / houtei", () => {
  it("awards haitei on tsumo when the live wall is empty", () => {
    // Chiitoitsu shape so the win is unambiguous; non-dealer seat
    // 1 tsumo on 7z.
    const concealed = tiles("11m22p33s44m55p66s7z");
    const winTile: Tile = "7z";
    const state = craftEndOfWallState({
      hands: [
        tiles("9p9p9p9p9p9p9p9p9p9p9p9p9p"),
        [...concealed, winTile],
        tiles("9p9p9p9p9p9p9p9p9p9p9p9p9p"),
        tiles("9p9p9p9p9p9p9p9p9p9p9p9p9p"),
      ],
      turn: 1,
      phase: "awaiting_discard",
      dealer: 0,
      lastDrawn: winTile,
      liveWall: [],
      lastDrawFromDeadWall: false,
    });
    const { events } = step(state, { type: "tsumo", seat: 1 });
    const winEv = events.find((e) => e.type === "win");
    if (winEv?.type !== "win") {
      throw new Error("expected win event");
    }
    expect(winEv.score.isAgari).toBe(true);
    // chiitoitsu(2) + tsumo(1) + haitei(1) = 4 han.
    expect(winEv.score.han).toBe(4);
    expect(winEv.score.yaku["海底摸月"]).toBeDefined();
  });

  it("does NOT award haitei when the empty-wall tsumo is a rinshan draw", () => {
    // Same shape, but the tsumo is from a dead-wall replacement
    // after a kan — should be rinshan kaihou, not haitei.
    const concealed = tiles("11m22p33s44m55p66s7z");
    const winTile: Tile = "7z";
    const state = craftEndOfWallState({
      hands: [
        tiles("9p9p9p9p9p9p9p9p9p9p9p9p9p"),
        [...concealed, winTile],
        tiles("9p9p9p9p9p9p9p9p9p9p9p9p9p"),
        tiles("9p9p9p9p9p9p9p9p9p9p9p9p9p"),
      ],
      turn: 1,
      phase: "awaiting_discard",
      dealer: 0,
      lastDrawn: winTile,
      liveWall: [],
      lastDrawFromDeadWall: true,
    });
    const { events } = step(state, { type: "tsumo", seat: 1 });
    const winEv = events.find((e) => e.type === "win");
    if (winEv?.type !== "win") {
      throw new Error("expected win event");
    }
    // chiitoitsu doesn't validly combine with rinshan (no kan in
    // the hand) — the riichi lib drops the rinshan flag, so han
    // stays at chiitoitsu(2) + tsumo(1) = 3. The key assertion is
    // that haitei is NOT awarded even with an empty live wall.
    expect(winEv.score.han).toBe(3);
    expect(winEv.score.yaku["海底摸月"]).toBeUndefined();
  });

  it("does NOT award haitei when the live wall still has tiles", () => {
    const concealed = tiles("11m22p33s44m55p66s7z");
    const winTile: Tile = "7z";
    const state = craftEndOfWallState({
      hands: [
        tiles("9p9p9p9p9p9p9p9p9p9p9p9p9p"),
        [...concealed, winTile],
        tiles("9p9p9p9p9p9p9p9p9p9p9p9p9p"),
        tiles("9p9p9p9p9p9p9p9p9p9p9p9p9p"),
      ],
      turn: 1,
      phase: "awaiting_discard",
      dealer: 0,
      lastDrawn: winTile,
      liveWall: Array.from({ length: 3 }, () => "1m" as Tile),
    });
    const { events } = step(state, { type: "tsumo", seat: 1 });
    const winEv = events.find((e) => e.type === "win");
    if (winEv?.type !== "win") {
      throw new Error("expected win event");
    }
    expect(winEv.score.han).toBe(3); // chiitoitsu + tsumo, no haitei.
    expect(winEv.score.yaku["海底摸月"]).toBeUndefined();
  });

  it("awards houtei on ron when the live wall is empty", () => {
    const winner = tiles("11m22p33s44m55p66s7z");
    const state = craftEndOfWallState({
      hands: [
        tiles("9p9p9p9p9p9p9p9p9p9p9p9p9p"),
        winner,
        tiles("9p9p9p9p9p9p9p9p9p9p9p9p9p"),
        tiles("9p9p9p9p9p9p9p9p9p9p9p9p9p"),
      ],
      turn: 1,
      phase: "awaiting_draw",
      dealer: 0,
      lastDiscard: { seat: 0, tile: "7z" },
      liveWall: [],
    });
    const { events } = step(state, { type: "ron", seat: 1 });
    const winEv = events.find((e) => e.type === "win");
    if (winEv?.type !== "win") {
      throw new Error("expected win event");
    }
    // chiitoitsu(2) + houtei(1) = 3 han.
    expect(winEv.score.han).toBe(3);
    expect(winEv.score.yaku["河底撈魚"]).toBeDefined();
  });

  it("does NOT award houtei when the live wall still has tiles", () => {
    const winner = tiles("11m22p33s44m55p66s7z");
    const state = craftEndOfWallState({
      hands: [
        tiles("9p9p9p9p9p9p9p9p9p9p9p9p9p"),
        winner,
        tiles("9p9p9p9p9p9p9p9p9p9p9p9p9p"),
        tiles("9p9p9p9p9p9p9p9p9p9p9p9p9p"),
      ],
      turn: 1,
      phase: "awaiting_draw",
      dealer: 0,
      lastDiscard: { seat: 0, tile: "7z" },
      liveWall: Array.from({ length: 5 }, () => "1m" as Tile),
    });
    const { events } = step(state, { type: "ron", seat: 1 });
    const winEv = events.find((e) => e.type === "win");
    if (winEv?.type !== "win") {
      throw new Error("expected win event");
    }
    expect(winEv.score.han).toBe(2); // chiitoitsu only.
    expect(winEv.score.yaku["河底撈魚"]).toBeUndefined();
  });
});
