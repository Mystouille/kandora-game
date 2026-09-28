import { describe, expect, it } from "vitest";
import type {
  CompleteRyuukyokuAction,
  DeclareRyuukyokuStatusAction,
} from "./actions";
import type { RuleSetOverride } from "./ruleSet";
import { createInitialState, MatchStateSchema, type MatchState } from "./state";
import { step } from "./step";
import type { Seat, Tile } from "./types";

type BooleanTuple = [boolean, boolean, boolean, boolean];

function tiles(compact: string): Tile[] {
  const result: Tile[] = [];
  let digits = "";
  for (const character of compact) {
    if (character >= "0" && character <= "9") {
      digits += character;
      continue;
    }
    for (const digit of digits) {
      result.push(`${digit}${character}`);
    }
    digits = "";
  }
  return result;
}

const TENPAI = tiles("11m22p33s44m55p66s7z");
const NOTEN = tiles("13579m13579p123s");

function exhaustiveState(opts: {
  hands?: Tile[][];
  dealer?: Seat;
  ruleSet?: RuleSetOverride;
  riichiDeclared?: BooleanTuple;
  discards?: Tile[][];
  finalHand?: boolean;
} = {}): MatchState {
  const state = createInitialState(0, { ruleSet: opts.ruleSet });
  return {
    ...state,
    hands: (opts.hands ?? [NOTEN, NOTEN, NOTEN, NOTEN]).map((hand) => [
      ...hand,
    ]),
    discards: (
      opts.discards ?? [[], [], [], []]
    ).map((discard) => [...discard]),
    liveWall: [],
    turn: 0,
    dealer: opts.dealer ?? 0,
    phase: "awaiting_draw",
    riichiDeclared: opts.riichiDeclared ?? [false, false, false, false],
    roundWind: opts.finalHand ? "S" : state.roundWind,
    roundNumber: opts.finalHand ? state.roundLimit : state.roundNumber,
  };
}

function beginDeclarations(state: MatchState): MatchState {
  const result = step(state, { type: "draw", seat: state.turn });
  expect(result.events).toEqual([]);
  expect(result.state.phase).toBe("awaiting_ryuukyoku_declarations");
  return result.state;
}

function declareAll(
  state: MatchState,
  declarations: BooleanTuple
): MatchState {
  let current = beginDeclarations(state);
  for (let offset = 0; offset < 4; offset++) {
    const seat = ((state.dealer + offset) % 4) as Seat;
    const result = step(current, {
      type: "declare_ryuukyoku_status",
      seat,
      tenpai: declarations[seat],
    });
    expect(result.events).toEqual([
      { type: "ryuukyoku_declaration", seat, tenpai: declarations[seat] },
    ]);
    current = result.state;
  }
  expect(current.phase).toBe("awaiting_ryuukyoku_settlement");
  return current;
}

function complete(state: MatchState): MatchState {
  const result = step(state, { type: "complete_ryuukyoku" });
  expect(result.events).toEqual([
    {
      type: "hand_end",
      reason: "exhaustive_draw",
      delta: result.state.lastHandResult?.delta,
    },
  ]);
  return result.state;
}

