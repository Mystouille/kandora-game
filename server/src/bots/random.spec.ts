import { afterEach, describe, expect, it, vi } from "vitest";
import { randomBotDiscard } from "./random";

describe("randomBotDiscard", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("distinguishes a hand copy from an identical drawn tile by index", () => {
    const hand = ["5m", "1p", "5m"];
    vi.spyOn(Math, "random").mockReturnValueOnce(0).mockReturnValueOnce(0.999);

    expect(randomBotDiscard({ hand, drawn: "5m" })).toEqual({
      tile: "5m",
      tsumogiri: false,
      discardSource: "hand",
    });
    expect(randomBotDiscard({ hand, drawn: "5m" })).toEqual({
      tile: "5m",
      tsumogiri: true,
      discardSource: "draw",
    });
  });
});