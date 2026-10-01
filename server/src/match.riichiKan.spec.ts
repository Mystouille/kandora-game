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

describe("MatchKernel — riichi ankan legality", () => {
  it("does not offer an ankan that removes a winning interpretation", () => {
    const state = createInitialState(1);
    state.hands[0] = tiles("11122333p99m789s1p");
    state.turn = 0;
    state.phase = "awaiting_discard";
    state.lastDrawn = ["1p", null, null, null];
    state.riichiDeclared = [true, false, false, false];

    const legals = buildLegals(state);

    expect(legals.some((action) => action.type === "kan")).toBe(false);
  });

  it("still offers an ankan that preserves every winning interpretation", () => {
    const state = createInitialState(1);
    state.hands[0] = tiles("999m234p234s11z67m9m");
    state.turn = 0;
    state.phase = "awaiting_discard";
    state.lastDrawn = ["9m", null, null, null];
    state.riichiDeclared = [true, false, false, false];

    const legals = buildLegals(state);

    expect(legals).toContainEqual({
      id: "kan:ankan:9m",
      type: "kan",
      kanKind: "ankan",
      tiles: ["9m", "9m", "9m"],
    });
  });
});
