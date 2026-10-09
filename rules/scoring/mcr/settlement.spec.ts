import { describe, expect, it } from "vitest";
import { settleMcrWin } from "./settlement";

describe("MCR settlement", () => {
  it("charges every opponent fan plus eight for self-draw", () => {
    expect(
      settleMcrWin({
        method: "self-draw",
        winner: 1,
        totalFan: 12,
        nonFlowerFan: 8,
      })
    ).toEqual([-20, 60, -20, -20]);
  });

  it("charges the discarder fan plus eight and the others eight", () => {
    expect(
      settleMcrWin({
        method: "discard",
        winner: 2,
        discarder: 0,
        totalFan: 12,
        nonFlowerFan: 8,
      })
    ).toEqual([-20, -8, 36, -8]);
  });

  it("is zero-sum and includes flower points only after qualification", () => {
    const deltas = settleMcrWin({
      method: "self-draw",
      winner: 3,
      totalFan: 11,
      nonFlowerFan: 8,
    });
    expect(deltas).toEqual([-19, -19, -19, 57]);
    expect(deltas.reduce((sum, value) => sum + value, 0)).toBe(0);
    expect(() =>
      settleMcrWin({
        method: "discard",
        winner: 2,
        discarder: 0,
        totalFan: 15,
        nonFlowerFan: 7,
      })
    ).toThrow(/eight non-flower/i);
  });

  it("rejects invalid or self-discarding seats", () => {
    expect(() =>
      settleMcrWin({
        method: "discard",
        winner: 2,
        discarder: 2,
        totalFan: 8,
        nonFlowerFan: 8,
      })
    ).toThrow(/different discarder/i);
    expect(() =>
      settleMcrWin({
        method: "discard",
        winner: 2,
        discarder: 4 as 0,
        totalFan: 8,
        nonFlowerFan: 8,
      })
    ).toThrow(/zero through three/i);
  });
});
