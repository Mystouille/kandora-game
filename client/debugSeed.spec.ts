import { describe, expect, it } from "vitest";
import { parseTileList } from "./debugSeed";

describe("debug seed tile notation", () => {
  it("accepts compact groups, individual tiles, red fives, and MCR flowers", () => {
    expect(parseTileList("123P, 0s\n17z 18F, 2f")).toEqual({
      tiles: ["1p", "2p", "3p", "0s", "1z", "7z", "1f", "8f", "2f"],
      invalid: [],
    });
  });

  it.each(["0f", "9f", "0z", "8z", "12f9z", "1p2", "m123", "flowers"])(
    "rejects the whole invalid token %s without partially applying it",
    (token) => {
      expect(parseTileList(`1m ${token} 9s`)).toEqual({
        tiles: ["1m", "9s"],
        invalid: [token],
      });
    }
  );

  it("leaves blank inputs at the random default", () => {
    expect(parseTileList(" \n, ")).toEqual({ tiles: [], invalid: [] });
  });
});
