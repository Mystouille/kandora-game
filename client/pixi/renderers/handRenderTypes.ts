import type { Container } from "pixi.js";
import type { Meld } from "~/game/protocol/messages";
import type { DiscardAnimation } from "../discardAnimator";
import type { HandResult } from "../scene/renderTypes";
import type { Rect, Seat } from "../tableGeometry";
import type { FocusedHandTileMetrics } from "../geometry/handGeometry";
import type { TileShadows } from "./tileShadows";

export type HandShadows = Pick<
  TileShadows,
  | "screenShadowLayer"
  | "placeColumnShadows"
  | "placeBasicShadow"
  | "placeUprightShadow"
>;

export interface HandRenderOptions {
  readonly showHands: boolean;
  readonly historicalResult: HandResult | null;
  readonly isRiichiMode: () => boolean;
}

export interface HandStripPaint {
  readonly handContainer: Container;
  readonly seat: Seat;
  readonly hand: Array<string | null>;
  readonly isFreshlyDrawn: boolean;
  readonly hiddenHandSlot: number | null;
  readonly canReveal: boolean;
  readonly maskedForResult: boolean;
  readonly isDrawing: boolean;
  readonly hideTsumoTile: boolean;
  readonly drawProgress: number;
}

export interface FocusedHandPaint {
  readonly rawHand: Array<string | null>;
  readonly rawIndices: readonly number[] | null;
  readonly isFreshlyDrawnNatural: boolean;
  readonly inRiichiMode: boolean;
  readonly metrics: FocusedHandTileMetrics;
}

/** Read-only hand output consumed by the following meld and pond passes. */
export interface HandSeatRender {
  readonly handContainer: Container;
  readonly handRect: Rect;
  readonly longAxisOffset: number;
  readonly handWidth: number;
  readonly displayMelds: readonly Meld[];
  readonly revealConcealedKongs: boolean;
  readonly animateMelds: boolean;
  readonly hand: ReadonlyArray<string | null>;
  readonly isFreshlyDrawn: boolean;
  readonly isSideHand: boolean;
  readonly sideHandRevealed: boolean;
  readonly seatDiscardAnim: Readonly<DiscardAnimation> | null;
  readonly discardWaitingToStart: boolean;
}

export const HAND_DRAW_SLIDE_PX = 44;
