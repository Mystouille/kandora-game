import type { MatchView } from "../../store";
import type { Meld } from "~/game/protocol/messages";
import type { Seat } from "../tableGeometry";
import type { HandResult } from "../scene/renderTypes";
import { splitWinningHandForDisplay } from "../winningHand";

export interface ResultSeatReveal {
  hand: Array<string | null>;
  melds: Meld[] | null;
  separatesLastTile: boolean;
}

export interface SeatHandPresentation {
  animationHand: Array<string | null>;
  animationForceReveal: boolean;
  animationSeparatesLastTile: boolean;
  displayHand: Array<string | null>;
  displayMelds: Meld[];
  displayForceReveal: boolean;
  displaySeparatesLastTile: boolean;
  maskedForResult: boolean;
  historicalReveal: boolean;
}

export function resultSeatReveal(
  result: HandResult | null,
  seat: Seat
): ResultSeatReveal | null {
  if (!result) {
    return null;
  }
  const win = result.wins?.find((candidate) => candidate.seat === seat);
  if (win?.hand && win.hand.length > 0) {
    const { concealed, agari } = splitWinningHandForDisplay(
      win.hand,
      win.winTile
    );
    const separatesLastTile = result.reason === "tsumo" && agari !== undefined;
    return {
      hand: separatesLastTile ? [...concealed, agari] : concealed,
      melds: win.melds ?? null,
      separatesLastTile,
    };
  }
  if (
    (result.reason === "exhaustive_draw" ||
      (result.reason === "abort" && result.abortKind === "kyuushuu")) &&
    result.tenpaiHands?.[seat]?.length
  ) {
    return {
      hand: [...result.tenpaiHands[seat]],
      melds: null,
      separatesLastTile: false,
    };
  }
  return null;
}

export function resultSeatMask(
  result: HandResult | null,
  reveal: ResultSeatReveal | null,
  liveHand: Array<string | null>
): Array<null> | null {
  if (
    reveal !== null ||
    (result?.reason !== "ron" &&
      result?.reason !== "tsumo" &&
      result?.reason !== "exhaustive_draw")
  ) {
    return null;
  }
  return liveHand.map(() => null);
}

export function resolveSeatHandPresentation(
  view: Pick<
    MatchView,
    | "hands"
    | "melds"
    | "lastHandResult"
    | "mySeat"
    | "freshlyDrawnSeat"
    | "ryuukyokuDeclarations"
    | "ryuukyokuTenpaiHands"
  >,
  historicalResult: HandResult | null,
  seat: Seat
): SeatHandPresentation {
  const liveHand = view.hands[seat] ?? [];
  const liveMelds = view.melds[seat] ?? [];
  const declaredTenpaiHand =
    view.ryuukyokuDeclarations[seat] === true
      ? view.ryuukyokuTenpaiHands[seat]
      : null;
  const declarationReveal: ResultSeatReveal | null = declaredTenpaiHand?.length
    ? {
        hand: [...declaredTenpaiHand],
        melds: null,
        separatesLastTile: false,
      }
    : null;
  const currentReveal =
    resultSeatReveal(view.lastHandResult, seat) ?? declarationReveal;
  const declarationMask: Array<null> | null =
    view.lastHandResult === null && view.ryuukyokuDeclarations[seat] === false
      ? liveHand.map(() => null)
      : null;
  const currentMask =
    resultSeatMask(view.lastHandResult, currentReveal, liveHand) ??
    declarationMask;
  const historicalReveal =
    view.lastHandResult === null && seat !== view.mySeat
      ? resultSeatReveal(historicalResult, seat)
      : null;
  const displayReveal = historicalReveal ?? currentReveal;

  return {
    animationHand: currentReveal?.hand ?? currentMask ?? liveHand,
    animationForceReveal: currentReveal !== null,
    animationSeparatesLastTile:
      currentReveal?.separatesLastTile ??
      (currentMask !== null ? false : view.freshlyDrawnSeat === seat),
    displayHand: displayReveal?.hand ?? currentMask ?? liveHand,
    displayMelds: historicalReveal
      ? (historicalReveal.melds ?? [])
      : (currentReveal?.melds ?? liveMelds),
    displayForceReveal: displayReveal !== null,
    displaySeparatesLastTile:
      displayReveal?.separatesLastTile ??
      (currentMask !== null ? false : view.freshlyDrawnSeat === seat),
    maskedForResult: currentMask !== null,
    historicalReveal: historicalReveal !== null,
  };
}
