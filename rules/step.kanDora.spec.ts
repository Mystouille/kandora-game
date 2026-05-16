/**
 * Kan-dora deferred reveal behavior.
 *
 * RuleSet flags:
 *   - `instantlyRevealDoraForMinkan` — daiminkan + shouminkan
 *   - `instantlyRevealDoraForAnkan`  — ankan
 *
 * When a flag is `true` (default), the new dora indicator is
 * pushed to `doraIndicators` and a `new_dora` event is emitted
 * inside the kan step itself. When `false`, the indicator is
 * captured (tile identity locked at kan time) but held in
 * `pendingKanDora`; the reveal is drained on the declarer's
 * next discard (regular or riichi).
 */

import { describe, expect, it } from "vitest";
import { createInitialState, type MatchState } from "./state";
import { resolveRuleSet } from "./ruleSet";
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

const FILLER = tiles("9p9p9p9p9p9p9p9p9p9p9p9p9p");

function craft(opts: {
  hands: Tile[][];
  turn: 0 | 1 | 2 | 3;
  phase: "awaiting_draw" | "awaiting_discard";
  lastDrawn?: Tile;
  lastDiscard?: { seat: 0 | 1 | 2 | 3; tile: Tile };
  instantMinkan: boolean;
  instantAnkan: boolean;
}): MatchState {
  const base = createInitialState(0);
  const discards: Tile[][] = [[], [], [], []];
  if (opts.lastDiscard) {
    discards[opts.lastDiscard.seat].push(opts.lastDiscard.tile);
  }
  const ruleSet = resolveRuleSet({
    instantlyRevealDoraForMinkan: opts.instantMinkan,
    instantlyRevealDoraForAnkan: opts.instantAnkan,
  });
  return {
    ...base,
    ruleSet,
    hands: opts.hands.map((h) => [...h]),
    discards,
    liveWall: Array.from({ length: 20 }, () => "1m" as Tile),
    doraIndicators: ["1m"],
    uraDoraIndicators: [],
    pendingKanDora: [],
    pendingKanUraDora: [],
    turn: opts.turn,
    phase: opts.phase,
    lastDrawn: [null, null, null, null].map((_, i) =>
      i === opts.turn && opts.lastDrawn ? opts.lastDrawn : null
    ) as (Tile | null)[],
    lastDiscard: opts.lastDiscard ?? null,
    melds: [[], [], [], []],
    lastHandResult: null,
  };
}

function rigDeadWall(state: MatchState, overrides: Record<number, Tile>): void {
  for (const [k, v] of Object.entries(overrides)) {
    state.deadWall[Number(k)] = v;
  }
}

describe("kan-dora — instantlyRevealDoraForMinkan", () => {
  it("defers daiminkan dora reveal when false: no new_dora on kan, captured to pending", () => {
    const seat2Hand = tiles("4m4m4m1p2p3p4p5p6p7p8p9p1s");
    const state = craft({
      hands: [FILLER, FILLER, seat2Hand, FILLER],
      turn: 1,
      phase: "awaiting_draw",
      lastDiscard: { seat: 0, tile: "4m" },
      instantMinkan: false,
      instantAnkan: true,
    });
    rigDeadWall(state, { 0: "9z", 6: "8z", 7: "7z" });
    const r = step(state, {
      type: "kan",
      seat: 2,
      kind: "daiminkan",
      tile: "4m",
    });
    // Call + rinshan draw events, but no new_dora yet.
    expect(r.events.some((e) => e.type === "new_dora")).toBe(false);
    expect(r.events.some((e) => e.type === "call")).toBe(true);
    expect(r.state.doraIndicators).toEqual(["1m"]);
    expect(r.state.pendingKanDora).toEqual(["8z"]);
    expect(r.state.pendingKanUraDora).toEqual(["7z"]);
  });

  it("reveals daiminkan dora instantly when true: new_dora in the kan step", () => {
    const seat2Hand = tiles("4m4m4m1p2p3p4p5p6p7p8p9p1s");
    const state = craft({
      hands: [FILLER, FILLER, seat2Hand, FILLER],
      turn: 1,
      phase: "awaiting_draw",
      lastDiscard: { seat: 0, tile: "4m" },
      instantMinkan: true,
      instantAnkan: true,
    });
    rigDeadWall(state, { 0: "9z", 6: "8z", 7: "7z" });
    const r = step(state, {
      type: "kan",
      seat: 2,
      kind: "daiminkan",
      tile: "4m",
    });
    expect(r.events.some((e) => e.type === "new_dora")).toBe(true);
    expect(r.state.doraIndicators).toEqual(["1m", "8z"]);
    expect(r.state.pendingKanDora).toEqual([]);
  });

  it("drains pending dora on the declarer's next discard", () => {
    // Start in the post-daiminkan state with one pending dora.
    const seat2Hand = tiles("4m4m4m4m1p2p3p4p5p6p7p8p9p"); // 14 after rinshan
    const state = craft({
      hands: [FILLER, FILLER, seat2Hand, FILLER],
      turn: 2,
      phase: "awaiting_discard",
      lastDrawn: "9z",
      instantMinkan: false,
      instantAnkan: true,
    });
    state.pendingKanDora = ["8z"];
    state.pendingKanUraDora = ["7z"];
    const r = step(state, { type: "discard", seat: 2, tile: "9p" });
    // Discard event first, then the drained new_dora.
    const types = r.events.map((e) => e.type);
    expect(types).toEqual(["discard", "new_dora"]);
    expect(r.state.doraIndicators).toEqual(["1m", "8z"]);
    expect(r.state.uraDoraIndicators).toEqual(["7z"]);
    expect(r.state.pendingKanDora).toEqual([]);
    expect(r.state.pendingKanUraDora).toEqual([]);
  });
});

