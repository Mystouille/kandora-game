/**
 * RuleSet — toggle smoke tests covering the gates that didn't have
 * dedicated coverage before:
 *   - Hanchan E→S progression
 *   - `aborts.*` flags
 *   - `doubleRiichi`, `ippatsu`, `kanDora` flags
 */

import { describe, expect, it } from "vitest";
import { createInitialState, type MatchState } from "./state";
import type { RuleSetOverride } from "./ruleSet";
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

const FILLER13 = tiles("9p9p9p9p9p9p9p9p9p9p9p9p9p");

function craft(opts: {
  hands: Tile[][];
  turn: 0 | 1 | 2 | 3;
  phase: "awaiting_draw" | "awaiting_discard";
  dealer?: 0 | 1 | 2 | 3;
  lastDrawn?: Tile;
  liveWall?: Tile[];
  discards?: Tile[][];
  riichiDeclared?: [boolean, boolean, boolean, boolean];
  ruleSet?: RuleSetOverride;
}): MatchState {
  const base = createInitialState(0, { ruleSet: opts.ruleSet });
  return {
    ...base,
    hands: opts.hands.map((h) => [...h]),
    discards: opts.discards ?? [[], [], [], []],
    liveWall: opts.liveWall ?? Array.from({ length: 30 }, () => "1m" as Tile),
    doraIndicators: [],
    uraDoraIndicators: [],
    turn: opts.turn,
    phase: opts.phase,
    dealer: opts.dealer ?? 0,
    lastDrawn: [null, null, null, null].map((_, i) =>
      i === opts.turn && opts.lastDrawn ? opts.lastDrawn : null
    ) as (Tile | null)[],
    lastDiscard: null,
    riichiDeclared: opts.riichiDeclared ?? [false, false, false, false],
    doubleRiichi: [false, false, false, false],
    ippatsuEligible: [false, false, false, false],
    melds: [[], [], [], []],
    lastHandResult: null,
  };
}

describe("ruleSet — defaults", () => {
  it("createInitialState defaults to hanchan (roundWindCount=2)", () => {
    const s = createInitialState(0);
    expect(s.ruleSet.roundWindCount).toBe(2);
    expect(s.ruleSet.roundLimit).toBe(4);
    expect(s.ruleSet.aborts.kyuushuu).toBe(true);
  });

  it("partial overrides preserve other fields and merge aborts", () => {
    const s = createInitialState(0, {
      ruleSet: { aborts: { kyuushuu: false } },
    });
    expect(s.ruleSet.aborts.kyuushuu).toBe(false);
    expect(s.ruleSet.aborts.suufonRenda).toBe(true);
    expect(s.ruleSet.aborts.suuchaRiichi).toBe(true);
    expect(s.ruleSet.ippatsu).toBe(true);
  });
});

describe("ruleSet — hanchan E→S progression", () => {
  it("rolls over to South 1 after East 4 non-dealer win", () => {
    const base = craft({
      hands: [FILLER13, FILLER13, FILLER13, FILLER13],
      turn: 0,
      phase: "awaiting_draw",
    });
    const state: MatchState = {
      ...base,
      phase: "hand_ended",
      roundWind: "E",
      roundNumber: 4,
      dealer: 3,
      lastHandResult: {
        reason: "ron",
        winner: 0,
        loser: 3,
        delta: [8000, 0, 0, -8000],
        tenpai: null,
        abortKind: null,
        winHan: 1,
        winYakuman: false,
      },
    };
    const r = step(state, { type: "start_next_hand" });
    expect(r.state.phase).toBe("awaiting_draw");
    expect(r.state.roundWind).toBe("S");
    expect(r.state.roundNumber).toBe(1);
    expect(r.state.dealer).toBe(0);
  });
});

describe("ruleSet — aborts gating", () => {
  it("kyuushuu rejected when aborts.kyuushuu = false", () => {
    const opener = tiles("1m9m1p9p1s9s1z2z3z4z5z6z7z2m");
    const state = craft({
      hands: [opener, FILLER13, FILLER13, FILLER13],
      turn: 0,
      phase: "awaiting_discard",
      dealer: 0,
      lastDrawn: "2m",
      ruleSet: { aborts: { kyuushuu: false } },
    });
    const r = step(state, { type: "abort", seat: 0, kind: "kyuushuu" });
    expect(r.events).toEqual([]);
  });

  it("suufon renda does not fire when aborts.suufonRenda = false", () => {
    const seat3Hand = tiles("1z2m3m4m5m6m7m8m9m1p2p3p4p1s");
    const discards: Tile[][] = [["1z"], ["1z"], ["1z"], []];
    const state = craft({
      hands: [FILLER13, FILLER13, FILLER13, seat3Hand],
      turn: 3,
      phase: "awaiting_discard",
      dealer: 0,
      lastDrawn: "1z",
      discards,
      ruleSet: { aborts: { suufonRenda: false } },
    });
    const r = step(state, { type: "discard", seat: 3, tile: "1z" });
    expect(r.events.map((e) => e.type)).toEqual(["discard"]);
    expect(r.state.phase).toBe("awaiting_draw");
  });

  it("suucha riichi does not fire when aborts.suuchaRiichi = false", () => {
    const seat3Hand = tiles("234m234p234s11z67m5m");
    const state = craft({
      hands: [FILLER13, FILLER13, FILLER13, seat3Hand],
      turn: 3,
      phase: "awaiting_discard",
      dealer: 0,
      lastDrawn: "5m",
      riichiDeclared: [true, true, true, false],
      ruleSet: { aborts: { suuchaRiichi: false } },
    });
    const r = step(state, { type: "riichi", seat: 3, tile: "5m" });
    expect(r.events.map((e) => e.type)).toEqual(["discard"]);
    expect(r.state.riichiDeclared).toEqual([true, true, true, true]);
    expect(r.state.phase).toBe("awaiting_draw");
  });
});

describe("ruleSet — flag gates", () => {
  it("doubleRiichi=false does not stamp the flag on first-turn riichi", () => {
    const seat0Hand = tiles("234m234p234s11z67m5m");
    const state = craft({
      hands: [seat0Hand, FILLER13, FILLER13, FILLER13],
      turn: 0,
      phase: "awaiting_discard",
      dealer: 0,
      lastDrawn: "5m",
      ruleSet: { doubleRiichi: false },
    });
    const r = step(state, { type: "riichi", seat: 0, tile: "5m" });
    expect(r.events.map((e) => e.type)).toEqual(["discard"]);
    expect(r.state.riichiDeclared[0]).toBe(true);
    expect(r.state.doubleRiichi[0]).toBe(false);
  });

  it("ippatsu=false leaves ippatsuEligible cleared after riichi", () => {
    const seat0Hand = tiles("234m234p234s11z67m5m");
    const state = craft({
      hands: [seat0Hand, FILLER13, FILLER13, FILLER13],
      turn: 0,
      phase: "awaiting_discard",
      dealer: 0,
      lastDrawn: "5m",
      ruleSet: { ippatsu: false },
    });
    const r = step(state, { type: "riichi", seat: 0, tile: "5m" });
    expect(r.state.riichiDeclared[0]).toBe(true);
    expect(r.state.ippatsuEligible[0]).toBe(false);
  });
});
