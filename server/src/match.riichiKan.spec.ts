import { describe, expect, it } from "vitest";

import { MatchProcess } from "./match";
import { ephemeralMatchRepository } from "./repository";
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

function createMatch(): MatchProcess {
  return new MatchProcess(
    "riichi-ankan",
    1,
    [
      { userId: "u0", displayName: "Human", isBot: false },
      { userId: "u1", displayName: "Bot 1", isBot: true },
      { userId: "u2", displayName: "Bot 2", isBot: true },
      { userId: "u3", displayName: "Bot 3", isBot: true },
    ],
    {
      repository: ephemeralMatchRepository,
    }
  );
}

function getInternals(match: MatchProcess): {
  state: MatchState;
  buildDiscardLegals(seat: 0): LegalAction[];
} {
  return match as unknown as {
    state: MatchState;
    buildDiscardLegals(seat: 0): LegalAction[];
  };
}

describe("MatchProcess — riichi ankan legality", () => {
  it("does not offer an ankan that removes a winning interpretation", () => {
    const internals = getInternals(createMatch());
    internals.state = createInitialState(1);
    internals.state.hands[0] = tiles("11122333p99m789s1p");
    internals.state.turn = 0;
    internals.state.phase = "awaiting_discard";
    internals.state.lastDrawn = ["1p", null, null, null];
    internals.state.riichiDeclared = [true, false, false, false];

    const legals = internals.buildDiscardLegals(0);

    expect(legals.some((action) => action.type === "kan")).toBe(false);
  });

  it("still offers an ankan that preserves every winning interpretation", () => {
    const internals = getInternals(createMatch());
    internals.state = createInitialState(1);
    internals.state.hands[0] = tiles("999m234p234s11z67m9m");
    internals.state.turn = 0;
    internals.state.phase = "awaiting_discard";
    internals.state.lastDrawn = ["9m", null, null, null];
    internals.state.riichiDeclared = [true, false, false, false];

    const legals = internals.buildDiscardLegals(0);

    expect(legals).toContainEqual({
      id: "kan:ankan:9m",
      type: "kan",
      kanKind: "ankan",
      tiles: ["9m", "9m", "9m"],
    });
  });
});