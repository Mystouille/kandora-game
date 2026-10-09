import { describe, expect, it } from "vitest";
import type { MatchView } from "../../store";
import type { HandResult } from "../scene/renderTypes";
import {
  resolveSeatHandPresentation,
  resultSeatReveal,
} from "./handPresentation";

type PresentationView = Parameters<typeof resolveSeatHandPresentation>[0];

function view(overrides: Partial<PresentationView> = {}): PresentationView {
  return {
    hands: [["3m", "1m", "2m"], [null, null, null], [], []],
    melds: [[], [], [], []],
    lastHandResult: null,
    mySeat: 0,
    freshlyDrawnSeat: 0,
    ryuukyokuDeclarations: [null, null, null, null],
    ryuukyokuTenpaiHands: [null, null, null, null],
    ...overrides,
  };
}

describe("extracted hand presentation", () => {
  const oldResult: HandResult = {
    reason: "ron",
    wins: [
      {
        seat: 1,
        winTile: "3p",
        hand: ["1p", "3p"],
        melds: [
          {
            type: "pon",
            tiles: ["5s", "5s", "5s"],
            claimedTile: "5s",
            from: 2,
          },
        ],
      },
    ],
  };

  it("keeps historical hands out of the live animation source", () => {
    const current = view();
    const opponent = resolveSeatHandPresentation(current, oldResult, 1);
    expect(opponent.animationHand).toBe(current.hands[1]);
    expect(opponent.displayHand).toEqual(["1p"]);
    expect(opponent.displayMelds).toEqual(oldResult.wins?.[0].melds);
    expect(opponent.historicalReveal).toBe(true);
    expect(resolveSeatHandPresentation(current, oldResult, 0).displayHand).toBe(
      current.hands[0]
    );
  });

  it("separates only the winning tsumo tile and masks other result hands", () => {
    const result: HandResult = { ...oldResult, reason: "tsumo" };
    expect(resultSeatReveal(result, 1)).toMatchObject({
      hand: ["1p", "3p"],
      separatesLastTile: true,
      winning: true,
    });
    const current = view({ lastHandResult: result });
    expect(resolveSeatHandPresentation(current, null, 0)).toMatchObject({
      animationHand: [null, null, null],
      displayHand: [null, null, null],
      maskedForResult: true,
      displaySeparatesLastTile: false,
      displayWinningReveal: false,
    });
    expect(resolveSeatHandPresentation(current, null, 1)).toMatchObject({
      displayWinningReveal: true,
    });
  });

  it("reveals tenpai declarations and masks noten before hand_end", () => {
    const current = view({
      ryuukyokuDeclarations: [false, true, null, null],
      ryuukyokuTenpaiHands: [null, ["4m", "5m", "6m"], null, null],
    });
    expect(resolveSeatHandPresentation(current, null, 0).maskedForResult).toBe(
      true
    );
    expect(resolveSeatHandPresentation(current, null, 1)).toMatchObject({
      animationHand: ["4m", "5m", "6m"],
      animationForceReveal: true,
      historicalReveal: false,
    });
  });

  it("reveals exhaustive and kyuushuu tenpai, but does not mask other aborts", () => {
    const tenpaiHands: MatchView["ryuukyokuTenpaiHands"] = [
      ["1m", "2m", "3m"],
      null,
      null,
      null,
    ];
    for (const result of [
      { reason: "exhaustive_draw", tenpaiHands } satisfies HandResult,
      {
        reason: "abort",
        abortKind: "kyuushuu",
        tenpaiHands,
      } satisfies HandResult,
    ]) {
      expect(resultSeatReveal(result, 0)?.hand).toEqual(tenpaiHands[0]);
    }
    const current = view({
      lastHandResult: { reason: "abort", abortKind: "suufon_renda" },
    });
    expect(resolveSeatHandPresentation(current, null, 1).maskedForResult).toBe(
      false
    );
  });
});
