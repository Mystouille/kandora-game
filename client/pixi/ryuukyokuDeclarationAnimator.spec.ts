import { describe, expect, it } from "vitest";
import type { MatchView } from "../store";
import {
  RYUUKYOKU_DECLARATION_EFFECT_DURATION_MS,
  RyuukyokuDeclarationAnimator,
} from "./ryuukyokuDeclarationAnimator";

function view(
  declarations: MatchView["ryuukyokuDeclarations"],
  handEnded = false
): Pick<MatchView, "ryuukyokuDeclarations" | "lastHandResult"> {
  return {
    ryuukyokuDeclarations: declarations,
    lastHandResult: handEnded ? { reason: "exhaustive_draw" } : null,
  };
}

describe("RyuukyokuDeclarationAnimator", () => {
  it.each([
    [true, "Tenpai"],
    [false, "Noten"],
  ] as const)("exposes a %s declaration callout", (tenpai, label) => {
    let now = 100;
    const animator = new RyuukyokuDeclarationAnimator({ now: () => now });
    animator.beginFrame(view([null, null, null, null]));
    animator.beginFrame(view([null, tenpai, null, null]));

    expect(animator.getCallEffect()).toEqual({
      seat: 1,
      label,
      alpha: 0,
      scale: 0.96,
    });

    now += RYUUKYOKU_DECLARATION_EFFECT_DURATION_MS / 2;
    expect(animator.getCallEffect()).toMatchObject({
      seat: 1,
      label,
      alpha: 1,
    });

    now += RYUUKYOKU_DECLARATION_EFFECT_DURATION_MS / 2;
    expect(animator.getCallEffect()).toBeNull();
  });

  it("suppresses initial hydration and multi-seat jumps", () => {
    const animator = new RyuukyokuDeclarationAnimator({ now: () => 0 });
    animator.beginFrame(view([true, null, null, null]));
    expect(animator.hasActive()).toBe(false);

    animator.beginFrame(view([true, false, true, null]));
    expect(animator.hasActive()).toBe(false);
    expect(animator.getCallEffect()).toBeNull();
  });

  it("shows merged archived hand-end state without a callout", () => {
    const animator = new RyuukyokuDeclarationAnimator({ now: () => 0 });
    animator.beginFrame(view([null, null, null, null]));
    animator.beginFrame(view([null, null, true, null], true));

    expect(animator.hasActive()).toBe(false);
    expect(animator.getCallEffect()).toBeNull();
  });

  it("clears an in-flight cue when a merged result arrives", () => {
    const animator = new RyuukyokuDeclarationAnimator({ now: () => 0 });
    animator.beginFrame(view([null, null, null, null]));
    animator.beginFrame(view([true, null, null, null]));
    expect(animator.hasActive()).toBe(true);

    animator.beginFrame(view([true, false, true, false], true));
    expect(animator.hasActive()).toBe(false);
  });

  it("tracks a snapped transition and animates the next declaration", () => {
    const animator = new RyuukyokuDeclarationAnimator({ now: () => 0 });
    animator.beginFrame(view([null, null, null, null]));
    animator.snapNext();
    animator.beginFrame(view([true, null, null, null]));
    expect(animator.hasActive()).toBe(false);

    animator.beginFrame(view([true, false, null, null]));
    expect(animator.getCallEffect()?.label).toBe("Noten");
  });
});
