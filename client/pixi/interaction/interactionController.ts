import type {
  Application,
  Container,
  FederatedPointerEvent,
  Sprite,
} from "pixi.js";
import type { MatchView } from "../../store";
import { decisionIsReady } from "../../time/liveTimingBinding";
import { intentForWindow } from "../../time/actionWindowViewModel";
import { discardSourceForRawIndex, findTileAction } from "../../discardActions";
import type { ActionClick, TileClick } from "../scene/renderTypes";
import { DiscardAnimator } from "../discardAnimator";
import { HandSorter, naturalOrderRawIndices } from "../handSorter";
import type { FocusedHandTileMetrics } from "../geometry/handGeometry";
import {
  canApplyFocusedHandHover,
  darkenTileTint,
  focusedHandOrderPolicy,
  genericPassOrTsumogiriAction,
  pointerToHandCoordinates,
  riichiSelectionTileTint,
  topmostHandHoverTargetIndex,
} from "../geometry/interactionPolicy";
import {
  DRAG_DISCARD_READY_DARKEN_FACTOR,
  HAND_HOVER_TINT,
  TSUMO_GAP,
} from "../geometry/renderConstants";
import { tileSortKey } from "../geometry/tileOrder";

interface FocusedHandHoverTarget {
  readonly sprite: Sprite;
  readonly originalTint: number;
}

export interface InteractionViewport {
  readonly canvas: Pick<
    Application["canvas"],
    "getBoundingClientRect" | "addEventListener" | "removeEventListener"
  >;
  readonly screen: { readonly width: number; readonly height: number };
}

export interface InteractionRoot {
  readonly position: { readonly x: number; readonly y: number };
  readonly scale: { readonly x: number; readonly y: number };
}

export interface FocusedHandTileBinding {
  readonly view: MatchView;
  readonly seat: number;
  readonly tile: string;
  readonly displayIndex: number;
  readonly rawIndex: number;
  readonly rawHand: Array<string | null>;
  readonly displayHand: ReadonlyArray<string | null>;
  readonly isFreshlyDrawn: boolean;
  readonly slotX: number;
  readonly spriteW: number;
  readonly spriteH: number;
  readonly inRiichiMode: boolean;
}

/** Owns focused-hand gestures and ordering; callbacks always use the latest binding. */
export class InteractionController {
  private app: InteractionViewport | null = null;
  private root: InteractionRoot | null = null;
  private readonly handSorter = new HandSorter();
  private autoSortPreference = true;
  private onAutoSortChange: ((on: boolean) => void) | null = null;
  private onTileClick: ((click: TileClick) => void) | null = null;
  private onActionClick: ((click: ActionClick) => void) | null = null;
  private lastView: MatchView | null = null;
  private previousView: MatchView | null = null;
  private handDragCleanup: (() => void) | null = null;
  private handOriginX = 0;
  private handOriginY = 0;
  private pointerClient: { x: number; y: number } | null = null;
  private hoverTargets: FocusedHandHoverTarget[] = [];
  private activeHover: FocusedHandHoverTarget | null = null;
  private pendingHandClick:
    | ((
        rawIdx: number,
        draggedSourceCenter: { x: number; y: number } | null
      ) => void)
    | null = null;

  constructor(
    private readonly animator: DiscardAnimator,
    private readonly requestRender: () => void
  ) {
    this.handSorter.setOnSortFlagChange((on) => {
      this.autoSortPreference = on;
      this.onAutoSortChange?.(on);
    });
  }

