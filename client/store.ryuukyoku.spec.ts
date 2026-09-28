import { beforeEach, describe, expect, it } from "vitest";
import type { SnapshotState } from "~/game/protocol/messages";
import { useMatchStore } from "./store";

function snapshot(
  overrides: Partial<SnapshotState> = {}
): SnapshotState {
  return {
    mySeat: 0,
    hands: [["1m"], [null], [null], [null]],
    discards: [[], [], [], []],
    melds: [[], [], [], []],
    wallRemaining: 0,
    doraIndicators: ["1z"],
    turn: 0,
    dealer: 0,
    roundWind: "E",
    roundNumber: 1,
    honba: 0,
    riichiSticks: 0,
    scores: [25000, 25000, 25000, 25000],
    riichiDeclared: [false, false, false, false],
    lastDiscard: null,
    phase: "ryuukyoku_declarations",
    ...overrides,
  };
}

describe("live ryuukyoku declaration state", () => {
  beforeEach(() => {
    useMatchStore.getState().reset();
  });

  it("hydrates and clones public declaration state", () => {
    const revealed = ["2m", "3m", "4m"] as const;
    const state = snapshot({
      ryuukyokuDeclarations: [null, true, false, null],
      ryuukyokuTenpaiHands: [null, [...revealed], null, null],
    });

    useMatchStore.getState().hydrateSnapshot(state, 7);

    expect(useMatchStore.getState().ryuukyokuDeclarations).toEqual([
      null,
      true,
      false,
      null,
    ]);
    expect(useMatchStore.getState().ryuukyokuTenpaiHands[1]).toEqual(
      revealed
    );
    expect(useMatchStore.getState().ryuukyokuTenpaiHands[1]).not.toBe(
      state.ryuukyokuTenpaiHands?.[1]
    );
  });

  it("restores the settled draw panel during a post-hand reconnect", () => {
    useMatchStore.getState().hydrateSnapshot(
      snapshot({
        ryuukyokuDeclarations: [true, false, true, false],
        ryuukyokuTenpaiHands: [["1m"], null, ["3m"], null],
        lastHandResult: {
          type: "hand_end",
          reason: "exhaustive_draw",
          delta: [1500, -1500, 1500, -1500],
          tenpai: [true, false, true, false],
          declarations: [
            { seat: 0, tenpai: true },
            { seat: 1, tenpai: false },
            { seat: 2, tenpai: true },
            { seat: 3, tenpai: false },
          ],
          scores: [26500, 23500, 26500, 23500],
          honba: 0,
          riichiSticks: 0,
          tenpaiHands: [["1m"], null, ["3m"], null],
        },
      }),
      11
    );

    expect(useMatchStore.getState().lastHandResult).toMatchObject({
      reason: "exhaustive_draw",
      dealer: 0,
      tenpai: [true, false, true, false],
      declarations: [
        { seat: 0, tenpai: true },
        { seat: 1, tenpai: false },
        { seat: 2, tenpai: true },
        { seat: 3, tenpai: false },
      ],
      tenpaiHands: [["1m"], null, ["3m"], null],
    });
  });

  it("applies one live declaration without mutating prior tuples", () => {
    const previousDeclarations =
      useMatchStore.getState().ryuukyokuDeclarations;
    const previousHands = useMatchStore.getState().ryuukyokuTenpaiHands;

    useMatchStore.getState().applyEvent(
      {
        type: "ryuukyoku_declaration",
        seat: 2,
        tenpai: true,
        hand: ["4p", "5p", "6p"],
      },
      8
    );

    expect(previousDeclarations).toEqual([null, null, null, null]);
    expect(previousHands).toEqual([null, null, null, null]);
    expect(useMatchStore.getState().ryuukyokuDeclarations).toEqual([
      null,
      null,
      true,
      null,
    ]);
    expect(useMatchStore.getState().ryuukyokuTenpaiHands[2]).toEqual([
      "4p",
      "5p",
      "6p",
    ]);
  });

  it("merges archived-style hand_end declarations immediately", () => {
    useMatchStore.getState().applyEvent(
      {
        type: "hand_end",
        reason: "exhaustive_draw",
        declarations: [
          { seat: 0, tenpai: true },
          { seat: 1, tenpai: false },
          { seat: 2, tenpai: true },
          { seat: 3, tenpai: false },
        ],
        tenpaiHands: [["1m"], null, ["3m"], null],
      },
      9
    );

    const state = useMatchStore.getState();
    expect(state.ryuukyokuDeclarations).toEqual([
      true,
      false,
      true,
      false,
    ]);
    expect(state.ryuukyokuTenpaiHands).toEqual([
      ["1m"],
      null,
      ["3m"],
      null,
    ]);
    expect(state.lastHandResult?.declarations).toHaveLength(4);
  });

  it("resets declaration state at hand boundaries and full reset", () => {
    useMatchStore.setState({
      ryuukyokuDeclarations: [true, false, true, false],
      ryuukyokuTenpaiHands: [["1m"], null, ["3m"], null],
    });

    useMatchStore.getState().applyEvent(
      {
        type: "match_start",
        seats: [],
        ruleSet: "buu-east",
      },
      10
    );
    expect(useMatchStore.getState().ryuukyokuDeclarations).toEqual([
      null,
      null,
      null,
      null,
    ]);
    expect(useMatchStore.getState().ryuukyokuTenpaiHands).toEqual([
      null,
      null,
      null,
      null,
    ]);

    useMatchStore.setState({
      ryuukyokuDeclarations: [true, false, true, false],
      ryuukyokuTenpaiHands: [["1m"], null, ["3m"], null],
    });
    useMatchStore.getState().applyEvent(
      {
        type: "hand_start",
        round: 1,
        dealer: 1,
        doraIndicators: ["2z"],
      },
      11
    );
    expect(useMatchStore.getState().ryuukyokuDeclarations).toEqual([
      null,
      null,
      null,
      null,
    ]);
    expect(useMatchStore.getState().ryuukyokuTenpaiHands).toEqual([
      null,
      null,
      null,
      null,
    ]);

    useMatchStore.setState({
      ryuukyokuDeclarations: [true, null, null, null],
    });
    useMatchStore.getState().reset();
    expect(useMatchStore.getState().ryuukyokuDeclarations).toEqual([
      null,
      null,
      null,
      null,
    ]);
  });
});
