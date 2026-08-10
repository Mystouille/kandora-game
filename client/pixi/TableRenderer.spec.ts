import { describe, expect, it } from "vitest";
import type { MatchView } from "../store";
import {
  formatTableScore,
  pointInsideRect,
  replayDiscardingSeat,
} from "./TableRenderer";

type ReplayTurnView = Pick<
  MatchView,
  "hands" | "melds" | "lastHandResult" | "matchEnded"
>;

function turnView(
  handSizes: [number, number, number, number],
  meldCounts: [number, number, number, number] = [0, 0, 0, 0]
): ReplayTurnView {
  return {
    hands: handSizes.map((size) => Array(size).fill(null)),
    melds: meldCounts.map((count) =>
      Array(count).fill({ type: "pon", tiles: ["1m", "1m", "1m"] })
    ),
    lastHandResult: null,
    matchEnded: null,
  } as ReplayTurnView;
}

describe("replayDiscardingSeat", () => {
  it("finds an unmelded seat holding fourteen tiles", () => {
    expect(replayDiscardingSeat(turnView([13, 14, 13, 13]))).toBe(1);
  });

  it("accounts for three structural tiles per open meld", () => {
    expect(replayDiscardingSeat(turnView([13, 11, 13, 13], [0, 1, 0, 0]))).toBe(
      1
    );
  });

  it("returns null while a kan caller is waiting for a replacement draw", () => {
    expect(replayDiscardingSeat(turnView([13, 10, 13, 13], [0, 1, 0, 0]))).toBe(
      null
    );
  });

  it("returns null after every seat has completed its turn", () => {
    expect(replayDiscardingSeat(turnView([13, 13, 13, 13]))).toBe(null);
  });
});

describe("formatTableScore", () => {
  it("keeps absolute scores unchanged", () => {
    expect(formatTableScore(31500, 25000, false)).toBe("31500");
  });

  it("prefixes strictly positive relative scores with a plus", () => {
    expect(formatTableScore(31500, 25000, true)).toBe("+6500");
  });

  it("does not prefix zero or negative relative scores", () => {
    expect(formatTableScore(25000, 25000, true)).toBe("0");
    expect(formatTableScore(18700, 25000, true)).toBe("-6300");
  });
});

describe("pointInsideRect", () => {
  const rect = { x: 100, y: 200, w: 300, h: 150 };

  it("includes the panel interior and edges", () => {
    expect(pointInsideRect({ x: 250, y: 275 }, rect)).toBe(true);
    expect(pointInsideRect({ x: 100, y: 200 }, rect)).toBe(true);
    expect(pointInsideRect({ x: 400, y: 350 }, rect)).toBe(true);
  });

  it("excludes points outside the panel", () => {
    expect(pointInsideRect({ x: 99, y: 275 }, rect)).toBe(false);
    expect(pointInsideRect({ x: 250, y: 351 }, rect)).toBe(false);
  });
});
