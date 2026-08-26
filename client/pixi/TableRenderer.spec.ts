import { describe, expect, it } from "vitest";
import type { MatchView } from "../store";
import {
  activePlayerIndicatorSeat,
  actionButtonLabel,
  actionButtonStyle,
  ankanTilesForDisplay,
  buildResultYakuEntries,
  canInteractWithFocusedHand,
  centerCounterCells,
  centerCounterSpecs,
  centerDoraIndicatorSlots,
  centerDoraRowGeometry,
  centerInfoInnerRect,
  CENTER_DORA_INDICATOR_GAP,
  darkenTileTint,
  focusedHandTileMetrics,
  formatTableScore,
  handResultDealerSeat,
  layoutMeldStripGroups,
  layoutTouchingMeldColumn,
  MOBILE_RIICHI_STICK,
  WEB_RIICHI_STICK,
  fitCounterContentInCell,
  mobileRiichiStickPlacement,
  playerIdentityCenter,
  pointInsideRect,
  resolveSeatHandPresentation,
  riichiStickMetrics,
  riichiSelectionTileTint,
  resultScoreBoxLayout,
  shouldRevealWinScoreDelta,
  shouldRevealWinScoreSummary,
  shouldStageWinReveal,
  shouldTintTsumogiri,
  sortTilesForDisplay,
  tableRenderPolicy,
  TEAM_LOGO_Z_INDEX,
  topmostHandHoverTargetIndex,
  wallZIndex,
  winResultRevealKey,
} from "./TableRenderer";
import { mobileTableLayout } from "./layouts/mobileTableLayout";
import { compactWebTableLayout } from "./layouts/compactWebTableLayout";
import { currentTableLayout } from "./layouts/currentTableLayout";
import { tableLayoutFromConfig } from "./tableLayout";

describe("handResultDealerSeat", () => {
  it("uses the completed hand dealer instead of the current dealer", () => {
    expect(
      handResultDealerSeat(
        { reason: "ron", dealer: 2 },
        1
      )
    ).toBe(2);
  });

  it("falls back for legacy results without a stored dealer", () => {
    expect(handResultDealerSeat({ reason: "ron" }, 1)).toBe(1);
  });
});

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

describe("mobile action buttons", () => {
  it("uses larger translucent controls without changing desktop metrics", () => {
    const desktop = actionButtonStyle("standard");
    const mobile = actionButtonStyle("mobile");

    expect(desktop.height).toBe(64);
    expect(desktop.fillAlpha).toBe(1);
    expect(mobile.height).toBe(108);
    expect(mobile.height).toBeGreaterThan(desktop.height);
    expect(mobile.minActionWidth).toBeGreaterThan(desktop.minActionWidth);
    expect(mobile.fillAlpha).toBeGreaterThan(0);
    expect(mobile.fillAlpha).toBeLessThan(1);
  });

  it("labels the pass transport action as Skip", () => {
    expect(actionButtonLabel({ id: "pass", type: "pass" })).toBe("Skip");
  });
});

