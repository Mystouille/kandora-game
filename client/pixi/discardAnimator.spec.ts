import { describe, expect, it } from "vitest";
import type { MatchView } from "../store";
import {
  DiscardAnimator,
  SEQ_SLIDE_MS,
  SEQ_HOVER_MS,
  PHASE_A_DURATION_MS,
  PHASE_B_DURATION_MS,
  DRAW_SLIDE_MS,
  MIN_DRAW_TO_DISCARD_MS,
} from "./discardAnimator";

function makeView(args: {
  hands?: Array<Array<string | null>>;
  discards?: string[][];
  discardTsumogiri?: boolean[][];
  discardSources?: Array<Array<"hand" | "draw" | null>>;
  totalDiscards?: number;
  freshlyDrawnSeat?: number | null;
  freshlyDiscardedSeat?: number | null;
  riichiTileIdx?: [number | null, number | null, number | null, number | null];
  riichiDeclared?: [boolean, boolean, boolean, boolean];
}): MatchView {
  return {
    hands: args.hands ?? [[], [], [], []],
    discards: args.discards ?? [[], [], [], []],
    discardTsumogiri: args.discardTsumogiri ?? [[], [], [], []],
    discardSources: args.discardSources ?? [[], [], [], []],
    totalDiscards: args.totalDiscards ?? 0,
    freshlyDrawnSeat: args.freshlyDrawnSeat ?? null,
    freshlyDiscardedSeat: args.freshlyDiscardedSeat ?? null,
    riichiTileIdx: args.riichiTileIdx ?? [null, null, null, null],
    riichiDeclared: args.riichiDeclared ?? [false, false, false, false],
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
  it.each([false, true])(
    "enforces the draw-to-discard minimum when sequenced is %s",
    (sequenced) => {
      let now = 0;
      const animator = new DiscardAnimator({ now: () => now });
      animator.setMinimumDrawToDiscardDelayEnabled(true);
      animator.setSequenced(sequenced);
      animator.beginFrame(makeView({ hands: [["1m"], [], [], []] }));
      recordLayouts(animator, [
        { sorted: ["1m"] },
        { sorted: [] },
        { sorted: [] },
        { sorted: [] },
      ]);

      animator.beginFrame(
        makeView({
          hands: [["1m", "9m"], [], [], []],
          freshlyDrawnSeat: 0,
        })
      );
      recordLayouts(animator, [
        { sorted: ["1m", "9m"], isFreshlyDrawn: true },
        { sorted: [] },
        { sorted: [] },
        { sorted: [] },
      ]);

      animator.beginFrame(
        makeView({
          hands: [["1m"], [], [], []],
          discards: [["9m"], [], [], []],
          discardTsumogiri: [[true], [], [], []],
          discardSources: [["draw"], [], [], []],
          totalDiscards: 1,
          freshlyDiscardedSeat: 0,
        })
      );

      expect(animator.getAnim(0)?.startMs).toBe(MIN_DRAW_TO_DISCARD_MS);
      expect(animator.isDiscardWaitingToStart(0)).toBe(true);
      now = MIN_DRAW_TO_DISCARD_MS - 1;
      expect(animator.getProgress(0)).toBe(0);
      now = MIN_DRAW_TO_DISCARD_MS + 1;
      expect(animator.isDiscardWaitingToStart(0)).toBe(false);
      expect(animator.getProgress(0)).toBeGreaterThan(0);
    }
  );

  it("starts immediately when replay/manual-history delay is disabled", () => {
    let now = 0;
    const animator = new DiscardAnimator({ now: () => now });
    animator.beginFrame(makeView({ hands: [["1m"], [], [], []] }));
    recordLayouts(animator, [
      { sorted: ["1m"] },
      { sorted: [] },
      { sorted: [] },
      { sorted: [] },
    ]);
    animator.beginFrame(
      makeView({
        hands: [["1m", "9m"], [], [], []],
        freshlyDrawnSeat: 0,
      })
    );
    recordLayouts(animator, [
      { sorted: ["1m", "9m"], isFreshlyDrawn: true },
      { sorted: [] },
      { sorted: [] },
      { sorted: [] },
    ]);

    now = 100;
    animator.beginFrame(
      makeView({
        hands: [["1m"], [], [], []],
        discards: [["9m"], [], [], []],
        discardSources: [["draw"], [], [], []],
        totalDiscards: 1,
        freshlyDiscardedSeat: 0,
      })
    );

    expect(animator.getAnim(0)?.startMs).toBe(now);
    expect(animator.isDrawing(0)).toBe(false);
  });

  it("starts immediately after live pacing is disabled for manual history", () => {
    let now = 0;
    const animator = new DiscardAnimator({ now: () => now });
    animator.setMinimumDrawToDiscardDelayEnabled(true);
    animator.beginFrame(makeView({ hands: [["1m"], [], [], []] }));
    recordLayouts(animator, [
      { sorted: ["1m"] },
      { sorted: [] },
      { sorted: [] },
      { sorted: [] },
    ]);
    animator.beginFrame(
      makeView({
        hands: [["1m", "9m"], [], [], []],
        freshlyDrawnSeat: 0,
      })
    );
    recordLayouts(animator, [
      { sorted: ["1m", "9m"], isFreshlyDrawn: true },
      { sorted: [] },
      { sorted: [] },
      { sorted: [] },
    ]);

    animator.setMinimumDrawToDiscardDelayEnabled(false);
    now = 100;
    animator.beginFrame(
      makeView({
        hands: [["1m"], [], [], []],
        discards: [["9m"], [], [], []],
        discardSources: [["draw"], [], [], []],
        totalDiscards: 1,
        freshlyDiscardedSeat: 0,
      })
    );

    expect(animator.getAnim(0)?.startMs).toBe(now);
  });

  it("clears queued live animations when sequencing is disabled", () => {
    const animator = new DiscardAnimator({ now: () => 0 });
    animator.setSequenced(true);
    animator.beginFrame(makeView({ hands: [["1m"], [], [], []] }));
    recordLayouts(animator, [
      { sorted: ["1m"] },
      { sorted: [] },
      { sorted: [] },
      { sorted: [] },
    ]);
    animator.beginFrame(
      makeView({
        hands: [[], [], [], []],
        discards: [["1m"], [], [], []],
        totalDiscards: 1,
        freshlyDiscardedSeat: 0,
      })
    );
    expect(animator.getAnim(0)).not.toBeNull();

    animator.setSequenced(false);

    expect(animator.getAnim(0)).toBeNull();
    expect(animator.hasActive()).toBe(false);
  });

  it("does not add another wait after the live minimum has elapsed", () => {
    let now = 0;
    const animator = new DiscardAnimator({ now: () => now });
    animator.setMinimumDrawToDiscardDelayEnabled(true);
    animator.beginFrame(makeView({ hands: [["1m"], [], [], []] }));
    recordLayouts(animator, [
      { sorted: ["1m"] },
      { sorted: [] },
      { sorted: [] },
      { sorted: [] },
    ]);
    animator.beginFrame(
      makeView({
        hands: [["1m", "9m"], [], [], []],
        freshlyDrawnSeat: 0,
      })
    );
    recordLayouts(animator, [
      { sorted: ["1m", "9m"], isFreshlyDrawn: true },
      { sorted: [] },
      { sorted: [] },
      { sorted: [] },
    ]);

    now = MIN_DRAW_TO_DISCARD_MS + 100;
    animator.beginFrame(
      makeView({
        hands: [["1m"], [], [], []],
        discards: [["9m"], [], [], []],
        discardSources: [["draw"], [], [], []],
        totalDiscards: 1,
        freshlyDiscardedSeat: 0,
      })
    );

    expect(animator.getAnim(0)?.startMs).toBe(now);
  });

  it("snaps a discontinuous sequenced jump without retaining hand state or backlog", () => {
    const animator = new DiscardAnimator({ now: () => 0 });
    animator.setSequenced(true);
    animator.beginFrame(makeView({ hands: [["1m"], [], [], []] }));
    recordLayouts(animator, [
      { sorted: ["1m"] },
      { sorted: [] },
      { sorted: [] },
      { sorted: [] },
    ]);

    animator.beginFrame(
      makeView({
        hands: [["1m", "9m"], [], [], []],
        freshlyDrawnSeat: 0,
      })
    );
    recordLayouts(animator, [
      { sorted: ["1m", "9m"], isFreshlyDrawn: true },
      { sorted: [] },
      { sorted: [] },
      { sorted: [] },
    ]);
    animator.beginFrame(
      makeView({
        hands: [["1m"], [], [], []],
        discards: [["9m"], [], [], []],
        discardSources: [["draw"], [], [], []],
        totalDiscards: 1,
        freshlyDiscardedSeat: 0,
      })
    );
    expect(animator.getAnim(0)?.phaseASnapshot).not.toBeNull();

    animator.snapNext();
    expect(animator.getAnim(0)).toBeNull();

    const jumped = makeView({
      hands: [["1m"], ["2p"], ["3s"], []],
      discards: [["9m"], ["1p"], [], []],
      totalDiscards: 2,
      freshlyDiscardedSeat: 1,
    });
    animator.beginFrame(jumped);
    expect(animator.hasActive()).toBe(false);
    recordLayouts(animator, [
      { sorted: ["1m"] },
      { sorted: ["2p"] },
      { sorted: ["3s"] },
      { sorted: [] },
    ]);

    animator.beginFrame(
      makeView({
        hands: [["1m"], ["2p"], [], []],
        discards: [["9m"], ["1p"], ["3s"], []],
        totalDiscards: 3,
        freshlyDiscardedSeat: 2,
      })
    );
    expect(animator.getAnim(2)?.startMs).toBe(0);
  });

  it("uses the normal discard timing for a riichi declaration", () => {
    const animator = new DiscardAnimator({ now: () => 0 });
    animator.beginFrame(makeView({ hands: [["1m"], [], [], []] }));
    recordLayouts(animator, [
      { sorted: ["1m"] },
      { sorted: [] },
      { sorted: [] },
      { sorted: [] },
    ]);

    animator.beginFrame(
      makeView({
        hands: [[], [], [], []],
        discards: [["1m"], [], [], []],
        discardTsumogiri: [[false], [], [], []],
        totalDiscards: 1,
        freshlyDiscardedSeat: 0,
        riichiTileIdx: [0, null, null, null],
      })
    );

    expect(animator.getAnim(0)).toMatchObject({
      isRiichi: true,
      phase: "to-nudge",
      durationMs: PHASE_A_DURATION_MS,
    });
  });

  it("holds a discard at hover until the next draw starts", () => {
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

    // Once phase A elapses, the tile remains hovering while the call
    // window is open rather than settling on a timer.
    now = PHASE_A_DURATION_MS + 1;
    animator.beginFrame(discarded);
    expect(animator.getAnim(0)?.phase).toBe("to-nudge");

    now = 2_000;
    animator.beginFrame(discarded);
    expect(animator.getAnim(0)?.phase).toBe("to-nudge");

    const drew = makeView({
      hands: [[], [], [], []],
      discards: [["1m"], [], [], []],
      discardTsumogiri: [[false], [], [], []],
      totalDiscards: 1,
      freshlyDrawnSeat: 1,
    });
    animator.beginFrame(drew);
    expect(animator.getAnim(0)?.phase).toBe("to-final");

    // After phase B elapses the entry is dropped (tile parked at final).
    now += PHASE_B_DURATION_MS + 1;
    animator.beginFrame(drew);
    expect(animator.getAnim(0)).toBeNull();
  });

  it("removes a called discard directly from its hovering position", () => {
    let now = 0;
    const animator = new DiscardAnimator({ now: () => now });
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
    now = PHASE_A_DURATION_MS + 1;
    animator.beginFrame(discarded);
    expect(animator.getAnim(0)?.phase).toBe("to-nudge");

    const called = makeView({
      hands: [[], [], [], []],
      discards: [[], [], [], []],
      discardTsumogiri: [[], [], [], []],
      totalDiscards: 0,
    });
    animator.beginFrame(called);
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
    const discardSfx: Array<{
      seat: number;
      isRiichiDeclaration: boolean;
    }> = [];
    const animator = new DiscardAnimator({ now: () => now });
    animator.setSequenced(true);
    animator.setSoundHooks({
      onDiscardLand: (seat, isRiichiDeclaration) =>
        discardSfx.push({ seat, isRiichiDeclaration }),
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
    expect(discardSfx).toEqual([{ seat: 0, isRiichiDeclaration: false }]);
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

  it("keeps a replacement discard tilted without replaying the riichi sound", () => {
    let now = 0;
    const declarations: boolean[] = [];
    const animator = new DiscardAnimator({ now: () => now });
    animator.setSequenced(true);
    animator.setSoundHooks({
      onDiscardLand: (_seat, isDeclaration) => declarations.push(isDeclaration),
    });

    const before = makeView({
      hands: [["2m"], [], [], []],
      riichiDeclared: [true, false, false, false],
      riichiTileIdx: [0, null, null, null],
    });
    animator.beginFrame(before);
    recordLayouts(animator, [
      { sorted: ["2m"] },
      { sorted: [] },
      { sorted: [] },
      { sorted: [] },
    ]);

    const replacementDiscard = makeView({
      hands: [[], [], [], []],
      discards: [["2m"], [], [], []],
      discardTsumogiri: [[false], [], [], []],
      totalDiscards: 1,
      freshlyDiscardedSeat: 0,
      riichiDeclared: [true, false, false, false],
      riichiTileIdx: [0, null, null, null],
    });
    animator.beginFrame(replacementDiscard);

    expect(animator.getAnim(0)).toMatchObject({
      isRiichi: true,
      isRiichiDeclaration: false,
    });
    now = SEQ_SLIDE_MS;
    animator.beginFrame(replacementDiscard);
    expect(declarations).toEqual([false]);
  });

  it("emits the riichi sound for the original declaration transition", () => {
    let now = 0;
    const declarations: boolean[] = [];
    const animator = new DiscardAnimator({ now: () => now });
    animator.setSequenced(true);
    animator.setSoundHooks({
      onDiscardLand: (_seat, isDeclaration) => declarations.push(isDeclaration),
    });

    animator.beginFrame(makeView({ hands: [["1m"], [], [], []] }));
    recordLayouts(animator, [
      { sorted: ["1m"] },
      { sorted: [] },
      { sorted: [] },
      { sorted: [] },
    ]);
    const declaration = makeView({
      hands: [[], [], [], []],
      discards: [["1m"], [], [], []],
      discardTsumogiri: [[false], [], [], []],
      totalDiscards: 1,
      freshlyDiscardedSeat: 0,
      riichiDeclared: [true, false, false, false],
      riichiTileIdx: [0, null, null, null],
    });
    animator.beginFrame(declaration);

    expect(animator.getAnim(0)).toMatchObject({
      isRiichi: true,
      isRiichiDeclaration: true,
    });
    now = SEQ_SLIDE_MS;
    animator.beginFrame(declaration);
    expect(declarations).toEqual([true]);
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

  it("distinguishes a normal five discard from a drawn red five", () => {
    const animator = new DiscardAnimator({ now: () => 0 });
    const before = makeView({
      hands: [["2p", "5p", "8p", "0p"], [], [], []],
      freshlyDrawnSeat: 0,
    });
    animator.beginFrame(before);
    recordLayouts(animator, [
      { sorted: ["2p", "5p", "8p", "0p"], isFreshlyDrawn: true },
      { sorted: [] },
      { sorted: [] },
      { sorted: [] },
    ]);

    animator.beginFrame(
      makeView({
        hands: [["2p", "8p", "0p"], [], [], []],
        discards: [["5p"], [], [], []],
        discardTsumogiri: [[false], [], [], []],
        totalDiscards: 1,
        freshlyDiscardedSeat: 0,
      })
    );

    expect(animator.getAnim(0)?.sourceSlot?.handIndex).toBe(1);
  });

  it("does not reinterpret authoritative tedashi when the drawn value matches", () => {
    const animator = new DiscardAnimator({ now: () => 0 });
    const before = makeView({
      hands: [["5m", "2m", "3m", "5m"], [], [], []],
      freshlyDrawnSeat: 0,
    });
    animator.beginFrame(before);
    recordLayouts(animator, [
      { sorted: ["5m", "2m", "3m", "5m"], isFreshlyDrawn: true },
      { sorted: [] },
      { sorted: [] },
      { sorted: [] },
    ]);

    animator.beginFrame(
      makeView({
        hands: [["2m", "3m", "5m"], [], [], []],
        discards: [["5m"], [], [], []],
        discardTsumogiri: [[false], [], [], []],
        discardSources: [["hand"], [], [], []],
        totalDiscards: 1,
        freshlyDiscardedSeat: 0,
      })
    );

    expect(animator.getAnim(0)?.sourceSlot?.handIndex).toBe(0);
    expect(animator.getAnim(0)?.draggedSourceCenter).toBeNull();
  });

  it("carries a dragged tile center into the next phase-A discard", () => {
    const animator = new DiscardAnimator({ now: () => 0 });
    const before = makeView({
      hands: [["1m", "2m", "3m"], [], [], []],
    });
    animator.beginFrame(before);
    recordLayouts(animator, [
      { sorted: ["1m", "2m", "3m"] },
      { sorted: [] },
      { sorted: [] },
      { sorted: [] },
    ]);
    animator.setNextDiscardSourceHint(0, "2m", 0, {
      x: 240,
      y: -135,
    });

    animator.beginFrame(
      makeView({
        hands: [["1m", "3m"], [], [], []],
        discards: [["2m"], [], [], []],
        discardSources: [["hand"], [], [], []],
        totalDiscards: 1,
        freshlyDiscardedSeat: 0,
      })
    );

    expect(animator.getAnim(0)?.sourceSlot?.handIndex).toBe(1);
    expect(animator.getAnim(0)?.draggedSourceCenter).toEqual({
      x: 240,
      y: -135,
    });
  });

  it("clears a pending dragged source center on reset", () => {
    const animator = new DiscardAnimator({ now: () => 0 });
    animator.setNextDiscardSourceHint(0, "2m", 0, { x: 240, y: -135 });
    animator.reset();
    const before = makeView({ hands: [["1m", "2m"], [], [], []] });
    animator.beginFrame(before);
    recordLayouts(animator, [
      { sorted: ["1m", "2m"] },
      { sorted: [] },
      { sorted: [] },
      { sorted: [] },
    ]);

    animator.beginFrame(
      makeView({
        hands: [["1m"], [], [], []],
        discards: [["2m"], [], [], []],
        discardSources: [["hand"], [], [], []],
        totalDiscards: 1,
        freshlyDiscardedSeat: 0,
      })
    );

    expect(animator.getAnim(0)?.draggedSourceCenter).toBeNull();
  });
});
