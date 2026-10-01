import { describe, expect, it } from "vitest";
import type { HandResult } from "../scene/renderTypes";
import {
  activePlayerIndicatorSeat,
  advanceMatchEndRevealSound,
  buildResultYakuEntries,
  formatTableScore,
  handResultDealerSeat,
  resultUraDoraIndicators,
  shouldRevealWinScoreDelta,
  shouldRevealWinScoreSummary,
  shouldStageWinReveal,
  uraDoraRevealAtMs,
  winResultRevealKey,
} from "../geometry/resultReveal";
import {
  resultScoreBoxLayout,
  scoreCartridgeFontSize,
  scoreCartridgeMetrics,
  scoreCartridgeScoreScale,
  scoreCartridgeTextLayout,
} from "../geometry/scoreGeometry";

describe("result reveal compatibility helpers", () => {
  const result: HandResult = {
    reason: "ron",
    delta: [1_000, -1_000, 0, 0],
    wins: [{ seat: 0, yaku: { Riichi: "1飜" }, han: 1, fu: 30 }],
  };
  const round = {
    roundWind: "E" as const,
    roundNumber: 1,
    honba: 0,
    dealer: 0 as const,
  };

  it("uses result value identity rather than object identity", () => {
    expect(winResultRevealKey(round, result)).toBe(
      winResultRevealKey(round, { ...result })
    );
    expect(winResultRevealKey({ ...round, honba: 1 }, result)).not.toBe(
      winResultRevealKey(round, result)
    );
  });

  it("bypasses staged reveal for historical overrides", () => {
    expect(shouldStageWinReveal(true, false)).toBe(true);
    expect(shouldStageWinReveal(true, true)).toBe(false);
    expect(shouldStageWinReveal(false, false)).toBe(false);
  });

  it("reserves the dedicated ura beat after regular yaku", () => {
    expect(uraDoraRevealAtMs(3, true)).toBe(3_500);
    expect(shouldRevealWinScoreSummary(true, 3_499, 3, true)).toBe(false);
    expect(shouldRevealWinScoreSummary(true, 3_500, 3, true)).toBe(true);
    expect(shouldRevealWinScoreDelta(true, 3_500, 3, true)).toBe(true);
    expect(shouldRevealWinScoreSummary(true, 2_249, 2, false, false)).toBe(
      false
    );
    expect(shouldRevealWinScoreSummary(true, 2_250, 2, false, false)).toBe(
      true
    );
    expect(shouldRevealWinScoreSummary(false, 0, 10, true)).toBe(true);
  });

  it("keeps zero ura reserved and hidden while omitting zero regular yaku", () => {
    expect(
      buildResultYakuEntries(
        { Riichi: "1飜", Dora: "0飜", "Ura Dora": "0飜" },
        0,
        0,
        true
      )
    ).toEqual([
      { name: "Riichi", value: "1飜", alwaysHidden: false },
      { name: "Ura Dora", value: "0飜", alwaysHidden: true },
    ]);
  });

  it("overrides explicit dora counts and moves positive ura last", () => {
    const entries = buildResultYakuEntries(
      { "Ura Dora": "2飜", Riichi: "1飜", Dora: "1飜" },
      3,
      4,
      true
    );
    expect(entries.find((entry) => entry.name === "Dora")?.value).toBe("3飜");
    expect(entries.at(-1)).toEqual({
      name: "Ura Dora",
      value: "4飜",
      alwaysHidden: false,
    });
    expect(
      buildResultYakuEntries({ "Ura Dora": "2飜" }, undefined, 2, true, false)
    ).toEqual([]);
  });

  it("uses shared winner ura only when that rule is enabled", () => {
    const wins = [
      { seat: 0 as const },
      { seat: 1 as const, uraDoraIndicators: ["2p"] },
    ];
    expect(resultUraDoraIndicators(true, wins)).toEqual(["2p"]);
    expect(resultUraDoraIndicators(false, wins)).toEqual([]);
  });

  it("retains the result-time dealer and legacy score formatting", () => {
    expect(handResultDealerSeat({ ...result, dealer: 2 }, 0)).toBe(2);
    expect(handResultDealerSeat(result, 0)).toBe(0);
    expect(formatTableScore(26_000, 25_000, true)).toBe("+1000");
    expect(formatTableScore(24_000, 25_000, true)).toBe("-1000");
    expect(formatTableScore(25_000, 25_000, true)).toBe("0");
    expect(formatTableScore(26_000, 25_000, false)).toBe("26000");
  });

  it("emits match-end reveal sound once only after a visible panel", () => {
    expect(advanceMatchEndRevealSound(false, true, false)).toEqual({
      play: false,
      nextPlayed: false,
    });
    expect(advanceMatchEndRevealSound(false, true, true)).toEqual({
      play: true,
      nextPlayed: true,
    });
    expect(advanceMatchEndRevealSound(true, true, true)).toEqual({
      play: false,
      nextPlayed: true,
    });
    expect(advanceMatchEndRevealSound(true, false, false)).toEqual({
      play: false,
      nextPlayed: false,
    });
  });

  it("finds the complete structural hand and hides the active marker for results", () => {
    const view = {
      hands: [
        Array<string | null>(13).fill(null),
        Array<string | null>(11).fill(null),
        [],
        [],
      ],
      melds: [
        [],
        [
          {
            type: "pon" as const,
            tiles: ["1m", "1m", "1m"],
            from: 0 as const,
            claimedTile: "1m",
          },
        ],
        [],
        [],
      ],
      lastHandResult: null,
      matchEnded: null,
    };
    expect(activePlayerIndicatorSeat(view)).toBe(1);
    expect(
      activePlayerIndicatorSeat({ ...view, lastHandResult: result })
    ).toBeNull();
  });
});

describe("score geometry compatibility", () => {
  it("retains cartridge rounding and bottom status anchor", () => {
    expect(scoreCartridgeMetrics({ x: 10, y: 20, w: 250, h: 200 })).toEqual({
      width: 125,
      height: 32,
      inset: 16,
      bottomTop: 172,
    });
    expect(scoreCartridgeTextLayout(125, 32)).toEqual({
      scoreRightX: 51.5,
      seatIndicatorLeftX: -58.5,
    });
    expect(scoreCartridgeTextLayout(125, 32, "mobile").scoreRightX).toBe(58.5);
  });

  it("shrinks mobile score text only to clear the wind kanji", () => {
    expect(scoreCartridgeScoreScale(125, 32, 200, 32)).toBe(83 / 200);
    expect(scoreCartridgeScoreScale(125, 32, 0, 32)).toBe(1);
    expect(scoreCartridgeFontSize(32, "mobile")).toBe(22);
    expect(scoreCartridgeFontSize(32, "standard")).toBe(19);
  });

  it("keeps fixed result score boxes while shrinking only long names", () => {
    expect(resultScoreBoxLayout(100, 0)).toEqual({
      width: 220,
      height: 88,
      nameScale: 1,
    });
    expect(resultScoreBoxLayout(300, 70).nameScale).toBe(106 / 300);
  });
});
