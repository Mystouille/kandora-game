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

  it("banks a declared drawn flower and replaces it from the wall tail", () => {
    const state = stateForDraw();
    state.liveWall = ["1f", "2m"];

    const drawn = step(state, { type: "draw", seat: 0 });
    expect(drawn.state.phase).toBe("awaiting_discard");
    expect(drawn.state.pendingFlower).toBeNull();
    expect(drawn.state.lastDrawn[0]).toBe("1f");
    expect(drawn.events).toEqual([
      { type: "draw", seat: 0, tile: "1f", wallRemaining: 1 },
    ]);

    const declared = step(drawn.state, {
      type: "flower",
      seat: 0,
      tile: "1f",
    });
    expect(declared.state.phase).toBe("awaiting_flower_replacement");
    expect(declared.state.pendingFlower).toEqual({ seat: 0, tile: "1f" });
    expect(declared.events).toEqual([]);

    const replaced = step(declared.state, { type: "complete_flower" });
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

  it("allows a flower drawn during play to be discarded without banking it", () => {
    const state = stateForDraw();
    state.liveWall = ["8f", "2m"];

    const drawn = step(state, { type: "draw", seat: 0 });
    const discarded = step(drawn.state, {
      type: "discard",
      seat: 0,
      tile: "8f",
      discardSource: "draw",
    });

    expect(discarded.state.phase).toBe("awaiting_draw");
    expect(discarded.state.flowerTiles[0]).not.toContain("8f");
    expect(discarded.state.discards[0]).toContain("8f");
    expect(discarded.events).toEqual([
      {
        type: "discard",
        seat: 0,
        tile: "8f",
        tsumogiri: true,
        discardSource: "draw",
      },
    ]);
    expect(enumerateCalls(discarded.state)).toEqual([]);
  });

  it("allows a flower from the starting hand to be discarded", () => {
    const state = createInitialState(43, {
      ruleSet: presetToRuleSet(getPreset("mcr-ema")),
    });
    state.hands[0] = ["1f", ...ORPHANS];
    state.lastDrawn[0] = "7z";

    const discarded = step(state, {
      type: "discard",
      seat: 0,
      tile: "1f",
      discardSource: "hand",
    });

    expect(discarded.state.hands[0]).toEqual(ORPHANS);
    expect(discarded.state.discards[0]).toEqual(["1f"]);
    expect(discarded.state.flowerTiles[0]).toEqual([]);
    expect(discarded.events[0]).toMatchObject({
      type: "discard",
      tile: "1f",
      discardSource: "hand",
    });
  });

  it("settles normally after discarding the final wall flower", () => {
    const state = stateForDraw();
    state.liveWall = ["8f"];

    const drawn = step(state, { type: "draw", seat: 0 });
    const discarded = step(drawn.state, {
      type: "discard",
      seat: 0,
      tile: "8f",
      discardSource: "draw",
    });
    const settled = step(discarded.state, { type: "draw", seat: 1 });

    expect(settled.state.phase).toBe("hand_ended");
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
    const declared = step(flower.state, {
      type: "flower",
      seat: 0,
      tile: "1f",
    });
    const replaced = step(declared.state, { type: "complete_flower" });
    const won = step(replaced.state, { type: "tsumo", seat: 0 });
    const win = won.events.find((event) => event.type === "win");
    if (win?.type !== "win") {
      throw new Error("Expected a flower-replacement win");
    }
    expect(
      win.mcrScore?.fans.some((fan) => fan.id === "OUT_WITH_REPLACEMENT_TILE")
    ).toBe(false);
  });

  it("allows a kong replacement flower to be discarded", () => {
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

    const kong = step(state, {
      type: "kan",
      seat: 0,
      kind: "ankan",
      tile: "1m",
    });
    expect(kong.state.phase).toBe("awaiting_discard");
    expect(kong.state.lastDrawn[0]).toBe("2f");
    expect(kong.events).toContainEqual({
      type: "draw",
      seat: 0,
      tile: "2f",
      wallRemaining: 1,
      fromDeadWall: false,
      replacementKind: "kan",
    });
    expect(
      step(kong.state, {
        type: "discard",
        seat: 0,
        tile: "2f",
        discardSource: "draw",
      }).events
    ).toContainEqual({
      type: "discard",
      seat: 0,
      tile: "2f",
      tsumogiri: true,
      discardSource: "draw",
    });
  });
});
