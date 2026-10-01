import type { Application } from "pixi.js";
import type { MatchView } from "../../store";
import type { Rect, TableLayout } from "../tableLayout";
import type { TableRendererPresentation } from "../scene/renderTypes";
import {
  genericPassOrTsumogiriAction,
  isDoubleTapGesture,
  isMobileDoubleTapShortcutTarget,
  pointInsideRect,
  type TapSample,
} from "../geometry/interactionPolicy";
import type {
  InteractionRoot,
  InteractionViewport,
} from "./interactionController";

export interface CanvasShortcutFrame {
  readonly root: InteractionRoot;
  readonly view: Pick<MatchView, "legalActions" | "mySeat" | "hands">;
  readonly layout: TableLayout;
  readonly presentation: TableRendererPresentation;
  readonly actionBounds: ReadonlyArray<Readonly<Rect>>;
}

export interface ResultPressPort {
  readonly winInfoPressEnabled: boolean;
  readonly lastResultPanelBounds: Readonly<Rect> | null;
  hideHandResult(): void;
  restoreHandResult(): void;
}

export class CanvasInteractions {
  private cleanup: (() => void) | null = null;

  constructor(
    private readonly shortcutFrame: () => CanvasShortcutFrame | null,
    private readonly passOrTsumogiri: () => void,
    private readonly resultPress: ResultPressPort
  ) {}

  mount(
    app: InteractionViewport & { readonly canvas: Application["canvas"] }
  ): void {
    const onContextMenu = (event: MouseEvent): void => {
      event.preventDefault();
    };
    const onMouseDown = (event: MouseEvent): void => {
      if (event.button !== 2) {
        return;
      }
      event.preventDefault();
      this.passOrTsumogiri();
    };
    let touchStart: {
      pointerId: number;
      clientX: number;
      clientY: number;
      eligible: boolean;
    } | null = null;
    let previousTap: TapSample | null = null;
    const isEligible = (clientX: number, clientY: number): boolean => {
      const frame = this.shortcutFrame();
      if (
        !frame ||
        frame.presentation !== "mobile" ||
        frame.root.scale.x <= 0 ||
        frame.root.scale.y <= 0 ||
        genericPassOrTsumogiriAction(frame.view) === undefined
      ) {
        return false;
      }
      const canvasRect = app.canvas.getBoundingClientRect();
      const screenPoint = {
        x: ((clientX - canvasRect.left) * app.screen.width) / canvasRect.width,
        y: ((clientY - canvasRect.top) * app.screen.height) / canvasRect.height,
      };
      const designPoint = {
        x: (screenPoint.x - frame.root.position.x) / frame.root.scale.x,
        y: (screenPoint.y - frame.root.position.y) / frame.root.scale.y,
      };
      return isMobileDoubleTapShortcutTarget(
        designPoint,
        frame.layout.center,
        frame.layout.hands[0],
        frame.actionBounds
      );
    };
    const onTouchDown = (event: PointerEvent): void => {
      if (event.pointerType !== "touch" || !event.isPrimary) {
        return;
      }
      const eligible = isEligible(event.clientX, event.clientY);
      touchStart = {
        pointerId: event.pointerId,
        clientX: event.clientX,
        clientY: event.clientY,
        eligible,
      };
      if (!eligible) {
        previousTap = null;
      }
    };
    const onTouchUp = (event: PointerEvent): void => {
      if (
        event.pointerType !== "touch" ||
        !event.isPrimary ||
        touchStart?.pointerId !== event.pointerId
      ) {
        return;
      }
      const start = touchStart;
      touchStart = null;
      const dx = event.clientX - start.clientX;
      const dy = event.clientY - start.clientY;
      if (
        !start.eligible ||
        dx * dx + dy * dy > 20 * 20 ||
        !isEligible(event.clientX, event.clientY)
      ) {
        previousTap = null;
        return;
      }
      const currentTap = {
        x: event.clientX,
        y: event.clientY,
        timeMs: event.timeStamp,
      };
      if (!isDoubleTapGesture(previousTap, currentTap)) {
        previousTap = currentTap;
        return;
      }
      previousTap = null;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      this.passOrTsumogiri();
    };
    const cancelTap = (event: PointerEvent): void => {
      if (touchStart?.pointerId === event.pointerId) {
        touchStart = null;
        previousTap = null;
      }
    };
    const onResultDown = (event: PointerEvent): void => {
      const bounds = this.resultPress.lastResultPanelBounds;
      if (
        !this.resultPress.winInfoPressEnabled ||
        !bounds ||
        (event.button !== 0 && event.button !== 2)
      ) {
        return;
      }
      const canvasRect = app.canvas.getBoundingClientRect();
      const point = {
        x:
          ((event.clientX - canvasRect.left) * app.screen.width) /
          canvasRect.width,
        y:
          ((event.clientY - canvasRect.top) * app.screen.height) /
          canvasRect.height,
      };
      if (!pointInsideRect(point, bounds)) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      this.resultPress.hideHandResult();
    };
    const restoreResult = (): void => this.resultPress.restoreHandResult();
    app.canvas.addEventListener("contextmenu", onContextMenu);
    app.canvas.addEventListener("mousedown", onMouseDown);
    app.canvas.addEventListener("pointerdown", onTouchDown, true);
    app.canvas.addEventListener("pointerup", onTouchUp, true);
    app.canvas.addEventListener("pointercancel", cancelTap, true);
    app.canvas.addEventListener("pointerdown", onResultDown, true);
    window.addEventListener("pointerup", restoreResult);
    window.addEventListener("pointercancel", restoreResult);
    this.cleanup = (): void => {
      app.canvas.removeEventListener("contextmenu", onContextMenu);
      app.canvas.removeEventListener("mousedown", onMouseDown);
      app.canvas.removeEventListener("pointerdown", onTouchDown, true);
      app.canvas.removeEventListener("pointerup", onTouchUp, true);
      app.canvas.removeEventListener("pointercancel", cancelTap, true);
      app.canvas.removeEventListener("pointerdown", onResultDown, true);
      window.removeEventListener("pointerup", restoreResult);
      window.removeEventListener("pointercancel", restoreResult);
    };
  }

  destroy(): void {
    this.cleanup?.();
    this.cleanup = null;
  }
}
