import { describe, expect, it } from "vitest";

import { normalMatchMode } from "~/game/protocol/matchMode";
import { createMatchDriver } from "./match-drivers/matchDriver";
import { buildDiscardLegals } from "./session/legalActionBuilder";
import type { LegalAction, Tile } from "~/game/protocol/messages";
import { createInitialState, type MatchState } from "~/game/rules/state";

function tiles(value: string): Tile[] {
  const out: Tile[] = [];
  let digits = "";
  for (const char of value) {
    if (char >= "0" && char <= "9") {
      digits += char;
    } else {
      for (const digit of digits) {
        out.push(`${digit}${char}` as Tile);
      }
      digits = "";
    }
  }
  return out;
}

function buildLegals(state: MatchState): LegalAction[] {
  return buildDiscardLegals(
    state,
    createMatchDriver(normalMatchMode, "tenhou-hanchan"),
    0
  );
}

describe("MatchKernel — last live-wall tile", () => {
  it("offers tsumo when haitei is the only yaku", () => {
    const state = createInitialState(1);
    state.hands[0] = tiles("456m789p123s22z");
    state.melds[0] = [
      {
        type: "chi",
        tiles: tiles("123m"),
        claimedTile: "3m",
        from: 3,
      },
    ];
    state.turn = 0;
    state.phase = "awaiting_discard";
    state.lastDrawn = ["2z", null, null, null];

    state.liveWall = ["9s"];
    const beforeHaitei = buildLegals(state);
    expect(beforeHaitei.some((action) => action.type === "tsumo")).toBe(false);

    state.liveWall = [];
    const onHaitei = buildLegals(state);
    expect(onHaitei.some((action) => action.type === "tsumo")).toBe(true);
  });

  it("offers tsumo but no self-kan after the final draw", () => {
    const state = createInitialState(1);
    state.hands[0] = tiles("1111m23m234p234s22z");
    state.turn = 0;
    state.phase = "awaiting_discard";
    state.lastDrawn = ["2z", null, null, null];
    state.liveWall = [];

    const legals = buildLegals(state);

    expect(legals.some((action) => action.type === "tsumo")).toBe(true);
    expect(legals.some((action) => action.type === "kan")).toBe(false);
    expect(
      legals.every(
        (action) => action.type === "discard" || action.type === "tsumo"
      )
    ).toBe(true);
  });
});
