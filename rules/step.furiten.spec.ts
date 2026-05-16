/**
 * Furiten tests:
 *   - **Self-discard furiten**: any wait tile sitting in the
 *     player's own discard pile blocks all rons (full-furiten).
 *   - **Riichi missed-ron furiten**: a riichi seat that does not
 *     ron on a passing wait tile is permanently locked into
 *     furiten for the rest of the hand. Implemented via the
 *     `furitenLocked` state field, set whenever the engine
 *     consumes `lastDiscard` (next draw or chi/pon/kan).
 *   - **Temporary missed-ron furiten**: a non-riichi seat that
 *     passes a winning discard is locked into furiten until
 *     their own next discard. Implemented via `furitenTemp`,
 *     set in `lockMissedRonFuriten` and cleared in the discard
 *     handler.
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
    furitenTemp: [false, false, false, false],
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
    // furitenLocked is reserved for riichi (permanent) seats.
    expect(next.furitenLocked).toEqual([false, false, false, false]);
    // ...but seat 1 IS now temp-locked until their own next discard.
    expect(next.furitenTemp[1]).toBe(true);
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

describe("furiten — temporary (non-riichi missed ron)", () => {
  it("blocks ron on a fresh tile while temp-locked", () => {
    // Seat 1 is not in riichi but had a wait on 7z (passed by
    // seat 0 last go-around). They are temp-locked. Now seat 2
    // discards 7z (a fresh copy not in seat 1's discards). The
    // ron must still be rejected.
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
        lastDiscard: { seat: 2, tile: "7z" },
      }),
      furitenTemp: [false, true, false, false],
    };
    const { state: next, events } = step(state, { type: "ron", seat: 1 });
    expect(next.phase).toBe("awaiting_draw");
    expect(events).toEqual([]);
  });

  it("temp lock is set on missed ron and cleared on own next discard", () => {
    // Seat 1 (not in riichi) is tenpai on 7z. Seat 0 discards 7z;
    // seat 1 passes. Next draw fires → seat 1 is temp-locked.
    const concealed = tiles("11m22p33s44m55p66s");
    const tenpai = [...concealed, "7z"] as Tile[];
    const afterPass = craft({
      hands: [
        tiles("9p9p9p9p9p9p9p9p9p9p9p9p9p"),
        tenpai,
        tiles("9p9p9p9p9p9p9p9p9p9p9p9p9p"),
        tiles("9p9p9p9p9p9p9p9p9p9p9p9p9p"),
      ],
      turn: 2,
      phase: "awaiting_draw",
      dealer: 0,
      lastDiscard: { seat: 0, tile: "7z" },
      riichiDeclared: [false, false, false, false],
    });
    const { state: drawn } = step(afterPass, { type: "draw", seat: 2 });
    expect(drawn.furitenTemp[1]).toBe(true);

    // Play forward until seat 1 has their own discard. Each seat
    // discards the freshly drawn 1m (tsumogiri).
    const after2Discard = step(drawn, {
      type: "discard",
      seat: 2,
      tile: drawn.lastDrawn[2] as Tile,
    }).state;
    const after3Draw = step(after2Discard, { type: "draw", seat: 3 }).state;
    const after3Discard = step(after3Draw, {
      type: "discard",
      seat: 3,
      tile: after3Draw.lastDrawn[3] as Tile,
    }).state;
    const after0Draw = step(after3Discard, { type: "draw", seat: 0 }).state;
    const after0Discard = step(after0Draw, {
      type: "discard",
      seat: 0,
      tile: after0Draw.lastDrawn[0] as Tile,
    }).state;
    const seat1Drawn = step(after0Discard, { type: "draw", seat: 1 }).state;
    // Temp lock is still active up to (and during) seat 1's draw.
    expect(seat1Drawn.furitenTemp[1]).toBe(true);
    // Discard the freshly drawn tile (tsumogiri). Temp lock clears.
    const seat1Discarded = step(seat1Drawn, {
      type: "discard",
      seat: 1,
      tile: seat1Drawn.lastDrawn[1] as Tile,
    }).state;
    expect(seat1Discarded.furitenTemp[1]).toBe(false);
  });

  it("riichi seats use the permanent lock instead of the temp lock", () => {
    // Same scenario as the temp-lock test but with riichi declared
    // for seat 1 → `furitenLocked[1]` should be set, NOT
    // `furitenTemp[1]`.
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
    expect(next.furitenTemp[1]).toBe(false);
  });
});

describe("furiten — step emits `furitenChanges` on transitions", () => {
  it("emits an `active: true` change when a seat enters temp furiten", () => {
    // Seat 1 (not in riichi) is tenpai on 7z. Seat 0 discards 7z;
    // seat 1 passes; seat 2's `draw` step triggers
    // `lockMissedRonFuriten`, flipping seat 1's furiten status.
    const concealed = tiles("11m22p33s44m55p66s");
    const tenpai = [...concealed, "7z"] as Tile[];
    const afterPass = craft({
      hands: [
        tiles("9p9p9p9p9p9p9p9p9p9p9p9p9p"),
        tenpai,
        tiles("9p9p9p9p9p9p9p9p9p9p9p9p9p"),
        tiles("9p9p9p9p9p9p9p9p9p9p9p9p9p"),
      ],
      turn: 2,
      phase: "awaiting_draw",
      dealer: 0,
      lastDiscard: { seat: 0, tile: "7z" },
    });
    const res = step(afterPass, { type: "draw", seat: 2 });
    expect(res.furitenChanges).toEqual([{ seat: 1, active: true }]);
  });

  it("emits `active: false` when a seat clears temp furiten on own discard", () => {
    // Drive the same fixture forward until seat 1 discards their
    // tsumogiri tile, which clears `furitenTemp[1]`. The clearing
    // step must surface a `furiten: { seat: 1, active: false }` change.
    const concealed = tiles("11m22p33s44m55p66s");
    const tenpai = [...concealed, "7z"] as Tile[];
    const afterPass = craft({
      hands: [
        tiles("9p9p9p9p9p9p9p9p9p9p9p9p9p"),
        tenpai,
        tiles("9p9p9p9p9p9p9p9p9p9p9p9p9p"),
        tiles("9p9p9p9p9p9p9p9p9p9p9p9p9p"),
      ],
      turn: 2,
      phase: "awaiting_draw",
      dealer: 0,
      lastDiscard: { seat: 0, tile: "7z" },
    });
    const s1 = step(afterPass, { type: "draw", seat: 2 }).state;
    const s2 = step(s1, {
      type: "discard",
      seat: 2,
      tile: s1.lastDrawn[2] as Tile,
    }).state;
    const s3 = step(s2, { type: "draw", seat: 3 }).state;
    const s4 = step(s3, {
      type: "discard",
      seat: 3,
      tile: s3.lastDrawn[3] as Tile,
    }).state;
    const s5 = step(s4, { type: "draw", seat: 0 }).state;
    const s6 = step(s5, {
      type: "discard",
      seat: 0,
      tile: s5.lastDrawn[0] as Tile,
    }).state;
    const s7 = step(s6, { type: "draw", seat: 1 }).state;
    // Seat 1 is still in temp furiten through their own draw.
    expect(s7.furitenTemp[1]).toBe(true);
    // Discarding clears it AND the step exposes the transition.
    const clearRes = step(s7, {
      type: "discard",
      seat: 1,
      tile: s7.lastDrawn[1] as Tile,
    });
    expect(clearRes.state.furitenTemp[1]).toBe(false);
    expect(clearRes.furitenChanges).toEqual([{ seat: 1, active: false }]);
  });

  it("omits `furitenChanges` when no seat's status flips", () => {
    // Fresh deal: nobody is tenpai → a plain draw produces no
    // furiten transitions. `furitenChanges` is left absent rather
    // than set to an empty array (keeps the typical hot-path
    // event-array assertions clean).
    const state = createInitialState(1);
    const res = step(state, { type: "draw", seat: state.turn });
    expect(res.events).toHaveLength(1);
    expect(res.furitenChanges).toBeUndefined();
  });
});
