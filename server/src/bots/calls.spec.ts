/**
 * Tests for the bot call policy (`chooseBotCall`).
 *
 * Slice policy: yakuhai pons / daiminkans only — own seat wind,
 * round wind, or any dragon. Never chi. Never voluntary kan over a
 * pon.
 */

import { describe, expect, it } from "vitest";
import { chooseBotCall, chooseBotSelfKan } from "./calls";
import type { CallOption } from "~/game/rules/calls";
import {
  createInitialState,
  type MatchState,
  type Meld,
} from "~/game/rules/state";
import type { Tile, Wind } from "~/game/rules";

function craft(opts: {
  discardSeat: 0 | 1 | 2 | 3;
  tile: Tile;
  dealer?: 0 | 1 | 2 | 3;
  roundWind?: Wind;
}): MatchState {
  const base = createInitialState(0);
  return {
    ...base,
    phase: "awaiting_draw",
    turn: ((opts.discardSeat + 1) % 4) as 0 | 1 | 2 | 3,
    dealer: opts.dealer ?? 0,
    roundWind: opts.roundWind ?? "E",
    lastDiscard: { seat: opts.discardSeat, tile: opts.tile },
  };
}

const ponOption = (t: Tile): CallOption => ({
  kind: "pon",
  tiles: [t, t],
});
const kanOption = (t: Tile): CallOption => ({
  kind: "daiminkan",
  tiles: [t, t, t],
});
const chiOption: CallOption = {
  kind: "chi",
  tiles: ["1m", "2m"],
};

describe("chooseBotCall — yakuhai-only policy", () => {
  it("pons a dragon discard", () => {
    const state = craft({ discardSeat: 0, tile: "5z" });
    const choice = chooseBotCall(state, 1, [ponOption("5z")]);
    expect(choice).toEqual(ponOption("5z"));
  });

  it("pons the round wind", () => {
    // Round S: 2z is round wind.
    const state = craft({ discardSeat: 0, tile: "2z", roundWind: "S" });
    const choice = chooseBotCall(state, 2, [ponOption("2z")]);
    expect(choice).toEqual(ponOption("2z"));
  });

  it("pons the bot's own seat wind", () => {
    // Dealer = 0 (E), seat 1 = S, seat 2 = W, seat 3 = N.
    // Round E: 1z is round wind. Seat 2's seat wind is W = 3z.
    const state = craft({ discardSeat: 0, tile: "3z", roundWind: "E" });
    const choice = chooseBotCall(state, 2, [ponOption("3z")]);
    expect(choice).toEqual(ponOption("3z"));
  });

  it("does NOT pon a non-yakuhai wind (e.g. seat 1's own wind for seat 2)", () => {
    // Dealer = 0, round E. Seat 1's wind is S (2z), but for seat 2,
    // S is neither own seat wind (W) nor round wind (E).
    const state = craft({ discardSeat: 0, tile: "2z", roundWind: "E" });
    const choice = chooseBotCall(state, 2, [ponOption("2z")]);
    expect(choice).toBeNull();
  });

  it("does NOT pon a non-yakuhai numbered tile", () => {
    const state = craft({ discardSeat: 0, tile: "5m" });
    const choice = chooseBotCall(state, 1, [ponOption("5m")]);
    expect(choice).toBeNull();
  });

  it("never chis", () => {
    const state = craft({ discardSeat: 0, tile: "3m" });
    const choice = chooseBotCall(state, 1, [chiOption]);
    expect(choice).toBeNull();
  });

  it("prefers pon over daiminkan when both are offered for a yakuhai", () => {
    const state = craft({ discardSeat: 0, tile: "7z" });
    const choice = chooseBotCall(state, 1, [kanOption("7z"), ponOption("7z")]);
    expect(choice).toEqual(ponOption("7z"));
  });

  it("falls back to daiminkan when only kan is offered for a yakuhai", () => {
    const state = craft({ discardSeat: 0, tile: "7z" });
    const choice = chooseBotCall(state, 1, [kanOption("7z")]);
    expect(choice).toEqual(kanOption("7z"));
  });

  it("returns null when no options are passed", () => {
    const state = craft({ discardSeat: 0, tile: "5z" });
    expect(chooseBotCall(state, 1, [])).toBeNull();
  });
});

function craftSelfKan(opts: {
  seat: 0 | 1 | 2 | 3;
  hand: Tile[];
  melds?: Meld[][];
  dealer?: 0 | 1 | 2 | 3;
  roundWind?: Wind;
  riichiDeclared?: [boolean, boolean, boolean, boolean];
}): MatchState {
  const base = createInitialState(0);
  const hands: Tile[][] = [[], [], [], []];
  hands[opts.seat] = [...opts.hand];
  for (let s = 0; s < 4; s++) {
    if (s !== opts.seat) {
      hands[s] = Array.from({ length: 13 }, () => "9p" as Tile);
    }
  }
  return {
    ...base,
    hands,
    phase: "awaiting_discard",
    turn: opts.seat,
    // Self-kan is only legal immediately after a draw — mark the
    // seat's `lastDrawn` so the gate in `chooseBotSelfKan` passes.
    // The exact tile doesn't matter for these tests; pick the
    // first hand tile.
    lastDrawn: (() => {
      const ld: (Tile | null)[] = [null, null, null, null];
      ld[opts.seat] = opts.hand[0];
      return ld;
    })(),
    dealer: opts.dealer ?? 0,
    roundWind: opts.roundWind ?? "E",
    melds: opts.melds ?? [[], [], [], []],
    riichiDeclared: opts.riichiDeclared ?? [false, false, false, false],
  };
}