describe("tsumogiri tint modes", () => {
  it("keeps the short fresh cue used by game views", () => {
    expect(shouldTintTsumogiri(true, "fresh", 0)).toBe(true);
    expect(shouldTintTsumogiri(true, "fresh", 2)).toBe(true);
    expect(shouldTintTsumogiri(true, "fresh", 3)).toBe(false);
  });

  it("shows or hides every recorded tsumogiri in replay modes", () => {
    expect(shouldTintTsumogiri(true, "all", 99)).toBe(true);
    expect(shouldTintTsumogiri(true, "none", 0)).toBe(false);
    expect(shouldTintTsumogiri(false, "all", 0)).toBe(false);
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

describe("mobile table presentation", () => {
  const layout = tableLayoutFromConfig(mobileTableLayout);

  it("caps the focused tiles so a full pond remains clear", () => {
    const metrics = focusedHandTileMetrics(layout, "mobile");

    expect(metrics.spriteH).toBeCloseTo(115);
    expect(metrics.spriteH).toBeCloseTo(layout.hands[0].h);
    expect(metrics.tile.w * 14 + 8).toBeLessThan(layout.hands[0].w);
  });

  it("shows five dead-wall indicator tops with unrevealed backs", () => {
    expect(CENTER_DORA_INDICATOR_GAP).toBe(0);
    expect(centerDoraIndicatorSlots(["4m"])).toEqual([
      "4m",
      null,
      null,
      null,
      null,
    ]);
    expect(
      centerDoraIndicatorSlots(["4m", "7p", "2s", "1z", "6m"])
    ).toEqual(["4m", "7p", "2s", "1z", "6m"]);
  });

  it("fits the dora row directly between both side score cartridges", () => {
    const center = layout.center;
    const dora = centerDoraRowGeometry(center, 5);

    expect(dora.x).toBe(561);
    expect(dora.width).toBe(158);
    expect(dora.tileW * 5).toBeCloseTo(dora.width);
    expect(dora.x + dora.width).toBe(719);
  });

  it("bounds all three counters inside the score-cartridge borders", () => {
    const center = layout.center;
    const inner = centerInfoInnerRect(center);
    const cells = centerCounterCells(center, 3);

    expect(inner).toEqual({ x: 561, y: 278, w: 158, h: 114 });
    expect(cells).toHaveLength(3);
    expect(cells[0].x).toBe(inner.x);
    expect(cells[2].x + cells[2].w).toBeCloseTo(inner.x + inner.w);
    for (let index = 0; index < cells.length - 1; index += 1) {
      expect(cells[index].x + cells[index].w).toBeCloseTo(cells[index + 1].x);
    }

    const content = { minX: -9, minY: -10, maxX: 39, maxY: 10 };
    for (const cell of cells) {
      const fitted = fitCounterContentInCell(content, cell, 3);
      expect(fitted.x + content.minX * fitted.scale).toBeGreaterThanOrEqual(
        cell.x + 3
      );
      expect(fitted.x + content.maxX * fitted.scale).toBeLessThanOrEqual(
        cell.x + cell.w - 3
      );
      expect(fitted.y + content.minY * fitted.scale).toBeGreaterThanOrEqual(
        cell.y + 3
      );
      expect(fitted.y + content.maxY * fitted.scale).toBeLessThanOrEqual(
        cell.y + cell.h - 3
      );
    }
  });

  it("places larger mobile riichi sticks just outside every discard mat", () => {
    const discardPanels = [
      { x: 504, y: 441, w: 272, h: 164 },
      { x: 768, y: 212, w: 166, h: 237 },
      { x: 504, y: 101, w: 272, h: 164 },
      { x: 346, y: 212, w: 166, h: 237 },
    ];

    expect(MOBILE_RIICHI_STICK.width).toBeGreaterThan(90);
    expect(MOBILE_RIICHI_STICK.height).toBeGreaterThan(8);
    const placements = discardPanels.map((panel, seat) =>
      mobileRiichiStickPlacement(panel, layout.center, seat as 0 | 1 | 2 | 3)
    );
    expect(placements[0].bounds.y + placements[0].bounds.h).toBe(
      discardPanels[0].y - MOBILE_RIICHI_STICK.gap
    );
    expect(placements[1].bounds.x + placements[1].bounds.w).toBe(
      discardPanels[1].x - MOBILE_RIICHI_STICK.gap
    );
    expect(placements[2].bounds.y).toBe(
      discardPanels[2].y +
        discardPanels[2].h +
        MOBILE_RIICHI_STICK.gap
    );
    expect(placements[3].bounds.x).toBe(
      discardPanels[3].x +
        discardPanels[3].w +
        MOBILE_RIICHI_STICK.gap
    );
  });

  it("stacks four side meld groups into one touching player-relative column", () => {
    const bounds = [
      { minY: -8, maxY: 52 },
      { minY: 0, maxY: 60 },
      { minY: -4, maxY: 56 },
      { minY: 2, maxY: 62 },
    ];
    const layout = layoutTouchingMeldColumn(
      [80, 80, 80, 80],
      bounds
    );

    expect(layout).toEqual({
      width: 80,
      placements: [
        { x: 0, y: -170 },
        { x: 0, y: -118 },
        { x: 0, y: -54 },
        { x: 0, y: 0 },
      ],
    });
    for (let index = 0; index < bounds.length - 1; index += 1) {
      expect(layout.placements[index].y + bounds[index].maxY).toBe(
        layout.placements[index + 1].y + bounds[index + 1].minY
      );
    }
  });

  it("keeps ordinary meld strips on one row", () => {
    expect(layoutMeldStripGroups([80, 80, 80], -16)).toEqual({
      width: 208,
      placements: [
        { x: 0, y: 0 },
        { x: 64, y: 0 },
        { x: 128, y: 0 },
      ],
    });
  });
});

describe("riichi stick presentation", () => {
  it("scales every web stick dimension and visual proportion by 80 percent", () => {
    expect(WEB_RIICHI_STICK).toEqual({
      width: 90 * 1.8,
      height: 8 * 1.8,
      gap: 10 * 1.8,
      dotRadius: 2.5 * 1.8,
      cornerRadius: 3 * 1.8,
    });
    expect(riichiStickMetrics("standard")).toBe(WEB_RIICHI_STICK);
  });

  it("keeps the standalone mobile stick metrics unchanged", () => {
    expect(MOBILE_RIICHI_STICK).toEqual({
      width: 120,
      height: 12,
      gap: 1,
      dotRadius: 3.5,
      cornerRadius: 3,
    });
    expect(riichiStickMetrics("mobile")).toBe(MOBILE_RIICHI_STICK);
  });
});

describe("web table layouts", () => {
  it("renders perimeter walls only in the standard web layout", () => {
    expect(tableRenderPolicy("standard", "standard")).toEqual({
      indicatorCenter: false,
      perimeterWalls: true,
    });
    expect(tableRenderPolicy("standard", "compact")).toEqual({
      indicatorCenter: true,
      perimeterWalls: false,
    });
    expect(tableRenderPolicy("mobile", "standard")).toEqual({
      indicatorCenter: true,
      perimeterWalls: false,
    });
  });

  it("keeps team logos below every perimeter wall", () => {
    const wallLayers = ([0, 1, 2, 3] as const).map((seat) =>
      wallZIndex(seat)
    );

    expect(TEAM_LOGO_Z_INDEX).toBeLessThan(Math.min(...wallLayers));
  });

  it("halves the player-local top gap to the discard on the right", () => {
    const discardPanels = [
      { x: 400, y: 500, w: 200, h: 150 },
      { x: 600, y: 300, w: 150, h: 200 },
      { x: 400, y: 150, w: 200, h: 150 },
      { x: 250, y: 300, w: 150, h: 200 },
    ] as const;
    const centers = ([0, 1, 2, 3] as const).map((seat) =>
      playerIdentityCenter(discardPanels, seat)
    );

    expect(centers).toEqual([
      { x: 686, y: 575 },
      { x: 675, y: 214 },
      { x: 314, y: 225 },
      { x: 325, y: 586 },
    ]);
    expect(centers[0].y - 60 - (discardPanels[1].y + discardPanels[1].h)).toBe(
      15
    );
    expect(centers[1].x - 60 - (discardPanels[2].x + discardPanels[2].w)).toBe(
      15
    );
    expect(discardPanels[3].y - (centers[2].y + 60)).toBe(15);
    expect(discardPanels[0].x - (centers[3].x + 60)).toBe(15);
  });

  it("builds three icon counters, or two in Buu mode", () => {
    const counters = centerCounterSpecs({
      buuMode: false,
      honba: 3,
      riichiSticks: 4,
      drawsTaken: 12,
    });
    expect(counters.map(({ kind, value }) => ({ kind, value }))).toEqual([
      { kind: "honba", value: 3 },
      { kind: "riichi", value: 4 },
      { kind: "tiles", value: 58 },
    ]);
    expect(
      centerCounterSpecs({
        buuMode: true,
        honba: 3,
        riichiSticks: 4,
        drawsTaken: 80,
      }).map(({ kind, value }) => ({ kind, value }))
    ).toEqual([
      { kind: "riichi", value: 4 },
      { kind: "tiles", value: 0 },
    ]);
  });

  it("fits inline counters in both standard and compact centers", () => {
    for (const config of [currentTableLayout, compactWebTableLayout]) {
      const center = tableLayoutFromConfig(config).center;
      const inner = centerInfoInnerRect(center);
      const cells = centerCounterCells(center, 3);
      expect(cells).toHaveLength(3);
      expect(cells[0].x).toBe(inner.x);
      expect(cells[2].x + cells[2].w).toBeCloseTo(inner.x + inner.w);
      expect(inner.h).toBeGreaterThan(100);
    }
  });

  it("gives compact mode five usable center indicator slots", () => {
    const center = tableLayoutFromConfig(compactWebTableLayout).center;
    const inner = centerInfoInnerRect(center);
    const dora = centerDoraRowGeometry(center, 5);
    expect(inner).toEqual({ x: 413, y: 369, w: 174, h: 134 });
    expect(dora.x).toBe(inner.x);
    expect(dora.width).toBe(inner.w);
    expect(dora.tileW).toBeCloseTo(34.8);
    expect(dora.tileH).toBeLessThan(inner.h / 2);
  });

  it("keeps desktop focused-hand metrics in compact mode", () => {
    const standardMetrics = focusedHandTileMetrics(
      tableLayoutFromConfig(currentTableLayout),
      "standard"
    );
    const compactMetrics = focusedHandTileMetrics(
      tableLayoutFromConfig(compactWebTableLayout),
      "standard"
    );
    expect(compactMetrics).toEqual(standardMetrics);
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

describe("ankanTilesForDisplay", () => {
  it.each(["m", "p", "s"])(
    "places the red five of %s in a visible middle slot",
    (suit) => {
      const normal = `5${suit}`;
      const red = `0${suit}`;
      const ordered = ankanTilesForDisplay([normal, normal, normal, red]);

      expect(ordered).toHaveLength(4);
      expect(ordered.slice(1, 3)).toContain(red);
    }
  );

  it("keeps a non-red ankan naturally ordered", () => {
    expect(ankanTilesForDisplay(["7z", "7z", "7z", "7z"])).toEqual([
      "7z",
      "7z",
      "7z",
      "7z",
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

describe("darkenTileTint", () => {
  it("darkens a neutral tile without changing its hue", () => {
    expect(darkenTileTint(0xffffff, 0.78)).toBe(0xc7c7c7);
  });

  it("preserves an existing colored tint while darkening it", () => {
    expect(darkenTileTint(0xff5555, 0.78)).toBe(0xc74242);
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

describe("shouldRevealWinScoreSummary", () => {
  it("reveals one beat after the final regular yaku", () => {
    expect(shouldRevealWinScoreSummary(true, 2_999, 3, false, false)).toBe(
      false
    );
    expect(shouldRevealWinScoreSummary(true, 3_000, 3, false, false)).toBe(
      true
    );
  });

  it("reveals one beat after a positive ura-dora yaku", () => {
    expect(shouldRevealWinScoreSummary(true, 3_749, 4, true, true)).toBe(
      false
    );
    expect(shouldRevealWinScoreSummary(true, 3_750, 4, true, true)).toBe(true);
  });

  it("waits for the zero-ura indicator flip before the final beat", () => {
    expect(shouldRevealWinScoreSummary(true, 3_999, 3, false, true)).toBe(
      false
    );
    expect(shouldRevealWinScoreSummary(true, 4_000, 3, false, true)).toBe(true);
  });

  it("keeps static replay and history results fully visible", () => {
    expect(shouldRevealWinScoreSummary(false, 0, 3, false, true)).toBe(true);
  });
});

describe("shouldRevealWinScoreDelta", () => {
  it("reveals when the final yaku appears", () => {
    expect(shouldRevealWinScoreDelta(true, 2_249, 3)).toBe(false);
    expect(shouldRevealWinScoreDelta(true, 2_250, 3)).toBe(true);
  });

  it("keeps static replay and history deltas visible", () => {
    expect(shouldRevealWinScoreDelta(false, 0, 3)).toBe(true);
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
