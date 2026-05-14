import { describe, expect, it } from "vitest";
import type { Action } from "./actions";
import { createInitialState } from "./state";
import { step, type EngineEvent } from "./step";
import type { Seat } from "./types";

function play(
  seed: number,
  pickDiscard: (
    state: ReturnType<typeof createInitialState>,
    seat: Seat
  ) => string
): {
  events: EngineEvent[];
  finalState: ReturnType<typeof createInitialState>;
} {
  let state = createInitialState(seed);
  const events: EngineEvent[] = [];
  // Hard cap: 70 draws + 70 discards + 1 hand_end = 141 events.
  for (
    let i = 0;
    i < 200 && state.phase !== "hand_ended" && state.phase !== "match_ended";
    i++
  ) {
    const action: Action =
      state.phase === "awaiting_draw"
        ? { type: "draw", seat: state.turn }
        : {
            type: "discard",
            seat: state.turn,
            tile: pickDiscard(state, state.turn),
          };
    const result = step(state, action);
    state = result.state;
    events.push(...result.events);
  }
  return { events, finalState: state };
}

describe("step — draw/discard loop", () => {
  it("creates initial state with 4×13 hands and a 70-tile live wall", () => {
    const s = createInitialState(42);
    expect(s.hands.map((h) => h.length)).toEqual([13, 13, 13, 13]);
    expect(s.liveWall.length).toBe(70);
    expect(s.phase).toBe("awaiting_draw");
    expect(s.turn).toBe(0);
  });

  it("draw advances phase and grows the active hand to 14", () => {
    const s0 = createInitialState(1);
    const { state, events } = step(s0, { type: "draw", seat: 0 });
    expect(state.phase).toBe("awaiting_discard");
    expect(state.hands[0]).toHaveLength(14);
    expect(state.liveWall).toHaveLength(69);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "draw",
      seat: 0,
      wallRemaining: 69,
    });
  });

  it("discard rotates turn and flags tsumogiri when matching", () => {
    const s0 = createInitialState(1);
    const drawn = step(s0, { type: "draw", seat: 0 });
    const drawnTile = drawn.state.lastDrawn[0]!;
    const out = step(drawn.state, {
      type: "discard",
      seat: 0,
      tile: drawnTile,
    });
    expect(out.state.phase).toBe("awaiting_draw");
    expect(out.state.turn).toBe(1);
    expect(out.state.hands[0]).toHaveLength(13);
    expect(out.state.lastDrawn[0]).toBeNull();
    expect(out.events[0]).toMatchObject({
      type: "discard",
      seat: 0,
      tile: drawnTile,
      tsumogiri: true,
    });
  });

  it("discarding a non-matching tile is not tsumogiri", () => {
    const s0 = createInitialState(1);
    const drawn = step(s0, { type: "draw", seat: 0 });
    const drawnTile = drawn.state.lastDrawn[0]!;
    const other = drawn.state.hands[0].find((t) => t !== drawnTile);
    if (!other) {
      // 14 identical tiles is impossible with 4-of-each, so this is unreachable.
      throw new Error("setup: expected at least two distinct tiles");
    }
    const out = step(drawn.state, { type: "discard", seat: 0, tile: other });
    expect(out.events[0]).toMatchObject({ tsumogiri: false });
  });

  it("rejects illegal actions without mutating state", () => {
    const s0 = createInitialState(1);
    // Wrong seat to draw.
    expect(step(s0, { type: "draw", seat: 1 })).toEqual({
      state: s0,
      events: [],
    });
    // Discard before draw.
    expect(
      step(s0, { type: "discard", seat: 0, tile: s0.hands[0][0] })
    ).toEqual({ state: s0, events: [] });
    // Discard a tile not in hand.
    const drawn = step(s0, { type: "draw", seat: 0 });
    const r = step(drawn.state, { type: "discard", seat: 0, tile: "9z" });
    expect(r.state).toBe(drawn.state);
    expect(r.events).toEqual([]);
  });

  it("plays out to exhaustive draw; turn count = wall + 1 hand_end", () => {
    const { events, finalState } = play(2026, (s, seat) => s.hands[seat][0]);
    expect(finalState.phase).toBe("hand_ended");
    expect(finalState.lastHandResult?.reason).toBe("exhaustive_draw");
    expect(finalState.liveWall).toHaveLength(0);
    const draws = events.filter((e) => e.type === "draw").length;
    const discards = events.filter((e) => e.type === "discard").length;
    const ends = events.filter((e) => e.type === "hand_end").length;
    expect(draws).toBe(70);
    expect(discards).toBe(70);
    expect(ends).toBe(1);
  });

  it("two replays from the same seed produce identical event traces", () => {
    const a = play(7, (s, seat) => s.hands[seat][0]);
    const b = play(7, (s, seat) => s.hands[seat][0]);
    expect(a.events).toEqual(b.events);
  });

  it("ignores actions after the match has ended", () => {
    const { finalState } = play(7, (s, seat) => s.hands[seat][0]);
    const r = step(finalState, { type: "draw", seat: 0 });
    expect(r.state).toBe(finalState);
    expect(r.events).toEqual([]);
  });
});