describe("chooseBotSelfKan — yakuhai-only policy", () => {
  it("returns shouminkan when an owned yakuhai pon matches a hand tile", () => {
    // Seat 1, round E, dealer 0 → seat 1 wind = S = 2z. Pon of 5z
    // (dragon = always yakuhai). Hand contains the 4th 5z.
    const ponMeld: Meld = {
      type: "pon",
      tiles: ["5z", "5z", "5z"],
      claimedTile: "5z",
      from: 0,
    };
    const state = craftSelfKan({
      seat: 1,
      hand: ["5z", "1m", "2m", "3m", "4m", "5m", "6m", "7m", "8m", "9m"],
      melds: [[], [ponMeld], [], []],
    });
    expect(chooseBotSelfKan(state, 1)).toEqual({
      kind: "shouminkan",
      tile: "5z",
    });
  });

  it("does NOT shouminkan when the underlying pon is non-yakuhai", () => {
    // Pon of 3m — never yakuhai.
    const ponMeld: Meld = {
      type: "pon",
      tiles: ["3m", "3m", "3m"],
      claimedTile: "3m",
      from: 0,
    };
    const state = craftSelfKan({
      seat: 1,
      hand: ["3m", "1p", "2p", "3p", "4p", "5p", "6p", "7p", "8p", "9p"],
      melds: [[], [ponMeld], [], []],
    });
    expect(chooseBotSelfKan(state, 1)).toBeNull();
  });

  it("returns ankan when 4 yakuhai tiles are in hand (dragon)", () => {
    const state = craftSelfKan({
      seat: 1,
      hand: [
        "7z",
        "7z",
        "7z",
        "7z",
        "1m",
        "2m",
        "3m",
        "4m",
        "5m",
        "6m",
        "7m",
        "8m",
        "9m",
        "1p",
      ],
    });
    expect(chooseBotSelfKan(state, 1)).toEqual({ kind: "ankan", tile: "7z" });
  });

  it("does NOT ankan a non-yakuhai 4-of-a-kind", () => {
    const state = craftSelfKan({
      seat: 1,
      hand: [
        "5m",
        "5m",
        "5m",
        "5m",
        "1p",
        "2p",
        "3p",
        "4p",
        "5p",
        "6p",
        "7p",
        "8p",
        "9p",
        "1s",
      ],
    });
    expect(chooseBotSelfKan(state, 1)).toBeNull();
  });

  it("does NOT declare a self-kan after the final live-wall draw", () => {
    const state = craftSelfKan({
      seat: 1,
      hand: [
        "7z",
        "7z",
        "7z",
        "7z",
        "1m",
        "2m",
        "3m",
        "4m",
        "5m",
        "6m",
        "7m",
        "8m",
        "9m",
        "1p",
      ],
    });
    state.liveWall = [];

    expect(chooseBotSelfKan(state, 1)).toBeNull();
  });

  it("does NOT shouminkan during riichi", () => {
    const ponMeld: Meld = {
      type: "pon",
      tiles: ["5z", "5z", "5z"],
      claimedTile: "5z",
      from: 0,
    };
    const state = craftSelfKan({
      seat: 1,
      hand: ["5z", "1m", "2m", "3m", "4m", "5m", "6m", "7m", "8m", "9m"],
      melds: [[], [ponMeld], [], []],
      riichiDeclared: [false, true, false, false],
    });
    expect(chooseBotSelfKan(state, 1)).toBeNull();
  });

  it("returns null when phase is not awaiting_discard", () => {
    const state = craftSelfKan({
      seat: 1,
      hand: [
        "7z",
        "7z",
        "7z",
        "7z",
        "1m",
        "2m",
        "3m",
        "4m",
        "5m",
        "6m",
        "7m",
        "8m",
        "9m",
        "1p",
      ],
    });
    const draw = { ...state, phase: "awaiting_draw" as const };
    expect(chooseBotSelfKan(draw, 1)).toBeNull();
  });

  it("returns null in awaiting_discard when seat just called (lastDrawn is null)", () => {
    // Simulate the state right after a chi/pon: phase is
    // awaiting_discard but the caller's `lastDrawn` slot is null.
    // Kan must not be permitted.
    const state = craftSelfKan({
      seat: 1,
      hand: [
        "7z",
        "7z",
        "7z",
        "7z",
        "1m",
        "2m",
        "3m",
        "4m",
        "5m",
        "6m",
        "7m",
        "8m",
        "9m",
        "1p",
      ],
    });
    const postCall = {
      ...state,
      lastDrawn: [null, null, null, null] as MatchState["lastDrawn"],
    };
    expect(chooseBotSelfKan(postCall, 1)).toBeNull();
  });
});