describe("step — ryuukyoku declarations", () => {
  it("exports both declaration action shapes", () => {
    const declaration: DeclareRyuukyokuStatusAction = {
      type: "declare_ryuukyoku_status",
      seat: 2,
      tenpai: true,
    };
    const completion: CompleteRyuukyokuAction = {
      type: "complete_ryuukyoku",
    };

    expect(declaration.type).toBe("declare_ryuukyoku_status");
    expect(completion.type).toBe("complete_ryuukyoku");
  });

  it("defaults missing legacy pending state to null", () => {
    const { pendingRyuukyoku: _pendingRyuukyoku, ...legacyState } =
      createInitialState(0);

    expect(MatchStateSchema.parse(legacyState).pendingRyuukyoku).toBeNull();
  });

  it("stores pending status and accepts declarations in dealer order", () => {
    const state = exhaustiveState({ dealer: 2 });
    let current = beginDeclarations(state);

    expect(current.turn).toBe(2);
    expect(current.pendingRyuukyoku).toEqual({
      actualTenpai: [false, false, false, false],
      declarations: [null, null, null, null],
      nagashi: [false, false, false, false],
    });
    expect(MatchStateSchema.parse(current)).toEqual(current);

    const wrongSeat = step(current, {
      type: "declare_ryuukyoku_status",
      seat: 3,
      tenpai: false,
    });
    expect(wrongSeat).toEqual({ state: current, events: [] });

    for (const [index, seat] of ([2, 3, 0, 1] as Seat[]).entries()) {
      const beforeScores = [...current.scores];
      const result = step(current, {
        type: "declare_ryuukyoku_status",
        seat,
        tenpai: false,
      });
      expect(result.events).toEqual([
        { type: "ryuukyoku_declaration", seat, tenpai: false },
      ]);
      expect(result.state.scores).toEqual(beforeScores);
      expect(result.state.lastHandResult).toBeNull();
      if (index < 3) {
        expect(result.state.phase).toBe("awaiting_ryuukyoku_declarations");
        expect(result.state.turn).toBe(([3, 0, 1] as Seat[])[index]);
      } else {
        expect(result.state.phase).toBe("awaiting_ryuukyoku_settlement");
      }
      current = result.state;
    }

    const completed = step(current, { type: "complete_ryuukyoku" });
    expect(completed.state.phase).toBe("hand_ended");
    expect(completed.state.pendingRyuukyoku).toBeNull();
    expect(completed.state.lastHandResult?.tenpai).toEqual([
      false,
      false,
      false,
      false,
    ]);
    expect(completed.events).toEqual([
      {
        type: "hand_end",
        reason: "exhaustive_draw",
        delta: [0, 0, 0, 0],
      },
    ]);
  });

  it("rejects false tenpai and riichi noten declarations as no-ops", () => {
    const noten = beginDeclarations(exhaustiveState());
    expect(
      step(noten, {
        type: "declare_ryuukyoku_status",
        seat: 0,
        tenpai: true,
      })
    ).toEqual({ state: noten, events: [] });

    const riichi = beginDeclarations(
      exhaustiveState({
        hands: [TENPAI, NOTEN, NOTEN, NOTEN],
        riichiDeclared: [true, false, false, false],
      })
    );
    expect(
      step(riichi, {
        type: "declare_ryuukyoku_status",
        seat: 0,
        tenpai: false,
      })
    ).toEqual({ state: riichi, events: [] });
  });

  it("allows a non-riichi tenpai hand to declare noten", () => {
    const settled = complete(
      declareAll(
        exhaustiveState({ hands: [TENPAI, NOTEN, NOTEN, NOTEN] }),
        [false, false, false, false]
      )
    );

    expect(settled.lastHandResult?.tenpai).toEqual([
      false,
      false,
      false,
      false,
    ]);
    expect(settled.lastHandResult?.delta).toEqual([0, 0, 0, 0]);
  });

  it.each([
    {
      count: 0,
      declared: [false, false, false, false] as BooleanTuple,
      expected: [0, 0, 0, 0],
    },
    {
      count: 1,
      declared: [true, false, false, false] as BooleanTuple,
      expected: [3000, -1000, -1000, -1000],
    },
    {
      count: 2,
      declared: [true, true, false, false] as BooleanTuple,
      expected: [1500, 1500, -1500, -1500],
    },
    {
      count: 3,
      declared: [true, true, true, false] as BooleanTuple,
      expected: [1000, 1000, 1000, -3000],
    },
    {
      count: 4,
      declared: [true, true, true, true] as BooleanTuple,
      expected: [0, 0, 0, 0],
    },
  ])(
    "settles $count declared-tenpai seats with the standard payment split",
    ({ declared, expected }) => {
      const hands = declared.map((tenpai) => (tenpai ? TENPAI : NOTEN));
      const settled = complete(
        declareAll(exhaustiveState({ hands }), declared)
      );

      expect(settled.lastHandResult?.delta).toEqual(expected);
      expect(settled.scores).toEqual(
        expected.map((delta) => 25000 + delta)
      );
    }
  );

  it("does not settle before complete_ryuukyoku", () => {
    const pending = declareAll(exhaustiveState(), [
      false,
      false,
      false,
      false,
    ]);
    expect(pending.lastHandResult).toBeNull();
    expect(pending.scores).toEqual([25000, 25000, 25000, 25000]);

    const premature = step(beginDeclarations(exhaustiveState()), {
      type: "complete_ryuukyoku",
    });
    expect(premature.events).toEqual([]);

    const incomplete = beginDeclarations(exhaustiveState());
    const forgedSettlement: MatchState = {
      ...incomplete,
      phase: "awaiting_ryuukyoku_settlement",
    };
    expect(
      step(forgedSettlement, { type: "complete_ryuukyoku" })
    ).toEqual({
      state: forgedSettlement,
      events: [],
    });
  });

  it("uses declared status for dealer renchan", () => {
    const settled = complete(
      declareAll(
        exhaustiveState({ hands: [TENPAI, NOTEN, NOTEN, NOTEN] }),
        [false, false, false, false]
      )
    );
    const nextHand = step(settled, { type: "start_next_hand" });

    expect(nextHand.state.dealer).toBe(1);
    expect(nextHand.state.roundNumber).toBe(2);
    expect(nextHand.state.pendingRyuukyoku).toBeNull();
  });

  it("uses declared status for tenpai-yame", () => {
    const rules: RuleSetOverride = {
      tenpaiPayments: false,
      tenpaiRenchan: false,
      tenpaiYame: true,
    };
    const declaring = complete(
      declareAll(
        exhaustiveState({
          hands: [TENPAI, NOTEN, NOTEN, NOTEN],
          ruleSet: rules,
          finalHand: true,
        }),
        [true, false, false, false]
      )
    );
    const hidden = complete(
      declareAll(
        exhaustiveState({
          hands: [TENPAI, NOTEN, NOTEN, NOTEN],
          ruleSet: rules,
          finalHand: true,
        }),
        [false, false, false, false]
      )
    );

    expect(step(declaring, { type: "start_next_hand" }).events).toEqual([
      expect.objectContaining({ type: "match_end", reason: "tenpai_yame" }),
    ]);
    expect(step(hidden, { type: "start_next_hand" }).events).toEqual([
      expect.objectContaining({ type: "match_end", reason: "round_limit" }),
    ]);
  });

  it("preserves and stacks nagashi payments through settlement", () => {
    const pending = declareAll(
      exhaustiveState({
        hands: [TENPAI, NOTEN, NOTEN, NOTEN],
        discards: [tiles("5m"), tiles("1m9m1z2z"), tiles("5m"), tiles("5m")],
      }),
      [true, false, false, false]
    );
    expect(pending.pendingRyuukyoku?.nagashi).toEqual([
      false,
      true,
      false,
      false,
    ]);

    const settled = complete(pending);
    expect(settled.lastHandResult?.nagashi).toEqual([
      false,
      true,
      false,
      false,
    ]);
    expect(settled.lastHandResult?.delta).toEqual([
      -1000,
      7000,
      -3000,
      -3000,
    ]);
  });

  it("bypasses declarations when status cannot affect an enabled outcome", () => {
    const state = exhaustiveState({
      hands: [TENPAI, NOTEN, NOTEN, NOTEN],
      ruleSet: {
        tenpaiPayments: false,
        tenpaiRenchan: false,
        tenpaiYame: true,
      },
    });
    const result = step(state, { type: "draw", seat: state.turn });

    expect(result.state.phase).toBe("hand_ended");
    expect(result.state.pendingRyuukyoku).toBeNull();
    expect(result.state.lastHandResult?.tenpai).toEqual([
      true,
      false,
      false,
      false,
    ]);
    expect(result.state.lastHandResult?.delta).toEqual([0, 0, 0, 0]);
    expect(result.events).toEqual([
      {
        type: "hand_end",
        reason: "exhaustive_draw",
        delta: [0, 0, 0, 0],
      },
    ]);
  });
});
