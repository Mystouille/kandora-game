import { describe, expect, it } from "vitest";
import type { MatchView } from "../store";
import {
  activePlayerIndicatorSeat,
  buildResultYakuEntries,
  canInteractWithFocusedHand,
  formatTableScore,
  pointInsideRect,
  resolveSeatHandPresentation,
  riichiSelectionTileTint,
  resultScoreBoxLayout,
  shouldStageWinReveal,
  sortTilesForDisplay,
  topmostHandHoverTargetIndex,
  winResultRevealKey,
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

describe("activePlayerIndicatorSeat", () => {
  it("finds an unmelded seat holding fourteen tiles", () => {
    expect(activePlayerIndicatorSeat(turnView([13, 14, 13, 13]))).toBe(1);
  });

  it("accounts for three structural tiles per open meld", () => {
    expect(
      activePlayerIndicatorSeat(turnView([13, 11, 13, 13], [0, 1, 0, 0]))
    ).toBe(1);
  });

  it("follows the active opponent instead of the focused live player", () => {
    const liveView = {
      ...turnView([13, 14, 13, 13]),
      conn: "open" as const,
      mySeat: 0 as const,
    };

    expect(activePlayerIndicatorSeat(liveView)).toBe(1);
  });

  it("returns null while a kan caller is waiting for a replacement draw", () => {
    expect(
      activePlayerIndicatorSeat(turnView([13, 10, 13, 13], [0, 1, 0, 0]))
    ).toBe(null);
  });

  it("returns null after every seat has completed its turn", () => {
    expect(activePlayerIndicatorSeat(turnView([13, 13, 13, 13]))).toBe(null);
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

describe("resultScoreBoxLayout", () => {
  it("keeps cartridge dimensions fixed for short and long names", () => {
    const shortName = resultScoreBoxLayout(80, 0);
    const longName = resultScoreBoxLayout(360, 0);

    expect({ width: longName.width, height: longName.height }).toEqual({
      width: shortName.width,
      height: shortName.height,
    });
    expect(shortName.nameScale).toBe(1);
    expect(longName.nameScale).toBeLessThan(1);
  });

  it("reserves dealer text width and scales only the player name", () => {
    const withoutDealer = resultScoreBoxLayout(240, 0);
    const withDealer = resultScoreBoxLayout(240, 72);

    expect(withDealer.nameScale).toBeLessThan(withoutDealer.nameScale);
    expect(withDealer.width).toBe(withoutDealer.width);
    expect(withDealer.height).toBe(withoutDealer.height);
  });
});

describe("sortTilesForDisplay", () => {
  it("places a red five after lower tiles in call previews", () => {
    expect(sortTilesForDisplay(["0s", "4s"])).toEqual(["4s", "0s"]);
  });

  it("places a red five after a normal five and before six", () => {
    expect(sortTilesForDisplay(["6p", "0p", "5p", "4p"])).toEqual([
      "4p",
      "5p",
      "0p",
      "6p",
    ]);
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

describe("topmostHandHoverTargetIndex", () => {
  const bounds = [
    { x: 10, y: 20, width: 50, height: 80 },
    { x: 50, y: 20, width: 50, height: 80 },
  ];

  it("selects the topmost tile when identical copies overlap", () => {
    expect(topmostHandHoverTargetIndex({ x: 55, y: 40 }, bounds)).toBe(1);
  });

  it("clears hover when the pointer moves outside every tile", () => {
    expect(topmostHandHoverTargetIndex({ x: 105, y: 40 }, bounds)).toBeNull();
  });
});

describe("riichiSelectionTileTint", () => {
  it("darkens tiles that cannot declare riichi", () => {
    expect(riichiSelectionTileTint(true, false)).toBe(0xb0b0b0);
  });

  it("leaves legal and normal-play tiles unchanged", () => {
    expect(riichiSelectionTileTint(true, true)).toBeNull();
    expect(riichiSelectionTileTint(false, false)).toBeNull();
  });
});

describe("resolveSeatHandPresentation", () => {
  const liveHands = [
    ["1m", "2m", "3m"],
    [null, null, null],
    [null, null, null],
    [null, null, null],
  ];
  const historicalMeld = {
    type: "pon" as const,
    tiles: ["5p", "5p", "5p"],
    claimedTile: "5p",
    from: 2 as const,
  };
  const historicalResult: NonNullable<MatchView["lastHandResult"]> = {
    reason: "ron",
    wins: [
      {
        seat: 1,
        winTile: "9s",
        hand: ["1p", "2p", "3p"],
        melds: [historicalMeld],
      },
    ],
  };
  const view = {
    hands: liveHands,
    melds: [[], [], [], []],
    lastHandResult: null,
    mySeat: 0 as const,
    freshlyDrawnSeat: null,
  } as Pick<
    MatchView,
    "hands" | "melds" | "lastHandResult" | "mySeat" | "freshlyDrawnSeat"
  >;

  it("keeps the focused player's current hand during a history peek", () => {
    const focusedWin: NonNullable<MatchView["lastHandResult"]> = {
      ...historicalResult,
      wins: [{ ...historicalResult.wins![0], seat: 0 }],
    };

    const presentation = resolveSeatHandPresentation(view, focusedWin, 0);

    expect(presentation.animationHand).toBe(liveHands[0]);
    expect(presentation.displayHand).toBe(liveHands[0]);
    expect(presentation.historicalReveal).toBe(false);
  });

  it("uses live animation state while displaying an opponent's old hand and melds", () => {
    const presentation = resolveSeatHandPresentation(
      view,
      historicalResult,
      1
    );

    expect(presentation.animationHand).toBe(liveHands[1]);
    expect(presentation.displayHand).toEqual(["1p", "2p", "3p"]);
    expect(presentation.displayMelds).toEqual([historicalMeld]);
    expect(presentation.displayForceReveal).toBe(true);
    expect(presentation.historicalReveal).toBe(true);
  });
});

describe("canInteractWithFocusedHand", () => {
  it("keeps stored and live replay hands read-only", () => {
    expect(canInteractWithFocusedHand({ conn: "replay" })).toBe(false);
  });

  it("allows hand interaction during an actual game", () => {
    expect(canInteractWithFocusedHand({ conn: "open" })).toBe(true);
  });
});

describe("shouldStageWinReveal", () => {
  it("stages newly arrived live results", () => {
    expect(shouldStageWinReveal(true, false)).toBe(true);
  });

  it("keeps eye-button result overrides static", () => {
    expect(shouldStageWinReveal(true, true)).toBe(false);
  });

  it("keeps replay results static", () => {
    expect(shouldStageWinReveal(false, false)).toBe(false);
  });
});

describe("winResultRevealKey", () => {
  const view = {
    roundWind: "E" as const,
    roundNumber: 2,
    honba: 0,
    dealer: 1 as const,
  };
  const result: NonNullable<MatchView["lastHandResult"]> = {
    reason: "ron",
    delta: [-8000, 8000, 0, 0],
    wins: [
      {
        seat: 1,
        loser: 0,
        han: 3,
        fu: 40,
        ten: 8000,
        yaku: { Riichi: "1飜", Pinfu: "1飜" },
      },
    ],
  };

  it("keeps the reveal clock across equivalent result clones", () => {
    const clone: NonNullable<MatchView["lastHandResult"]> = {
      ...result,
      delta: result.delta ? [...result.delta] : undefined,
      wins: result.wins?.map((win) => ({
        ...win,
        yaku: win.yaku ? { ...win.yaku } : undefined,
      })),
    };

    expect(winResultRevealKey(view, clone)).toBe(
      winResultRevealKey(view, result)
    );
  });

  it("changes when a new hand with the same result begins", () => {
    expect(winResultRevealKey({ ...view, honba: 1 }, result)).not.toBe(
      winResultRevealKey(view, result)
    );
  });
});

describe("buildResultYakuEntries", () => {
  it("places tsumo before tanyao regardless of source order", () => {
    expect(
      buildResultYakuEntries(
        { Tanyao: "1飜", Tsumo: "1飜" },
        undefined,
        undefined,
        false
      )
    ).toEqual([
      { name: "Tsumo", value: "1飜", alwaysHidden: false },
      { name: "Tanyao", value: "1飜", alwaysHidden: false },
    ]);
  });

  it("separates structured regular and ura dora counts", () => {
    expect(
      buildResultYakuEntries({ Riichi: "1飜", Dora: "2飜" }, 1, 1, true)
    ).toEqual([
      { name: "Riichi", value: "1飜", alwaysHidden: false },
      { name: "Dora", value: "1飜", alwaysHidden: false },
      { name: "Ura Dora", value: "1飜", alwaysHidden: false },
    ]);
  });

  it("reserves an always-hidden row for zero ura dora", () => {
    expect(
      buildResultYakuEntries({ Riichi: "1飜", Dora: "1飜" }, 1, 0, true)
    ).toEqual([
      { name: "Riichi", value: "1飜", alwaysHidden: false },
      { name: "Dora", value: "1飜", alwaysHidden: false },
      { name: "Ura Dora", value: "0飜", alwaysHidden: true },
    ]);
  });

  it("does not reserve an ura row for non-riichi results", () => {
    expect(
      buildResultYakuEntries({ Tsumo: "1飜", Dora: "1飜" }, 1, undefined, false)
    ).toEqual([
      { name: "Tsumo", value: "1飜", alwaysHidden: false },
      { name: "Dora", value: "1飜", alwaysHidden: false },
    ]);
  });
});
