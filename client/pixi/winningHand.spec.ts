import { describe, expect, it } from "vitest";
import { splitWinningHandForDisplay } from "./winningHand";

describe("splitWinningHandForDisplay", () => {
  it("keeps an identical concealed tile when a tsumo payload omits the agari tile from hand", () => {
    const hand = [
      "1m",
      "2m",
      "3m",
      "4m",
      "5p",
      "5p",
      "6p",
      "7p",
      "8p",
      "2s",
      "3s",
      "4s",
      "7z",
    ];

    const result = splitWinningHandForDisplay(hand, "5p", true);

    expect(result.concealed.filter((tile) => tile === "5p")).toHaveLength(2);
    expect(result.agari).toBe("5p");
  });

  it("strips one matching tile when a tsumo payload already includes the agari tile in hand", () => {
    const hand = [
      "1m",
      "2m",
      "3m",
      "4m",
      "5p",
      "5p",
      "6p",
      "7p",
      "8p",
      "2s",
      "3s",
      "4s",
      "7z",
      "5p",
    ];

    const result = splitWinningHandForDisplay(hand, "5p", true);

    expect(result.concealed.filter((tile) => tile === "5p")).toHaveLength(2);
    expect(result.agari).toBe("5p");
  });
});
