import { Container, Text, TextStyle } from "pixi.js";
import type { RenderFrame, RenderResources } from "../scene/renderTypes";
import type { Seat } from "../tableGeometry";
import type { DiscardAnimator } from "../discardAnimator";
import type { InteractionController } from "../interaction/interactionController";
import {
  focusedHandLongAxisOffset,
  focusedHandTileMetrics,
} from "../geometry/handGeometry";
import { resolveSeatHandPresentation } from "../geometry/handPresentation";
import {
  DISCARD_ROW_OVERLAP_HORIZ,
  SIDE_TILE_H,
  SIDE_TILE_W,
  TSUMO_GAP,
} from "../geometry/renderConstants";
import { sortHand } from "../geometry/tileOrder";
import { renderFocusedHand } from "./focusedHandRenderer";
import { renderSideHand } from "./sideHandRenderer";
import { renderTopHand } from "./topHandRenderer";
import type {
  HandRenderOptions,
  HandSeatRender,
  HandShadows,
  HandStripPaint,
} from "./handRenderTypes";

export type {
  HandRenderOptions,
  HandSeatRender,
  HandShadows,
} from "./handRenderTypes";

/** Paints only the hand; the facade follows this pass with melds and discards. */
export class HandRenderer {
  constructor(
    private readonly resources: RenderResources,
    private readonly animator: DiscardAnimator,
    private readonly interaction: InteractionController,
    private readonly shadows: HandShadows
  ) {}