  mount(app: InteractionViewport, root: InteractionRoot): void {
    this.handDragCleanup?.();
    this.app = app;
    this.root = root;
    const onPointerMove = (event: PointerEvent): void => {
      this.pointerClient =
        event.pointerType === "touch"
          ? null
          : { x: event.clientX, y: event.clientY };
      this.updateHover();
      if (!this.handSorter.hasPointerDown()) {
        return;
      }
      this.updateDragPointer(event.clientX, event.clientY);
      this.requestRender();
    };
    const onPointerUp = (event: PointerEvent): void => {
      if (event.button === 2 || !this.handSorter.hasPointerDown()) {
        return;
      }
      this.updateDragPointer(event.clientX, event.clientY);
      const result = this.handSorter.pointerUp();
      if (result.kind === "click" || result.kind === "discard") {
        this.pendingHandClick?.(
          result.rawIdx,
          result.kind === "discard" ? result.draggedTileCenter : null
        );
      }
      this.pendingHandClick = null;
      this.requestRender();
    };
    const onPointerCancel = (): void => {
      if (!this.handSorter.hasPointerDown()) {
        return;
      }
      this.handSorter.cancelGesture();
      this.pendingHandClick = null;
      this.requestRender();
    };
    const onPointerLeave = (): void => this.clearHover(true);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerCancel);
    app.canvas.addEventListener("pointerleave", onPointerLeave);
    this.handDragCleanup = (): void => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerCancel);
      app.canvas.removeEventListener("pointerleave", onPointerLeave);
    };
  }

  /** Must run before the previous frame's sprites are destroyed. */
  beginFrame(view: MatchView): void {
    this.lastView = view;
    if (HandSorter.isHandBoundary(this.previousView, view)) {
      this.handSorter.reset(this.autoSortPreference);
    }
    const rawHand = view.hands[0] ?? [];
    this.handSorter.reconcile(rawHand);
    this.handSorter.pruneTracks(rawHand);
    this.previousView = view;
    this.clearHover();
    this.hoverTargets = [];
  }

  finishFrame(): void {
    this.updateHover();
  }

  hasActiveAnimation(): boolean {
    return this.handSorter.hasActiveAnimation();
  }

  setOnTileClick(handler: ((click: TileClick) => void) | null): void {
    this.onTileClick = handler;
  }

  setOnActionClick(handler: ((click: ActionClick) => void) | null): void {
    this.onActionClick = handler;
  }

  setOnAutoSortChange(callback: ((on: boolean) => void) | null): void {
    this.onAutoSortChange = callback;
  }

  setAutoSort(on: boolean): void {
    this.autoSortPreference = on;
    const rawHand = this.lastView?.hands[0] ?? [];
    const isFresh = this.lastView?.freshlyDrawnSeat === 0;
    const natural = naturalOrderRawIndices(rawHand, isFresh, tileSortKey);
    this.handSorter.setSortFlag(on, natural);
    this.requestRender();
  }

  emitTile(click: TileClick): void {
    this.onTileClick?.(click);
  }

  emitAction(click: ActionClick): void {
    if (!decisionIsReady(this.lastView?.actionWindow)) {
      return;
    }
    const window = this.lastView?.actionWindow;
    if (window && !click.intent) {
      click = {
        ...click,
        intent: intentForWindow(window, this.lastView?.lastSeq ?? 0),
      };
    }
    this.onActionClick?.(click);
  }

  handlePassOrTsumogiriShortcut(): void {
    const view = this.lastView;
    if (!view || !this.onActionClick) {
      return;
    }
    const action = genericPassOrTsumogiriAction(view);
    if (action) {
      this.emitAction({ action });
    }
  }

  focusedDisplayOrder(
    rawHand: Array<string | null>,
    isFreshlyDrawn: boolean,
    metrics: FocusedHandTileMetrics
  ): { rawIndices: number[]; freshGap: boolean } {
    const natural = naturalOrderRawIndices(
      rawHand,
      isFreshlyDrawn,
      tileSortKey
    );
    if (
      focusedHandOrderPolicy(
        this.handSorter.isDragging(),
        this.handSorter.isSortFlagOn()
      ).previewReorder
    ) {
      const beforeDisplay = this.handSorter.getDisplayOrder(
        rawHand,
        isFreshlyDrawn,
        natural
      );
      const gap = beforeDisplay.freshGap ? TSUMO_GAP : 0;
      const slotCenters = beforeDisplay.rawIndices.map((_, index) => {
        const last = index === beforeDisplay.rawIndices.length - 1;
        const extra = gap > 0 && last ? gap : 0;
        return (
          index * (metrics.tile.w + metrics.tile.gap) +
          extra +
          metrics.spriteW / 2
        );
      });
      this.handSorter.maybeSwap(slotCenters);
    }
    return this.handSorter.getDisplayOrder(rawHand, isFreshlyDrawn, natural);
  }

  usesFocusedDisplayOrder(): boolean {
    return focusedHandOrderPolicy(
      this.handSorter.isDragging(),
      this.handSorter.isSortFlagOn()
    ).useDisplayOrder;
  }

  focusedTilePosition(
    rawIndex: number,
    slotX: number
  ): { x: number; y: number } {
    return {
      x: this.handSorter.getRenderX(rawIndex, slotX),
      y: this.handSorter.getRenderY(rawIndex, 0),
    };
  }

  isDraggedRawIndex(rawIndex: number): boolean {
    return this.handSorter.getDraggedRawIdx() === rawIndex;
  }

  setFocusedHandOrigin(x: number, y: number): void {
    this.handOriginX = x;
    this.handOriginY = y;
  }

  bindFocusedHandTile(
    sprite: Sprite,
    handContainer: Container,
    binding: FocusedHandTileBinding
  ): void {
    const {
      view,
      seat,
      tile,
      displayIndex,
      rawIndex,
      rawHand,
      displayHand,
      isFreshlyDrawn,
      slotX,
      spriteW,
      spriteH,
      inRiichiMode,
    } = binding;
    const discardSource = discardSourceForRawIndex(
      rawIndex,
      rawHand.length,
      isFreshlyDrawn
    );
    const riichiLegal = findTileAction(
      view.legalActions,
      "riichi",
      tile,
      discardSource
    );
    const tint = riichiSelectionTileTint(
      inRiichiMode,
      riichiLegal !== undefined
    );
    if (tint !== null) {
      sprite.tint = tint;
    }
    if (this.handSorter.isDraggedPastDiscardThreshold(rawIndex)) {
      sprite.tint = darkenTileTint(
        Number(sprite.tint),
        DRAG_DISCARD_READY_DARKEN_FACTOR
      );
    }
    if (!decisionIsReady(view.actionWindow)) {
      sprite.eventMode = "none";
      return;
    }
    const intent = view.actionWindow
      ? intentForWindow(view.actionWindow, view.lastSeq)
      : undefined;
    sprite.eventMode = "static";
    sprite.cursor = "pointer";
    this.hoverTargets.push({ sprite, originalTint: Number(sprite.tint) });
    let ordinal = 0;
    for (let index = 0; index < displayIndex; index++) {
      if (displayHand[index] === tile) {
        ordinal++;
      }
    }
    sprite.on("pointerdown", (event: FederatedPointerEvent) => {
      if (event.button === 2) {
        return;
      }
      // Preserve the painted tile/source/action, not whatever occupies its slot later.
      this.pendingHandClick = (discardRawIdx, draggedSourceCenter): void => {
        if (inRiichiMode) {
          if (riichiLegal && this.onActionClick) {
            this.emitAction({
              action: riichiLegal,
              ...(intent ? { intent } : {}),
            });
          }
          return;
        }
        if (this.onTileClick) {
          const natural = naturalOrderRawIndices(
            rawHand,
            isFreshlyDrawn,
            tileSortKey
          );
          const currentOrder = this.handSorter.getDisplayOrder(
            rawHand,
            isFreshlyDrawn,
            natural
          ).rawIndices;
          const currentSlot = currentOrder.indexOf(discardRawIdx);
          let currentOrdinal = ordinal;
          if (currentSlot >= 0) {
            currentOrdinal = 0;
            for (let slot = 0; slot < currentSlot; slot++) {
              if (rawHand[currentOrder[slot]] === tile) {
                currentOrdinal++;
              }
            }
          }
          this.animator.setNextDiscardSourceHint(
            seat,
            tile,
            currentOrdinal,
            draggedSourceCenter
          );
          this.emitTile({
            seat,
            index: currentSlot >= 0 ? currentSlot : displayIndex,
            tile,
            discardSource,
            ...(intent ? { intent } : {}),
          });
        }
      };
      const local = handContainer.toLocal({
        x: event.global.x,
        y: event.global.y,
      });
      this.handSorter.pointerDown({
        rawIdx: rawIndex,
        pointerLocalX: local.x,
        pointerLocalY: local.y,
        tileLeftX: slotX,
        tileTopY: 0,
        tileLongAxisLen: spriteW,
        tileHeight: spriteH,
      });
    });
  }

  reset(): void {
    this.clearHover(true);
    this.hoverTargets = [];
    this.handSorter.reset(this.autoSortPreference);
    this.pendingHandClick = null;
    this.lastView = null;
    this.previousView = null;
    this.handOriginX = 0;
    this.handOriginY = 0;
  }

  destroy(): void {
    this.reset();
    this.handDragCleanup?.();
    this.handDragCleanup = null;
    this.app = null;
    this.root = null;
  }

  private pointerToHandLocal(
    clientX: number,
    clientY: number
  ): { x: number; y: number } {
    const app = this.app;
    const root = this.root;
    if (!app || !root) {
      return { x: 0, y: 0 };
    }
    return pointerToHandCoordinates({
      point: { x: clientX, y: clientY },
      viewport: app.canvas.getBoundingClientRect(),
      screen: app.screen,
      root,
      origin: { x: this.handOriginX, y: this.handOriginY },
    });
  }

  private updateDragPointer(clientX: number, clientY: number): void {
    const view = this.lastView;
    if (!view || !this.handSorter.hasPointerDown()) {
      return;
    }
    const local = this.pointerToHandLocal(clientX, clientY);
    const rawHand = view.hands[0] ?? [];
    const isFresh = view.freshlyDrawnSeat === 0;
    const natural = naturalOrderRawIndices(rawHand, isFresh, tileSortKey);
    this.handSorter.pointerMove(local.x, local.y, natural);
  }

  private clearHover(clearPointer = false): void {
    if (this.activeHover) {
      this.activeHover.sprite.tint = this.activeHover.originalTint;
      this.activeHover = null;
    }
    if (clearPointer) {
      this.pointerClient = null;
    }
  }

  private updateHover(): void {
    const app = this.app;
    const pointer = this.pointerClient;
    let next: FocusedHandHoverTarget | null = null;
    if (
      app &&
      pointer &&
      canApplyFocusedHandHover(this.handSorter.isDragging())
    ) {
      const rect = app.canvas.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        const point = {
          x: ((pointer.x - rect.left) / rect.width) * app.screen.width,
          y: ((pointer.y - rect.top) / rect.height) * app.screen.height,
        };
        const index = topmostHandHoverTargetIndex(
          point,
          this.hoverTargets.map((target) => target.sprite.getBounds())
        );
        next = index === null ? null : this.hoverTargets[index];
      }
    }
    if (next === this.activeHover) {
      return;
    }
    this.clearHover();
    this.activeHover = next;
    if (next) {
      next.sprite.tint = HAND_HOVER_TINT;
    }
  }
}
