import { describe, expect, it } from "vitest";
import type { MatchView } from "../store";
import { DiscardAnimator } from "./discardAnimator";

function makeView(args: {
  hands?: Array<Array<string | null>>;
  discards?: string[][];
  discardTsumogiri?: boolean[][];
  totalDiscards?: number;
  freshlyDrawnSeat?: number | null;
  freshlyDiscardedSeat?: number | null;
}): MatchView {
  return {
    hands: args.hands ?? [[], [], [], []],
    discards: args.discards ?? [[], [], [], []],
    discardTsumogiri: args.discardTsumogiri ?? [[], [], [], []],
    totalDiscards: args.totalDiscards ?? 0,
    freshlyDrawnSeat: args.freshlyDrawnSeat ?? null,
    freshlyDiscardedSeat: args.freshlyDiscardedSeat ?? null,
    riichiTileIdx: [null, null, null, null],
  } as unknown as MatchView;
}

function recordLayouts(
  animator: DiscardAnimator,
  layouts: Array<{ sorted: Array<string | null>; isFreshlyDrawn?: boolean }>
): void {
  for (let seat = 0; seat < 4; seat++) {
    const layout = layouts[seat] ?? { sorted: [] };
    animator.recordHandLayout(seat, {
      sorted: layout.sorted,
      isFreshlyDrawn: layout.isFreshlyDrawn ?? false,
      isConcealed: false,
    });
  }
}

describe("DiscardAnimator", () => {
  it("auto-settles a discard from nudge to final after phase A, then drops it", () => {
    let now = 0;
    const animator = new DiscardAnimator({ now: () => now });
    const before = makeView({
      hands: [["1m"], [], [], []],
      discards: [[], [], [], []],
      discardTsumogiri: [[], [], [], []],
    });
    animator.beginFrame(before);
    recordLayouts(animator, [
      { sorted: ["1m"] },
      { sorted: [] },
      { sorted: [] },
      { sorted: [] },
    ]);

    const discarded = makeView({
      hands: [[], [], [], []],
      discards: [["1m"], [], [], []],
      discardTsumogiri: [[false], [], [], []],
      totalDiscards: 1,
      freshlyDiscardedSeat: 0,
    });
    animator.beginFrame(discarded);
    expect(animator.getAnim(0)?.phase).toBe("to-nudge");

    // Before phase A elapses (350ms) the tile is still sliding out.
    now = 300;
    animator.beginFrame(discarded);
    expect(animator.getAnim(0)?.phase).toBe("to-nudge");

    // Self-contained: once phase A elapses it settles to final on its
    // own, regardless of whether another player has acted yet.
    now = 351;
    animator.beginFrame(discarded);
    expect(animator.getAnim(0)?.phase).toBe("to-final");

    // After phase B elapses the entry is dropped (tile parked at final).
    now = 502;
    animator.beginFrame(discarded);
    expect(animator.getAnim(0)).toBeNull();
  });

  it("does not reuse a pre-call hand snapshot for the caller's next discard", () => {
    const animator = new DiscardAnimator({ now: () => 0 });

    const beforeCall = makeView({
      hands: [["2m", "3m", "4m"], [], [], []],
      discards: [[], ["1m"], [], []],
      discardTsumogiri: [[], [false], [], []],
      totalDiscards: 1,
      freshlyDiscardedSeat: 1,
    });
    animator.beginFrame(beforeCall);
    recordLayouts(animator, [
      { sorted: ["2m", "3m", "4m"] },
      { sorted: [] },
      { sorted: [] },
      { sorted: [] },
    ]);

    const afterCall = makeView({
      hands: [["4m"], [], [], []],
      discards: [[], [], [], []],
      discardTsumogiri: [[], [], [], []],
      totalDiscards: 0,
      freshlyDiscardedSeat: null,
    });
    animator.beginFrame(afterCall);
    recordLayouts(animator, [
      { sorted: ["4m"] },
      { sorted: [] },
      { sorted: [] },
      { sorted: [] },
    ]);

    const callerDiscards = makeView({
      hands: [[], [], [], []],
      discards: [["4m"], [], [], []],
      discardTsumogiri: [[false], [], [], []],
      totalDiscards: 1,
      freshlyDiscardedSeat: 0,
    });
    animator.beginFrame(callerDiscards);

    expect(animator.getAnim(0)?.phaseASnapshot?.hand).toEqual(["4m"]);
  });

  it("plays a draw-in slide when a seat freshly draws, then drops it", () => {
    let now = 0;
    const animator = new DiscardAnimator({ now: () => now });
    animator.beginFrame(makeView({}));

    // Seat 1 draws.
    animator.beginFrame(makeView({ freshlyDrawnSeat: 1 }));
    expect(animator.isDrawing(1)).toBe(true);
    expect(animator.getDrawProgress(1)).toBeLessThan(1);
    expect(animator.hasActive()).toBe(true);

    // A re-render on the same draw does not restart the slide.
    now = 100;
    animator.beginFrame(makeView({ freshlyDrawnSeat: 1 }));
    expect(animator.getDrawProgress(1, 100)).toBeGreaterThan(0);

    // Past the 0.5s slide duration it settles and the entry is dropped.
    now = 501;
    expect(animator.isDrawing(1)).toBe(false);
    expect(animator.getDrawProgress(1)).toBe(1);
    animator.beginFrame(makeView({ freshlyDrawnSeat: 1 }));
    expect(animator.hasActive()).toBe(false);
  });
});
