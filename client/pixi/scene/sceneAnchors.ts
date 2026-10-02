import type { Rect } from "../tableLayout";
import type { RenderFrame } from "./renderTypes";
import type { DiscardLayoutOptions } from "../tileAreaLayout";
import {
  focusedDiscardDrawingFrame,
  sameFocusedDiscardFrame,
  type FocusedDiscardDrawingFrame,
} from "../geometry/reviewDrawingGeometry";

export class SceneAnchors {
  private pondListener:
    ((point: { x: number; y: number } | null) => void) | null = null;
  private handListener: ((rect: Rect | null) => void) | null = null;
  private lastPond: { x: number; y: number } | null = null;
  private lastHand: Rect | null = null;
  private drawingListener:
    ((frame: FocusedDiscardDrawingFrame | null) => void) | null = null;
  private lastDrawing: FocusedDiscardDrawingFrame | null = null;

  setFocusedDiscardDrawingListener(
    callback: ((frame: FocusedDiscardDrawingFrame | null) => void) | null
  ): void {
    this.drawingListener = callback;
    callback?.(this.lastDrawing);
  }

  setPondCenterListener(
    callback: ((point: { x: number; y: number } | null) => void) | null
  ): void {
    this.pondListener = callback;
  }

  setBottomHandBoundsListener(
    callback: ((rect: Rect | null) => void) | null
  ): void {
    this.handListener = callback;
  }

  publish(frame: RenderFrame, discardOptions?: DiscardLayoutOptions): void {
    const { view, layout, root } = frame;
    const seat = view.mySeat ?? 0;
    const pond = layout.discards[seat];
    const sx = root.scale.x;
    const sy = root.scale.y;
    const nextDrawing =
      sx > 0 && sy > 0
        ? focusedDiscardDrawingFrame(layout, discardOptions, {
            x: root.position.x,
            y: root.position.y,
            scale: sx,
          })
        : null;
    if (!sameFocusedDiscardFrame(this.lastDrawing, nextDrawing)) {
      this.lastDrawing = nextDrawing;
      this.drawingListener?.(nextDrawing);
    }
    const nextPond = {
      x: (pond.x + pond.w / 2) * sx + root.position.x,
      y: (pond.y + pond.h / 2) * sy + root.position.y,
    };
    if (
      this.lastPond === null ||
      this.lastPond.x !== nextPond.x ||
      this.lastPond.y !== nextPond.y
    ) {
      this.lastPond = nextPond;
      this.pondListener?.(nextPond);
    }
    const hand = layout.hands[seat];
    const nextHand = {
      x: hand.x * sx + root.position.x,
      y: hand.y * sy + root.position.y,
      w: hand.w * sx,
      h: hand.h * sy,
    };
    if (
      this.lastHand === null ||
      this.lastHand.x !== nextHand.x ||
      this.lastHand.y !== nextHand.y ||
      this.lastHand.w !== nextHand.w ||
      this.lastHand.h !== nextHand.h
    ) {
      this.lastHand = nextHand;
      this.handListener?.(nextHand);
    }
  }
}
