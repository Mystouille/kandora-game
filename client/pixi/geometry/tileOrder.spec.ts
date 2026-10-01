import { describe, expect, it } from "vitest";
import {
  ankanTilesForDisplay,
  sortHand,
  sortTilesForDisplay,
  tileNum,
  tileSortKey,
} from "./tileOrder";

describe("extracted tile display order", () => {
  it("keeps suit order and places red fives between five and six", () => {
    const tiles = ["1z", "6m", "0m", "5m", "9s", "1p"];
    expect(sortTilesForDisplay(tiles)).toEqual([
      "5m",
      "0m",
      "6m",
      "1p",
      "9s",
      "1z",
    ]);
    expect(tiles[0]).toBe("1z");
    expect(tileSortKey("0p")).toBe(105.5);
  });

  it("preserves hidden-hand identity and the explicitly fresh last tile", () => {
    const hidden = ["3m", null, "1m"];
    expect(sortHand(hidden, false)).toBe(hidden);
    expect(sortHand(["3m", "2m", "1m"], true)).toEqual(["2m", "3m", "1m"]);
    expect(sortHand(["3m", "2m", "1m"], false)).toEqual(["1m", "2m", "3m"]);
    expect(sortHand(["1m"], true)).toEqual(["1m"]);
  });

  it("keeps the red ankan face visible without altering short groups", () => {
    expect(ankanTilesForDisplay(["5m", "5m", "0m", "5m"])).toEqual([
      "5m",
      "0m",
      "5m",
      "5m",
    ]);
    expect(ankanTilesForDisplay(["0m", "5m"])).toEqual(["5m", "0m"]);
    expect(tileNum("0s")).toBe("5");
    expect(tileNum("7z")).toBe("7z");
    expect(tileNum("9p")).toBe("9");
  });
});
