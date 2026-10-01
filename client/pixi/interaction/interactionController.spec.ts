import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Container,
  EventBoundary,
  FederatedPointerEvent,
  Sprite,
  Texture,
} from "pixi.js";
import { useMatchStore, type MatchView } from "../../store";
import { DiscardAnimator } from "../discardAnimator";
import {
  InteractionController,
  type FocusedHandTileBinding,
  type InteractionViewport,
} from "./interactionController";
import { HAND_HOVER_TINT } from "../geometry/renderConstants";

function view(overrides: Partial<MatchView> = {}): MatchView {
  return {
    ...useMatchStore.getState(),
    mySeat: 0,
    conn: "open",
    hands: [["5m", "1m", "5m"], [], [], []],
    totalDiscards: 2,
    freshlyDrawnSeat: 0,
    ...overrides,
  };
}

function pointerDown(sprite: Sprite, x: number, y: number, button = 0): void {
  const event = new FederatedPointerEvent(new EventBoundary(sprite));
  event.button = button;
  event.global.set(x, y);
  sprite.emit("pointerdown", event);
}

function harness() {
  const pointerTarget = new EventTarget();
  const canvasTarget = new EventTarget();
  vi.stubGlobal("window", pointerTarget);
  const viewport: InteractionViewport = {
    screen: { width: 1000, height: 800 },
    canvas: {
      addEventListener: canvasTarget.addEventListener.bind(canvasTarget),
      removeEventListener: (
        type: string,
        listener: EventListenerOrEventListenerObject,
        options?: boolean | EventListenerOptions
      ) => canvasTarget.removeEventListener(type, listener, options),
      getBoundingClientRect: () => ({
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: 1000,
        bottom: 800,
        width: 1000,
        height: 800,
        toJSON: () => ({}),
      }),
    },
  };
  const animator = new DiscardAnimator();
  const requestRender = vi.fn();
  const owner = new InteractionController(animator, requestRender);
  const root = new Container();
  owner.mount(viewport, root);
  const hand = new Container();
  hand.position.set(10, 400);
  root.addChild(hand);
  owner.setFocusedHandOrigin(10, 400);
  const dispatchPointer = (
    type: string,
    clientX: number,
    clientY: number,
    pointerType = "mouse",
    button = 0
  ): void => {
    pointerTarget.dispatchEvent(
      Object.assign(new Event(type), {
        clientX,
        clientY,
        pointerType,
        button,
      })
    );
  };
  const bind = (
    current: MatchView,
    overrides: Partial<FocusedHandTileBinding> = {},
    tint = 0xffffff
  ): Sprite => {
    const sprite = new Sprite(Texture.EMPTY);
    sprite.width = 50;
    sprite.height = 100;
    sprite.position.set(108, 0);
    sprite.tint = tint;
    hand.addChild(sprite);
    owner.bindFocusedHandTile(sprite, hand, {
      view: current,
      seat: 0,
      tile: "5m",
      displayIndex: 2,
      rawIndex: 2,
      rawHand: current.hands[0],
      displayHand: ["1m", "5m", "5m"],
      isFreshlyDrawn: true,
      slotX: 108,
      spriteW: 50,
      spriteH: 100,
      inRiichiMode: false,
      ...overrides,
    });
    return sprite;
  };
  return {
    owner,
    animator,
    requestRender,
    root,
    hand,
    pointerTarget,
    canvasTarget,
    dispatchPointer,
    bind,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("extracted focused-hand interaction owner", () => {
  it("retains the menu preference at hand boundaries and remaps removed tiles", () => {
    const owner = new InteractionController(new DiscardAnimator(), vi.fn());
    const first = view();
    const metrics = {
      tile: { w: 50, h: 100, gap: 0 },
      spriteW: 50,
      spriteH: 100,
    };
    owner.setAutoSort(false);
    owner.beginFrame(first);
    expect(owner.focusedDisplayOrder(first.hands[0], true, metrics)).toEqual({
      rawIndices: [0, 1, 2],
      freshGap: true,
    });
    const next = view({
      hands: [["1m", "5m"], [], [], []],
      totalDiscards: 3,
      freshlyDrawnSeat: null,
    });
    owner.beginFrame(next);
    expect(
      owner.focusedDisplayOrder(next.hands[0], false, metrics).rawIndices
    ).toEqual([1, 0]);
    const newHand = view({
      hands: [["9s", "1m"], [], [], []],
      totalDiscards: 0,
      freshlyDrawnSeat: null,
    });
    owner.beginFrame(newHand);
    expect(
      owner.focusedDisplayOrder(newHand.hands[0], false, metrics).rawIndices
    ).toEqual([0, 1]);
    owner.setAutoSort(true);
    expect(
      owner.focusedDisplayOrder(newHand.hands[0], false, metrics).rawIndices
    ).toEqual([1, 0]);
  });

  it("uses the newest callback while retaining the painted physical tile/source", () => {
    const h = harness();
    const first = view();
    h.owner.beginFrame(first);
    const initial = vi.fn();
    const latest = vi.fn();
    const hint = vi.spyOn(h.animator, "setNextDiscardSourceHint");
    h.owner.setOnTileClick(initial);
    const sprite = h.bind(first);
    pointerDown(sprite, 135, 450);
    h.owner.setOnTileClick(latest);
    h.owner.beginFrame(view({ legalActions: [] }));
    h.dispatchPointer("pointerup", 135, 450);
    expect(initial).not.toHaveBeenCalled();
    expect(latest).toHaveBeenCalledWith({
      seat: 0,
      index: 2,
      tile: "5m",
      discardSource: "draw",
    });
    expect(hint).toHaveBeenCalledWith(0, "5m", 1, null);
    h.owner.destroy();
  });

  it("retains displayed riichi legality but never owns the selection mode", () => {
    const h = harness();
    const action = {
      id: "riichi:5m:draw",
      type: "riichi",
      tile: "5m",
      discardSource: "draw",
    } as const;
    const first = view({ legalActions: [action] });
    const tile = vi.fn();
    const actionClick = vi.fn();
    h.owner.setOnTileClick(tile);
    h.owner.setOnActionClick(actionClick);
    h.owner.beginFrame(first);
    const sprite = h.bind(first, { inRiichiMode: true });
    pointerDown(sprite, 135, 450);
    h.owner.beginFrame(view({ legalActions: [] }));
    h.dispatchPointer("pointerup", 135, 450);
    expect(actionClick).toHaveBeenCalledWith({ action });
    expect(tile).not.toHaveBeenCalled();
    h.owner.destroy();
  });

  it("rejects right-clicks and unavailable riichi tiles without a discard hint", () => {
    const h = harness();
    const current = view();
    h.owner.beginFrame(current);
    const tileClick = vi.fn();
    const actionClick = vi.fn();
    const hint = vi.spyOn(h.animator, "setNextDiscardSourceHint");
    h.owner.setOnTileClick(tileClick);
    h.owner.setOnActionClick(actionClick);
    const sprite = h.bind(current, { inRiichiMode: true });
    expect(Number(sprite.tint)).toBe(0xb0b0b0);
    pointerDown(sprite, 135, 450, 2);
    h.dispatchPointer("pointerup", 135, 450, "mouse", 2);
    pointerDown(sprite, 135, 450);
    h.dispatchPointer("pointerup", 135, 450);
    expect(tileClick).not.toHaveBeenCalled();
    expect(actionClick).not.toHaveBeenCalled();
    expect(hint).not.toHaveBeenCalled();
    h.owner.destroy();
  });

  it("preserves upward drag-discard geometry and clears cancelled gestures", () => {
    const h = harness();
    const current = view({ hands: [["1m", "2m", "3m"], [], [], []] });
    h.owner.beginFrame(current);
    const click = vi.fn();
    const hint = vi.spyOn(h.animator, "setNextDiscardSourceHint");
    h.owner.setOnTileClick(click);
    const sprite = h.bind(current, {
      tile: "2m",
      rawIndex: 1,
      displayIndex: 1,
      displayHand: current.hands[0],
      slotX: 50,
      isFreshlyDrawn: false,
    });
    sprite.position.set(50, 0);
    pointerDown(sprite, 85, 450);
    h.dispatchPointer("pointermove", 85, 249);
    expect(h.owner.hasActiveAnimation()).toBe(true);
    h.dispatchPointer("pointerup", 85, 249);
    expect(hint).toHaveBeenCalledWith(
      0,
      "2m",
      0,
      expect.objectContaining({ x: 75 })
    );
    expect(hint.mock.calls[0][3]?.y).toBeCloseTo(-151);
    expect(click).toHaveBeenCalledWith({
      seat: 0,
      index: 1,
      tile: "2m",
      discardSource: "hand",
    });
    click.mockClear();
    pointerDown(sprite, 85, 450);
    h.dispatchPointer("pointercancel", 85, 450);
    h.dispatchPointer("pointerup", 85, 450);
    expect(click).not.toHaveBeenCalled();
    h.owner.destroy();
  });

  it("commits changed hand drops without dispatching their stashed click", () => {
    const h = harness();
    const current = view({
      hands: [["1m", "2m", "3m"], [], [], []],
      freshlyDrawnSeat: null,
    });
    h.owner.beginFrame(current);
    const click = vi.fn();
    const sorted = vi.fn();
    h.owner.setOnTileClick(click);
    h.owner.setOnAutoSortChange(sorted);
    const sprite = h.bind(current, {
      tile: "2m",
      rawIndex: 1,
      displayIndex: 1,
      displayHand: current.hands[0],
      slotX: 50,
      isFreshlyDrawn: false,
    });
    pointerDown(sprite, 85, 450);
    h.dispatchPointer("pointermove", 150, 450);
    const metrics = {
      tile: { w: 50, h: 100, gap: 0 },
      spriteW: 50,
      spriteH: 100,
    };
    expect(
      h.owner.focusedDisplayOrder(current.hands[0], false, metrics).rawIndices
    ).toEqual([0, 2, 1]);
    h.dispatchPointer("pointerup", 150, 450);
    expect(click).not.toHaveBeenCalled();
    expect(sorted).toHaveBeenCalledWith(false);
    expect(h.owner.usesFocusedDisplayOrder()).toBe(true);
    h.owner.destroy();
  });

  it("restores hover before old sprites are destroyed and after rebuilding the strip", () => {
    const h = harness();
    const current = view();
    h.owner.beginFrame(current);
    const first = h.bind(current, {}, 0xff0000);
    h.dispatchPointer("pointermove", 135, 450);
    expect(Number(first.tint)).toBe(HAND_HOVER_TINT);
    h.owner.beginFrame(current);
    expect(Number(first.tint)).toBe(0xff0000);
    h.hand.removeChild(first);
    first.destroy({ texture: false });
    const next = h.bind(current, {}, 0xff0000);
    h.owner.finishFrame();
    expect(Number(next.tint)).toBe(HAND_HOVER_TINT);
    h.canvasTarget.dispatchEvent(new Event("pointerleave"));
    expect(Number(next.tint)).toBe(0xff0000);
    h.owner.destroy();
  });

  it("detaches all gesture listeners and uses the latest view for shortcuts", () => {
    const h = harness();
    const removed = vi.spyOn(h.pointerTarget, "removeEventListener");
    const canvasRemoved = vi.spyOn(h.canvasTarget, "removeEventListener");
    const callback = vi.fn();
    h.owner.setOnActionClick(callback);
    const pass = { id: "pass", type: "pass" } as const;
    const drawn = {
      id: "discard:5m:draw",
      type: "discard",
      tile: "5m",
      discardSource: "draw",
    } as const;
    h.owner.beginFrame(view({ legalActions: [pass] }));
    h.owner.handlePassOrTsumogiriShortcut();
    h.owner.beginFrame(view({ legalActions: [drawn] }));
    h.owner.handlePassOrTsumogiriShortcut();
    expect(callback.mock.calls).toEqual([
      [{ action: pass }],
      [{ action: drawn }],
    ]);
    h.owner.destroy();
    expect(removed).toHaveBeenCalledTimes(3);
    expect(canvasRemoved).toHaveBeenCalledTimes(1);
    h.owner.handlePassOrTsumogiriShortcut();
    expect(callback).toHaveBeenCalledTimes(2);
  });
});
