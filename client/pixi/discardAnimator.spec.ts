import { describe, expect, it } from "vitest";
import type { MatchView } from "../store";
import {
  DiscardAnimator,
  SEQ_SLIDE_MS,
  SEQ_HOVER_MS,
  PHASE_B_DURATION_MS,
  DRAW_SLIDE_MS,
} from "./discardAnimator";

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

  it("sequenced: holds a discard at hover, settling only when the next draw begins", () => {
    let now = 0;
    const discardSfx: Array<{ seat: number; isRiichi: boolean }> = [];
    const animator = new DiscardAnimator({ now: () => now });
    animator.setSequenced(true);
    animator.setSoundHooks({
      onDiscardLand: (seat, isRiichi) => discardSfx.push({ seat, isRiichi }),
    });

    animator.beginFrame(makeView({ hands: [["1m"], [], [], []] }));
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

    // Phase A elapsed: land SFX fires once; tile hovers.
    now = SEQ_SLIDE_MS;
    animator.beginFrame(discarded);
    expect(discardSfx).toEqual([{ seat: 0, isRiichi: false }]);
    expect(animator.getAnim(0)?.phase).toBe("to-nudge");

    // Past the slide + hover with NO draw yet (an open call window):
    // the tile must NOT nudge home — it could still be called away.
    now = SEQ_SLIDE_MS + SEQ_HOVER_MS + 200;
    animator.beginFrame(discarded);
    expect(animator.getAnim(0)?.phase).toBe("to-nudge");
    expect(discardSfx).toHaveLength(1);

    // The next player draws → once that slide begins the discard
    // settles to its flush slot.
    const drew = makeView({
      hands: [[], [], [], []],
      discards: [["1m"], [], [], []],
      discardTsumogiri: [[false], [], [], []],
      totalDiscards: 1,
      freshlyDrawnSeat: 1,
    });
    animator.beginFrame(drew);
    expect(animator.getAnim(0)?.phase).toBe("to-final");

    // Phase B elapses → dropped.
    now = now + PHASE_B_DURATION_MS + 1;
    animator.beginFrame(drew);
    expect(animator.getAnim(0)).toBeNull();
  });

  it("sequenced: delays the next draw until the discard has hovered, hiding it until then", () => {
    let now = 0;
    const drawSfx: number[] = [];
    const animator = new DiscardAnimator({ now: () => now });
    animator.setSequenced(true);
    animator.setSoundHooks({ onDrawLand: (seat) => drawSfx.push(seat) });

    animator.beginFrame(makeView({ hands: [["1m"], [], [], []] }));
    recordLayouts(animator, [
      { sorted: ["1m"] },
      { sorted: [] },
      { sorted: [] },
      { sorted: [] },
    ]);

    // Seat 0 discards at t=0.
    const discarded = makeView({
      hands: [[], [], [], []],
      discards: [["1m"], [], [], []],
      discardTsumogiri: [[false], [], [], []],
      totalDiscards: 1,
      freshlyDiscardedSeat: 0,
    });
    animator.beginFrame(discarded);

    // Seat 1 draws ~immediately after (the relay's 0-delay draw).
    const drew = makeView({
      hands: [[], [], [], []],
      discards: [["1m"], [], [], []],
      discardTsumogiri: [[false], [], [], []],
      totalDiscards: 1,
      freshlyDrawnSeat: 1,
    });
    animator.beginFrame(drew);

    // Pending: the drawn tile is hidden but the back is NOT yet sliding.
    expect(animator.isDrawTileHidden(1)).toBe(true);
    expect(animator.isDrawing(1)).toBe(false);
    expect(animator.getDrawProgress(1)).toBe(0);

    // Still pending late in the hover while the discard holds.
    now = SEQ_SLIDE_MS + SEQ_HOVER_MS - 100;
    expect(animator.isDrawing(1)).toBe(false);
    expect(animator.isDrawTileHidden(1)).toBe(true);

    // After slide + hover the back begins sliding.
    now = SEQ_SLIDE_MS + SEQ_HOVER_MS + 1;
    expect(animator.isDrawing(1)).toBe(true);
    expect(animator.getDrawProgress(1)).toBeGreaterThan(0);

    // Slide completes → draw-land SFX fires once, entry dropped.
    now = SEQ_SLIDE_MS + SEQ_HOVER_MS + DRAW_SLIDE_MS;
    animator.beginFrame(drew);
    expect(drawSfx).toEqual([1]);
    expect(animator.isDrawing(1)).toBe(false);
    expect(animator.isDrawTileHidden(1)).toBe(false);
  });

  it("sources a tsumogiri from the tsumo slot even when the wire flag is missing", () => {
    const animator = new DiscardAnimator({ now: () => 0 });
    const before = makeView({
      hands: [["1m", "2m", "3m", "9m"], [], [], []],
      freshlyDrawnSeat: 0,
    });
    animator.beginFrame(before);
    recordLayouts(animator, [
      { sorted: ["1m", "2m", "3m", "9m"], isFreshlyDrawn: true },
      { sorted: [] },
      { sorted: [] },
      { sorted: [] },
    ]);

    // Discard the just-drawn 9m. The relay never tags tsumogiri, so
    // the flag is false — but the source must still be the tsumo slot
    // (index 3), not the tedashi fallback one slot left (index 2).
    const discard = makeView({
      hands: [["1m", "2m", "3m"], [], [], []],
      discards: [["9m"], [], [], []],
      discardTsumogiri: [[false], [], [], []],
      totalDiscards: 1,
      freshlyDiscardedSeat: 0,
    });
    animator.beginFrame(discard);
    expect(animator.getAnim(0)?.sourceSlot?.handIndex).toBe(3);
  });
});