describe("kan-dora — instantlyRevealDoraForAnkan", () => {
  it("defers ankan dora reveal when false: captured to pending", () => {
    const seat0Hand = tiles("4m4m4m4m1p2p3p4p5p6p7p8p9p1s");
    const state = craft({
      hands: [seat0Hand, FILLER, FILLER, FILLER],
      turn: 0,
      phase: "awaiting_discard",
      lastDrawn: "1s",
      instantMinkan: true,
      instantAnkan: false,
    });
    rigDeadWall(state, { 0: "9z", 6: "8z", 7: "7z" });
    const r = step(state, {
      type: "kan",
      seat: 0,
      kind: "ankan",
      tile: "4m",
    });
    expect(r.events.some((e) => e.type === "new_dora")).toBe(false);
    expect(r.state.doraIndicators).toEqual(["1m"]);
    expect(r.state.pendingKanDora).toEqual(["8z"]);
  });

  it("reveals ankan dora instantly when true", () => {
    const seat0Hand = tiles("4m4m4m4m1p2p3p4p5p6p7p8p9p1s");
    const state = craft({
      hands: [seat0Hand, FILLER, FILLER, FILLER],
      turn: 0,
      phase: "awaiting_discard",
      lastDrawn: "1s",
      instantMinkan: true,
      instantAnkan: true,
    });
    rigDeadWall(state, { 0: "9z", 6: "8z", 7: "7z" });
    const r = step(state, {
      type: "kan",
      seat: 0,
      kind: "ankan",
      tile: "4m",
    });
    expect(r.events.some((e) => e.type === "new_dora")).toBe(true);
    expect(r.state.doraIndicators).toEqual(["1m", "8z"]);
    expect(r.state.pendingKanDora).toEqual([]);
  });
});

describe("kan-dora — flags independent across kinds", () => {
  it("ankan deferred + minkan instant: each kind honors its own flag", () => {
    const seat2Hand = tiles("4m4m4m1p2p3p4p5p6p7p8p9p1s");
    const state = craft({
      hands: [FILLER, FILLER, seat2Hand, FILLER],
      turn: 1,
      phase: "awaiting_draw",
      lastDiscard: { seat: 0, tile: "4m" },
      instantMinkan: true,
      instantAnkan: false,
    });
    rigDeadWall(state, { 0: "9z", 6: "8z", 7: "7z" });
    const r = step(state, {
      type: "kan",
      seat: 2,
      kind: "daiminkan",
      tile: "4m",
    });
    // Minkan instant flag is on → reveal happens on the kan step.
    expect(r.events.some((e) => e.type === "new_dora")).toBe(true);
    expect(r.state.pendingKanDora).toEqual([]);
  });
});

describe("kan-dora — drains on riichi discard too", () => {
  it("pending dora drains alongside the riichi declaration discard", () => {
    // Tenpai hand with one drawn tile to riichi-discard.
    // Use a known-tenpai 14-tile hand: 234m 567m 234p 234s 1s + drawn 1s.
    const seat0Hand = tiles("2m3m4m5m6m7m2p3p4p2s3s4s1s1s");
    const state = craft({
      hands: [seat0Hand, FILLER, FILLER, FILLER],
      turn: 0,
      phase: "awaiting_discard",
      lastDrawn: "1s",
      instantMinkan: false,
      instantAnkan: false,
    });
    state.pendingKanDora = ["8z"];
    state.pendingKanUraDora = ["7z"];
    state.scores = [25000, 25000, 25000, 25000];
    const r = step(state, { type: "riichi", seat: 0, tile: "1s" });
    expect(r.events.length).toBeGreaterThan(0);
    const types = r.events.map((e) => e.type);
    expect(types).toContain("discard");
    expect(types).toContain("new_dora");
    expect(r.state.doraIndicators).toEqual(["1m", "8z"]);
    expect(r.state.pendingKanDora).toEqual([]);
  });
});
