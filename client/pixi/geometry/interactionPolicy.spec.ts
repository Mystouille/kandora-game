import { describe, expect, it } from "vitest";
import {
  canApplyFocusedHandHover,
  canInteractWithFocusedHand,
  darkenTileTint,
  focusedHandOrderPolicy,
  genericPassOrTsumogiriAction,
  isDoubleTapGesture,
  isMobileDoubleTapShortcutTarget,
  isPendingDiscardDisplaySlot,
  riichiSelectionTileTint,
  topmostHandHoverTargetIndex,
} from "./interactionPolicy";

describe("extracted focused-hand and shortcut policy", () => {
  it("retains replay restrictions, preview ordering, and strict tint ownership", () => {
    expect(canInteractWithFocusedHand({ conn: "replay" })).toBe(false);
    expect(canInteractWithFocusedHand({ conn: "open" })).toBe(true);
    expect(canApplyFocusedHandHover(true)).toBe(false);
    expect(focusedHandOrderPolicy(true, true)).toEqual({
      previewReorder: true,
      useDisplayOrder: true,
    });
    expect(focusedHandOrderPolicy(false, true).useDisplayOrder).toBe(false);
    expect(focusedHandOrderPolicy(false, false).useDisplayOrder).toBe(true);
    expect(riichiSelectionTileTint(true, false)).toBe(0xb0b0b0);
    expect(riichiSelectionTileTint(true, true)).toBeNull();
    expect(darkenTileTint(0xffffff, 0.78)).toBe(0xc7c7c7);
  });

  it("selects the last painted overlapping target with inclusive hit bounds", () => {
    const bounds = [
      { x: 0, y: 0, width: 50, height: 100 },
      { x: 40, y: 0, width: 50, height: 100 },
    ];
    expect(topmostHandHoverTargetIndex({ x: 45, y: 100 }, bounds)).toBe(1);
    expect(topmostHandHoverTargetIndex({ x: 0, y: 0 }, bounds)).toBe(0);
    expect(topmostHandHoverTargetIndex({ x: 100, y: 0 }, bounds)).toBeNull();
  });

  it("keeps duplicate pending slots distinct and supports legacy markers", () => {
    expect(
      isPendingDiscardDisplaySlot(
        { seat: 0, tile: "5m", displayIndex: 2 },
        0,
        "5m",
        3
      )
    ).toBe(false);
    expect(
      isPendingDiscardDisplaySlot({ seat: 0, tile: "5m" }, 0, "5m", 3)
    ).toBe(true);
    expect(isPendingDiscardDisplaySlot(null, 0, "5m", 3)).toBe(false);
  });

  it("retains double-tap delay/distance limits and protected canvas regions", () => {
    const previous = { x: 10, y: 10, timeMs: 100 };
    expect(isDoubleTapGesture(previous, { x: 50, y: 10, timeMs: 420 })).toBe(
      true
    );
    expect(isDoubleTapGesture(previous, { x: 10, y: 10, timeMs: 99 })).toBe(
      false
    );
    expect(isDoubleTapGesture(previous, { x: 51, y: 10, timeMs: 420 })).toBe(
      false
    );
    const center = { x: 100, y: 100, w: 100, h: 100 };
    const hand = { x: 0, y: 300, w: 300, h: 100 };
    const button = { x: 200, y: 250, w: 50, h: 30 };
    expect(
      isMobileDoubleTapShortcutTarget({ x: 0, y: 0 }, center, hand, [button])
    ).toBe(true);
    expect(
      isMobileDoubleTapShortcutTarget({ x: 200, y: 200 }, center, hand)
    ).toBe(false);
    expect(
      isMobileDoubleTapShortcutTarget({ x: 225, y: 260 }, center, hand, [
        button,
      ])
    ).toBe(false);
  });

  it("prioritizes pass, then the exact drawn source, without inventing legality", () => {
    const drawn = {
      id: "draw",
      type: "discard",
      tile: "5m",
      discardSource: "draw",
    } as const;
    const closed = {
      id: "hand",
      type: "discard",
      tile: "5m",
      discardSource: "hand",
    } as const;
    const pass = { id: "pass", type: "pass" } as const;
    const current = {
      mySeat: 0 as const,
      hands: [["5m", "5m"]],
      legalActions: [closed, drawn],
    };
    expect(genericPassOrTsumogiriAction(current)).toBe(drawn);
    expect(
      genericPassOrTsumogiriAction({ ...current, legalActions: [drawn, pass] })
    ).toBe(pass);
    expect(
      genericPassOrTsumogiriAction({ ...current, mySeat: null })
    ).toBeUndefined();
    expect(
      genericPassOrTsumogiriAction({ ...current, hands: [[null]] })
    ).toBeUndefined();
  });
});
