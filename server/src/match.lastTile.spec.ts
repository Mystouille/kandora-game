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

describe("MatchProcess — last live-wall tile", () => {
  it("offers tsumo but no self-kan after the final draw", () => {
    const match = new MatchProcess("last-tile", 1, [
      { userId: "u0", displayName: "Human", isBot: false },
      { userId: "u1", displayName: "Bot 1", isBot: true },
      { userId: "u2", displayName: "Bot 2", isBot: true },
      { userId: "u3", displayName: "Bot 3", isBot: true },
    ], {
      repository: ephemeralMatchRepository,
    });
    const internals = match as unknown as {
      state: MatchState;
      buildDiscardLegals(seat: 0): LegalAction[];
    };
    internals.state = createInitialState(1);
    internals.state.hands[0] = tiles("1111m23m234p234s22z");
    internals.state.turn = 0;
    internals.state.phase = "awaiting_discard";
    internals.state.lastDrawn = ["2z", null, null, null];
    internals.state.liveWall = [];

    const legals = internals.buildDiscardLegals(0);

    expect(legals.some((action) => action.type === "tsumo")).toBe(true);
    expect(legals.some((action) => action.type === "kan")).toBe(false);
    expect(
      legals.every(
        (action) => action.type === "discard" || action.type === "tsumo"
      )
    ).toBe(true);
  });
});
