import { describe, expect, it } from "vitest";
import { getPreset, presetToRuleSet } from "./presets";
import { createInitialState, MatchStateSchema } from "./state";
import { step } from "./step";
import { enumerateCalls } from "./calls";

function stateForDraw() {
  const state = createInitialState(42, {
    ruleSet: presetToRuleSet(getPreset("mcr-ema")),
  });
  state.turn = 0;
  state.phase = "awaiting_draw";
  state.hands[0] = state.hands[0].slice(0, 13);
  state.lastDrawn[0] = null;
  state.lastDrawFromKong = false;
  return state;
}

const ORPHANS = [
  "1m",
  "9m",
  "1p",
  "9p",
  "1s",
  "9s",
  "1z",
  "2z",
  "3z",
  "4z",
  "5z",
  "6z",
  "7z",
] as const;

describe("MCR flower flow", () => {
  it("starts with the official fixed profile", () => {
    const state = createInitialState(42, {
      ruleSet: presetToRuleSet(getPreset("mcr-ema")),
    });
    expect(state.ruleSet.rulesFamily).toBe("mcr");
    expect(state.scores).toEqual([0, 0, 0, 0]);
    expect(state.phase).toBe("awaiting_discard");
    expect(state.hands.map((hand) => hand.length)).toEqual([14, 13, 13, 13]);
    expect(state.deadWall).toEqual([]);
    expect(state.doraIndicators).toEqual([]);
    expect(MatchStateSchema.parse(state)).toEqual(state);
  });

  it("banks a drawn flower and replaces it from the wall tail", () => {
    const state = stateForDraw();
    state.liveWall = ["1f", "2m"];

    const drawn = step(state, { type: "draw", seat: 0 });
    expect(drawn.state.phase).toBe("awaiting_flower_replacement");
    expect(drawn.state.pendingFlower).toEqual({ seat: 0, tile: "1f" });
    expect(drawn.events).toEqual([
      { type: "draw", seat: 0, tile: "1f", wallRemaining: 1 },
    ]);

    const replaced = step(drawn.state, { type: "complete_flower" });
    expect(replaced.state.phase).toBe("awaiting_discard");
    expect(replaced.state.pendingFlower).toBeNull();
    expect(replaced.state.flowerTiles[0]).toContain("1f");
    expect(replaced.state.hands[0]).toContain("2m");
    expect(replaced.events).toEqual([
      { type: "flower", seat: 0, tile: "1f" },
      {
        type: "draw",
        seat: 0,
        tile: "2m",
        wallRemaining: 0,
        fromDeadWall: false,
        replacementKind: "flower",
      },
    ]);
  });

  it("discards an unreplaceable final flower and settles a zero-delta draw", () => {
    const state = stateForDraw();
    state.liveWall = ["8f"];

    const drawn = step(state, { type: "draw", seat: 0 });
    const settled = step(drawn.state, {
      type: "complete_flower",
      forceExhaustive: true,
    });

    expect(settled.state.phase).toBe("hand_ended");
    expect(settled.state.flowerTiles[0]).not.toContain("8f");
    expect(settled.state.discards[0]).toContain("8f");
    expect(settled.state.lastHandResult?.delta).toEqual([0, 0, 0, 0]);
    expect(settled.events.at(-1)).toEqual({
      type: "hand_end",
      reason: "exhaustive_draw",
      delta: [0, 0, 0, 0],
    });
  });

  it("rotates the dealer after every hand and ends after North 4", () => {
    let state = createInitialState(7, {
      ruleSet: presetToRuleSet(getPreset("mcr-ema")),
    });
    state.scores = [100, 200, 300, 400];
    const completedHands: string[] = [];
    for (let hand = 0; hand < 16; hand++) {
      completedHands.push(`${state.roundWind}${state.roundNumber}`);
      state.phase = "hand_ended";
      state.lastHandResult = {
        reason: "exhaustive_draw",
        winner: null,
        loser: null,
        delta: [0, 0, 0, 0],
        tenpai: null,
        abortKind: null,
        nagashi: null,
        winHan: null,
        winYakuman: null,
      };
      const next = step(state, { type: "start_next_hand" });
      state = next.state;
      if (hand < 15) {
        expect(state.phase).toBe("awaiting_discard");
        expect(state.dealer).toBe((hand + 1) % 4);
        if (hand === 3) {
          expect(state.scores).toEqual([200, 100, 400, 300]);
          expect(next.events[0]).toMatchObject({
            seatPermutation: [1, 0, 3, 2],
          });
        } else if (hand === 7) {
          expect(state.scores).toEqual([300, 400, 100, 200]);
          expect(next.events[0]).toMatchObject({
            seatPermutation: [3, 2, 1, 0],
          });
        } else if (hand === 11) {
          expect(state.scores).toEqual([400, 300, 200, 100]);
          expect(next.events[0]).toMatchObject({
            seatPermutation: [1, 0, 3, 2],
          });
        }
      } else {
        expect(state.phase).toBe("match_ended");
      }
    }
    expect(completedHands).toEqual([
      "E1",
      "E2",
      "E3",
      "E4",
      "S1",
      "S2",
      "S3",
      "S4",
      "W1",
      "W2",
      "W3",
      "W4",
      "N1",
      "N2",
      "N3",
      "N4",
    ]);
  });

  it("scores and settles a qualified self-draw through the MCR scorer", () => {
    const state = createInitialState(13, {
      ruleSet: presetToRuleSet(getPreset("mcr-ema")),
    });
    state.hands[0] = [...ORPHANS, "1m"];
    state.lastDrawn[0] = "1m";
    state.liveWall = ["2m"];

    const result = step(state, { type: "tsumo", seat: 0 });
    const win = result.events.find((event) => event.type === "win");

    expect(win?.type).toBe("win");
    if (win?.type !== "win") {
      throw new Error("Expected an MCR win event");
    }
    expect(win.mcrScore?.isWinningShape).toBe(true);
    expect(win.mcrScore?.meetsMinimum).toBe(true);
    expect(win.delta.reduce((sum, value) => sum + value, 0)).toBe(0);
    expect(result.state.phase).toBe("hand_ended");
    expect(result.state.scores[0]).toBeGreaterThan(0);
  });

  it("does not apply furiten and resolves a discard win", () => {
    const state = createInitialState(17, {
      ruleSet: presetToRuleSet(getPreset("mcr-ema")),
    });
    state.hands[1] = [...ORPHANS];
    state.discards[1] = ["1m"];
    state.discards[0] = ["1m"];
    state.lastDiscard = { seat: 0, tile: "1m" };
    state.turn = 1;
    state.phase = "awaiting_draw";

    expect(
      enumerateCalls(state)
        .find((entry) => entry.seat === 1)
        ?.options.some((option) => option.kind === "ron")
    ).toBe(true);
    const result = step(state, { type: "ron", seat: 1 });
    const win = result.events.find((event) => event.type === "win");

    expect(win?.type).toBe("win");
    if (win?.type !== "win") {
      throw new Error("Expected an MCR discard win event");
    }
    expect(win.mcrScore?.meetsMinimum).toBe(true);
    expect(win.loser).toBe(0);
    expect(win.delta.reduce((sum, value) => sum + value, 0)).toBe(0);
  });

  it("rejects multiple winners so the server must head-bump to the nearest seat", () => {
    const state = createInitialState(19, {
      ruleSet: presetToRuleSet(getPreset("mcr-ema")),
    });
    state.hands[1] = [...ORPHANS];
    state.hands[2] = [...ORPHANS];
    state.discards[0] = ["1m"];
    state.lastDiscard = { seat: 0, tile: "1m" };
    state.turn = 1;
    state.phase = "awaiting_draw";

    expect(
      step(state, {
        type: "ron",
        seat: 1,
        additionalWinners: [2],
      }).events
    ).toEqual([]);
  });

  it("opens the promoted-kong robbery scoring path", () => {
    const state = createInitialState(23, {
      ruleSet: presetToRuleSet(getPreset("mcr-ema")),
    });
    state.hands[1] = [...ORPHANS];
    state.melds[0] = [
      {
        type: "shouminkan",
        tiles: ["1m", "1m", "1m", "1m"],
        claimedTile: "1m",
        from: 2,
      },
    ];
    state.pendingShouminkan = { seat: 0, tile: "1m", ponIdx: 0 };
    state.phase = "awaiting_chankan";
    state.turn = 0;

    const result = step(state, { type: "ron", seat: 1 });
    const win = result.events.find((event) => event.type === "win");
    if (win?.type !== "win") {
      throw new Error("Expected a promoted-kong robbery win");
    }
    expect(win.mcrScore?.meetsMinimum).toBe(true);
    expect(win.loser).toBe(0);
  });

  it("does not award kong-replacement fan after an ordinary flower", () => {
    const state = createInitialState(29, {
      ruleSet: presetToRuleSet(getPreset("mcr-ema")),
    });
    state.hands[0] = [...ORPHANS];
    state.liveWall = ["1f", "1m"];
    state.turn = 0;
    state.phase = "awaiting_draw";
    state.lastDrawn[0] = null;

    const flower = step(state, { type: "draw", seat: 0 });
    const replaced = step(flower.state, { type: "complete_flower" });
    const won = step(replaced.state, { type: "tsumo", seat: 0 });
    const win = won.events.find((event) => event.type === "win");
    if (win?.type !== "win") {
      throw new Error("Expected a flower-replacement win");
    }
    expect(
      win.mcrScore?.fans.some((fan) => fan.id === "OUT_WITH_REPLACEMENT_TILE")
    ).toBe(false);
  });

  it("rejects a kong when the remaining wall cannot yield a structural replacement", () => {
    const state = createInitialState(31, {
      ruleSet: presetToRuleSet(getPreset("mcr-ema")),
    });
    state.hands[0] = [
      "1m",
      "1m",
      "1m",
      "1m",
      "2m",
      "3m",
      "4m",
      "2p",
      "3p",
      "4p",
      "2s",
      "3s",
      "4s",
      "5z",
    ];
    state.lastDrawn[0] = "5z";
    state.liveWall = ["1f", "2f"];
    state.phase = "awaiting_discard";

    expect(
      step(state, {
        type: "kan",
        seat: 0,
        kind: "ankan",
        tile: "1m",
      }).events
    ).toEqual([]);
  });
});
