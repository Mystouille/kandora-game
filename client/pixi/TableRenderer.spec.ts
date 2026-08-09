import { describe, expect, it } from "vitest";
import type { MatchView } from "../store";
import { replayDiscardingSeat } from "./TableRenderer";

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
