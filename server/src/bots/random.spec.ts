import { describe, expect, it } from "vitest";
import { randomBotDiscard } from "./random";

describe("randomBotDiscard", () => {
  it("distinguishes a hand copy from an identical drawn tile by index", () => {
    const hand = ["5m", "1p", "5m"];

    expect(randomBotDiscard({ hand, drawn: "5m", random: () => 0 })).toEqual({
      tile: "5m",
      tsumogiri: false,
      discardSource: "hand",
    });
    expect(
      randomBotDiscard({ hand, drawn: "5m", random: () => 0.999 })
    ).toEqual({
      tile: "5m",
      tsumogiri: true,
      discardSource: "draw",
    });
  });

  it("does not sample candidates rejected by the discard policy", () => {
    expect(
      randomBotDiscard({
        hand: ["4m", "4m", "5m"],
        drawn: null,
        random: () => 0,
        isDiscardAllowed: (discard) => discard.tile !== "4m",
      })
    ).toEqual({
      tile: "5m",
      tsumogiri: false,
      discardSource: "hand",
    });
  });
});