  render(
    frame: RenderFrame,
    seat: Seat,
    options: HandRenderOptions
  ): HandSeatRender {
    const { view, layout, root } = frame;
    const metrics = focusedHandTileMetrics(layout, frame.presentation);
    const presentation = resolveSeatHandPresentation(
      view,
      options.historicalResult,
      seat
    );
    const rawHand = presentation.animationHand;
    const forceReveal = presentation.animationForceReveal;
    const isYou = view.mySeat === seat;
    const isFreshlyDrawnNatural = presentation.animationSeparatesLastTile;
    const handNatural = sortHand(rawHand, isFreshlyDrawnNatural);
    const naturalIsConcealed = !isYou && !forceReveal && !options.showHands;
    let rawIndices: readonly number[] | null = null;
    const seat0Display =
      seat === 0 && !forceReveal
        ? this.interaction.focusedDisplayOrder(
            rawHand,
            isFreshlyDrawnNatural,
            metrics
          )
        : null;
    let baseHand = handNatural;
    let baseFreshlyDrawn = isFreshlyDrawnNatural;
    if (
      seat === 0 &&
      !forceReveal &&
      seat0Display &&
      this.interaction.usesFocusedDisplayOrder()
    ) {
      baseHand = seat0Display.rawIndices.map((index) => rawHand[index] ?? null);
      baseFreshlyDrawn = seat0Display.freshGap;
    }
    this.animator.recordHandLayout(seat, {
      sorted: baseHand,
      isFreshlyDrawn: baseFreshlyDrawn,
      isConcealed: naturalIsConcealed,
    });
    const seatDiscardAnim = this.animator.getAnim(seat);
    const discardWaitingToStart =
      seatDiscardAnim !== null && this.animator.isDiscardWaitingToStart(seat);
    let hand = baseHand;
    let isFreshlyDrawn = baseFreshlyDrawn;
    let hiddenHandSlot: number | null = null;
    if (seat === 0 && !forceReveal && seat0Display) {
      rawIndices = seat0Display.rawIndices;
    }
    // Freeze the pre-discard strip through both phases, but not before its schedule.
    if (seatDiscardAnim && seatDiscardAnim.phaseASnapshot) {
      hand = seatDiscardAnim.phaseASnapshot.hand;
      isFreshlyDrawn = seatDiscardAnim.phaseASnapshot.isFreshlyDrawn;
      hiddenHandSlot = discardWaitingToStart
        ? null
        : seatDiscardAnim.phaseASnapshot.hiddenSlot;
      rawIndices = null;
    }
    if (presentation.historicalReveal) {
      hand = sortHand(
        presentation.displayHand,
        presentation.displaySeparatesLastTile
      );
      isFreshlyDrawn = presentation.displaySeparatesLastTile;
      hiddenHandSlot = null;
      rawIndices = null;
    }
    const isSideHand = !isYou && seat % 2 === 1;
    const sideHandRevealed =
      isSideHand &&
      (options.showHands || presentation.displayForceReveal) &&
      hand.some((tile) => tile !== null);
    const sideHandLiesFlat =
      sideHandRevealed || (isSideHand && presentation.maskedForResult);
    const handGap = isFreshlyDrawn ? TSUMO_GAP : 0;
    let handWidth: number;
    if (isSideHand) {
      const stride = sideHandLiesFlat
        ? SIDE_TILE_H - DISCARD_ROW_OVERLAP_HORIZ
        : layout.tileSide.h - layout.tileSideOverlap;
      const endTileLong = sideHandLiesFlat ? SIDE_TILE_H : layout.tileSide.h;
      handWidth = (hand.length - 1) * stride + endTileLong + handGap;
    } else if (seat === 2) {
      handWidth =
        hand.length * this.resources.tileDesign.metrics.topHand.w + handGap;
    } else {
      handWidth =
        hand.length * (metrics.tile.w + metrics.tile.gap) -
        metrics.tile.gap +
        handGap;
    }
    const handContainer = new Container();
    handContainer.label = `hand-seat-${seat}`;
    const isDrawing = isFreshlyDrawn && this.animator.isDrawing(seat);
    const paint: HandStripPaint = {
      handContainer,
      seat,
      hand,
      isFreshlyDrawn,
      hiddenHandSlot,
      canReveal: options.showHands || presentation.displayForceReveal,
      maskedForResult: presentation.maskedForResult,
      isDrawing,
      hideTsumoTile: isFreshlyDrawn && this.animator.isDrawTileHidden(seat),
      drawProgress: isDrawing ? this.animator.getDrawProgress(seat) : 1,
    };
    if (isSideHand && (seat === 1 || seat === 3)) {
      renderSideHand(this.resources, frame, { ...paint, seat }, this.shadows);
    } else if (seat === 2) {
      renderTopHand(this.resources, frame, paint, this.shadows);
    } else {
      renderFocusedHand(
        this.resources,
        frame,
        paint,
        {
          rawHand,
          rawIndices,
          isFreshlyDrawnNatural,
          inRiichiMode: isYou && options.isRiichiMode(),
          metrics,
        },
        this.interaction,
        this.shadows
      );
    }
    const handRect = layout.hands[seat];
    const longAxisOffset = focusedHandLongAxisOffset(
      layout,
      frame.presentation,
      seat,
      presentation.displayMelds.length
    );
    const sideHandScreenWidth = sideHandLiesFlat
      ? SIDE_TILE_W
      : layout.tileSide.w;
    switch (seat) {
      case 0: {
        handContainer.position.set(handRect.x + longAxisOffset, handRect.y);
        this.interaction.setFocusedHandOrigin(
          handRect.x + longAxisOffset,
          handRect.y
        );
        break;
      }
      case 1: {
        handContainer.rotation = -Math.PI / 2;
        handContainer.position.set(
          handRect.x + handRect.w - sideHandScreenWidth,
          handRect.y + handRect.h - longAxisOffset
        );
        break;
      }
      case 2: {
        handContainer.rotation = Math.PI;
        handContainer.position.set(
          handRect.x + handRect.w - longAxisOffset,
          handRect.y + handRect.h
        );
        break;
      }
      case 3: {
        handContainer.rotation = Math.PI / 2;
        handContainer.position.set(
          handRect.x + sideHandScreenWidth,
          handRect.y + longAxisOffset
        );
        break;
      }
    }
    if (seat === 0) {
      handContainer.zIndex = 10;
    }
    if (seat === 0 && view.furiten[seat]) {
      const label = new Text({
        text: "Furiten",
        style: new TextStyle({
          fontFamily: "Inter, system-ui, sans-serif",
          fontSize: 18,
          fontWeight: "700",
          fill: 0xff3030,
          stroke: { color: 0x000000, width: 3 },
        }),
      });
      label.anchor.set(1, 0);
      label.position.set(metrics.spriteW - 2, 2);
      handContainer.addChild(label);
    }
    root.addChild(handContainer);
    return {
      handContainer,
      handRect,
      longAxisOffset,
      handWidth,
      displayMelds: presentation.displayMelds,
      revealConcealedKongs:
        view.rulesFamily === "mcr" && presentation.displayWinningReveal,
      animateMelds: !presentation.historicalReveal,
      hand,
      isFreshlyDrawn,
      isSideHand,
      sideHandRevealed,
      seatDiscardAnim,
      discardWaitingToStart,
    };
  }
}
