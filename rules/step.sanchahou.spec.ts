/**
 * Tests for sanchahou (triple-ron abort).
 *
 * The orchestrator dispatches `{ type: "abort", kind: "sanchahou" }`
 * when three opponents declare ron on the same discard and the
 * `aborts.sanchahou` rule is enabled. The engine emits a single
 * `hand_end` with `reason: "abort"`, no scoring, and leaves the
 * riichi sticks on the table for the next hand to collect.
 */

import { describe, expect, it } from "vitest";
import { createInitialState, type MatchState } from "./state";
import { step } from "./step";
import type { Tile } from "./types";

function craft(opts: {
  riichiSticks?: number;
  ruleSetSanchahou?: boolean;
  lastDiscard?: { seat: 0 | 1 | 2 | 3; tile: Tile } | null;
  scores?: [number, number, number, number];
}): MatchState {
  const base = createInitialState(
    0,
    opts.ruleSetSanchahou === false
      ? { ruleSet: { aborts: { sanchahou: false } } }
      : undefined
  );
  return {
    ...base,
    phase: "awaiting_draw",
    turn: 1,
    dealer: 0,
    lastDiscard:
      opts.lastDiscard === undefined
        ? { seat: 0, tile: "1z" }
        : opts.lastDiscard,
    riichiSticks: opts.riichiSticks ?? 0,
    scores: opts.scores ?? [25000, 25000, 25000, 25000],
  };
}

describe("step — sanchahou (triple-ron abort)", () => {
  it("emits hand_end with reason=abort and abortKind=sanchahou", () => {
    const state = craft({});
    const r = step(state, { type: "abort", seat: 1, kind: "sanchahou" });
    expect(r.events.map((e) => e.type)).toEqual(["hand_end"]);
    expect(r.events[0]).toMatchObject({
      type: "hand_end",
      reason: "abort",
      abortKind: "sanchahou",
      delta: [0, 0, 0, 0],
    });
    expect(r.state.phase).toBe("hand_ended");
    expect(r.state.lastHandResult).toMatchObject({
      reason: "abort",
      abortKind: "sanchahou",
      delta: [0, 0, 0, 0],
      winner: null,
      loser: null,
    });
  });

  it("preserves riichi sticks for the next hand", () => {
    const state = craft({ riichiSticks: 2 });
    const r = step(state, { type: "abort", seat: 1, kind: "sanchahou" });
    expect(r.state.riichiSticks).toBe(2);
    expect(r.state.scores).toEqual([25000, 25000, 25000, 25000]);
  });

  it("dealer keeps and honba advances on the next hand", () => {
    const state = craft({});
    const after = step(state, { type: "abort", seat: 1, kind: "sanchahou" });
    const next = step(after.state, { type: "start_next_hand" });
    expect(next.state.dealer).toBe(0);
    expect(next.state.honba).toBe(1);
  });

  it("rejects when sanchahou rule is disabled", () => {
    const state = craft({ ruleSetSanchahou: false });
    const r = step(state, { type: "abort", seat: 1, kind: "sanchahou" });
    expect(r.events).toEqual([]);
    expect(r.state.phase).toBe("awaiting_draw");
  });

  it("rejects when there is no recent discard", () => {
    const state = craft({ lastDiscard: null });
    const r = step(state, { type: "abort", seat: 1, kind: "sanchahou" });
    expect(r.events).toEqual([]);
  });
});
