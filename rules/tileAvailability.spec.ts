import { describe, expect, it } from "vitest";
import { isPlayableTile, waitsForRules } from "./tileAvailability";

describe("game-facing sanma tile availability", () => {
  it("keeps North playable but not any middle manzu, including nuki 5m", () => {
    expect(
      ["1m", "9m", "4z", "0p", "5s"].every((tile) =>
        isPlayableTile(tile, { playerCount: 3 })
      )
    ).toBe(true);
    expect(
      ["2m", "3m", "4m", "5m", "0m", "6m", "7m", "8m"].some((tile) =>
        isPlayableTile(tile, { playerCount: 3 })
      )
    ).toBe(false);
    expect(isPlayableTile("5m", { playerCount: 4 })).toBe(true);
  });

  it("filters the shared solver without altering four-player results", () => {
    const hand = [
      "1p",
      "2p",
      "3p",
      "1s",
      "2s",
      "3s",
      "7p",
      "8p",
      "9p",
      "5z",
      "5z",
      "5z",
      "5m",
    ];
    expect(waitsForRules(hand, 0, { playerCount: 4 })).toEqual(["5m"]);
    expect(waitsForRules(hand, 0, { playerCount: 3 })).toEqual([]);
  });
});
