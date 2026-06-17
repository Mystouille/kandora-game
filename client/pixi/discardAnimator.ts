/**
 * Discard animation orchestrator.
 *
 * Drives the two-phase discard slide used by `TableRenderer`:
 *
 *   Phase A ("to-nudge", on `discard`):
 *     The discarded tile appears at the slot it was held in
 *     (visually "underneath" the hand tile, which we hide for
 *     the duration), and slides to the +10/+10 "nudged" pond
 *     position the static renderer normally draws.
 *
 *   Phase B ("to-final", on the next `draw` / `call` / `win`
 *     that clears `freshlyDiscardedSeat`):
 *     The same tile slides from the nudged position to its
 *     final, flush-with-the-row position.
 *
 * Scope of the current implementation:
 *   - All four seats, focused + hidden + revealed hands.
 *   - Focused-hand re-sort animation is intentionally deferred;
 *     after phase B the hand snaps to its new sort.
 *
 * The animator only owns *semantic* state — which discard is
 * animating, which hand slot to hide, when the animation started.
 * Geometry (computing the source / destination positions) lives
 * in `TableRenderer.renderSeat`, which already knows the per-seat
 * sheets, sizes, and container transforms.
 *
 * Re-renders during an active animation are driven by the Pixi
 * `app.ticker` hook the renderer installs; the animator just
 * exposes `hasActive()` so the host can decide whether to keep
 * pumping `render()` calls.
 */

import type { MatchView } from "../store";

/** Number of seats. Matches the rest of the renderer. */
const SEAT_COUNT = 4;

/** Per-spec snappy timings (ms). */
export const PHASE_A_DURATION_MS = 250;
export const PHASE_B_DURATION_MS = 120;

/** Hidden hand slot for tedashi from a concealed (non-focused,
 * not-revealed) hand. Spec: "near the middle of the hand
 * (static position)". Slot index in the 14-slot post-draw layout. */
const HIDDEN_HAND_TEDASHI_SLOT = 5;

/** Linear → ease-out cubic for slide animations. */
export function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

export type DiscardPhase = "to-nudge" | "to-final";

/**
 * Per-seat phase-A hand layout snapshot.
 *
 * Captured at discard time so the renderer can paint the
 * *pre-discard* hand strip (with one slot blanked) instead of
 * the freshly-sorted post-discard view.
 *
 * - `hand`: tile-or-null array. `null` slots are rendered as
 *   face-down backs (opponent layout) or as gaps (focused /
 *   revealed layout) depending on what the surrounding slots
 *   look like in the live view. We additionally track the
 *   hidden slot explicitly via {@link hiddenSlot} so the renderer
 *   knows which slot to omit entirely.
 * - `hiddenSlot`: index in `hand` to skip when painting.
 * - `isFreshlyDrawn`: whether the snapshot's last slot is the
 *   "drawn 14th" (drives TSUMO_GAP in the renderer).
 * - `isConcealed`: true when the seat's hand tiles were unknown
 *   in the pre-discard view (i.e. the renderer was drawing
 *   backs). Drives whether non-hidden `null` entries should be
 *   painted as backs or skipped.
 */
export interface PhaseAHandSnapshot {
  hand: Array<string | null>;
  hiddenSlot: number;
  isFreshlyDrawn: boolean;
  isConcealed: boolean;
}

/**
 * Active discard animation for a single seat.
 *
 * At most one animation per seat is tracked: a fresh discard
 * supersedes any in-progress phase B on the same seat (in
 * practice this never collides because phase B is short and
 * the next discard can only happen after a draw, by which
 * point phase B is well past).
 */
export interface DiscardAnimation {
  seat: number;
  /** Discard index in `view.discards[seat]` that this animation
   * tracks. Always equals `view.discards[seat].length - 1` at
   * creation time and through both phases. */
  discardIndex: number;
  tile: string;
  /** True iff this discard was the seat's riichi-declaration
   * sideways tile. Carried through both phases so the renderer
   * picks the rotated riichi sheet for the animated sprite. */
  isRiichi: boolean;
  /** Tsumogiri flag from the discard event. Hidden-hand
   * animations source from the rightmost slot when true, from
   * {@link HIDDEN_HAND_TEDASHI_SLOT} otherwise. */
  isTsumogiri: boolean;
  phase: DiscardPhase;
  startMs: number;
  durationMs: number;
  /** Phase-A only: source slot in the pre-discard hand layout.
   * `null` during phase B (we don't need it anymore). */
  sourceSlot: { handIndex: number; handLength: number } | null;
  /** Phase-A only: snapshot of the pre-discard hand to display
   * while the slot animates. Cleared on phase-B transition so
   * the renderer falls back to the live `view.hands[seat]`. */
  phaseASnapshot: PhaseAHandSnapshot | null;
}

interface AnimatorOptions {
  /** Injectable for tests. Defaults to `performance.now`. */
  now?: () => number;
}

/**
 * Lookup of cached pre-discard hand snapshots taken every frame,
 * so we can read the *just-prior* hand layout the instant a
 * discard event lands. Indexed by seat.
 */
type PrevHandCache = Array<{
  /** Sorted hand layout exactly as the renderer would have drawn
   * it on the previous frame: sortedClosed + (drawnTile if
   * freshly drawn), or `[null, …]` for concealed seats. */
  sorted: Array<string | null>;
  isFreshlyDrawn: boolean;
  isConcealed: boolean;
}>;

export class DiscardAnimator {
  private readonly anims = new Map<number, DiscardAnimation>();
  private readonly now: () => number;
  /** Last `view` we processed in {@link beginFrame}. Used to diff. */
  private prevView: MatchView | null = null;
  /** Last frame's hand layouts (per seat) the renderer would have
   * painted. Populated by {@link recordHandLayouts}, called from
   * `renderSeat` so we don't have to re-do the sort here. */
  private prevHandLayouts: PrevHandCache = makeEmptyHandCache();
  /** Staging area for the *current* frame's hand layouts; rolled
   * into {@link prevHandLayouts} at the end of `beginFrame`. */
  private currentHandLayouts: PrevHandCache = makeEmptyHandCache();
  /** One-shot suppression flag — `true` means the next
   * {@link beginFrame} skips animation scheduling (snap straight
   * to the new state). Set by {@link snapNext}. */
  private snapNextFlag = false;
  /** Global animation enable flag. When `false`, the animator
   * still tracks diffs but never schedules new animations. */
  private enabled = true;
  /** Per-seat "the next discard from this seat originated at
   * the N-th occurrence of `tile` in the player's display
   * order" hint. Consumed (and cleared) when phase A is
   * scheduled. Used to disambiguate which copy of a duplicate
   * tile the player actually clicked, so the discard animation
   * sources from the correct slot. */
  private readonly nextDiscardSourceHints = new Map<
    number,
    { tile: string; ord: number }
  >();

  constructor(options: AnimatorOptions = {}) {
    this.now = options.now ?? (() => performance.now());
  }

  /** Disable / re-enable animation scheduling globally. Already
   * in-flight animations finish normally. */
  setEnabled(flag: boolean): void {
    this.enabled = flag;
    if (!flag) {
      this.anims.clear();
    }
  }

  /**
   * Stash a hint that the player's *next* discard from `seat`
   * originated at the `ord`-th visible occurrence of `tile` in
   * their current display order (0-based). The hint is
   * consumed by the next phase-A schedule for that seat and
   * lets {@link pickHiddenSlot} pick the actually-clicked copy
   * of a duplicate tile instead of falling back to "first
   * occurrence in display order".
   */
  setNextDiscardSourceHint(seat: number, tile: string, ord: number): void {
    this.nextDiscardSourceHints.set(seat, { tile, ord });
  }

  /** One-shot: skip animation diffing for the next
   * {@link beginFrame} call only. Used by the replay viewer to
   * suppress animations during scroll-scrubbing while keeping
   * single-step clicks animated. */
  snapNext(): void {
    this.snapNextFlag = true;
    this.anims.clear();
  }

  /** Drop all in-flight animations and forget prev state.
   * Called on snapshot resync, hand boundaries, and unmount. */
  reset(): void {
    this.anims.clear();
    this.prevView = null;
    this.prevHandLayouts = makeEmptyHandCache();
    this.currentHandLayouts = makeEmptyHandCache();
    this.snapNextFlag = false;
  }

  /**
   * Called by `TableRenderer.renderSeat` immediately after it
   * decides which `(hand, isFreshlyDrawn, isConcealed)` triple
   * it would render for this seat *if no animation were active*.
   *
   * This sidesteps duplicating `sortHand` here, and lets us read
   * the exact pre-discard layout on the next frame.
   *
   * Must be called for every seat every frame, even when an
   * animation is active (we record the would-be-rendered layout
   * not the actually-rendered one).
   */
  recordHandLayout(
    seat: number,
    layout: {
      sorted: Array<string | null>;
      isFreshlyDrawn: boolean;
      isConcealed: boolean;
    }
  ): void {
    this.currentHandLayouts[seat] = {
      sorted: layout.sorted.slice(),
      isFreshlyDrawn: layout.isFreshlyDrawn,
      isConcealed: layout.isConcealed,
    };
  }

  /**
   * Diff `view` vs the last frame and (a) schedule new phase-A
   * animations for any seat that just discarded, (b) transition
   * any pending phase-A to phase B when `freshlyDiscardedSeat`
   * clears, (c) drop animations that have run their course.
   *
   * Call once per `render()` at the top, *before* any
   * `renderSeat` calls.
   */
  beginFrame(view: MatchView): void {
    const prev = this.prevView;
    const now = this.now();

    // Promote the layouts recorded during the previous render so
    // this frame's diff reads the hand exactly as it was last
    // painted on screen. Reset the staging area before the new
    // `renderSeat` calls repopulate it.
    this.prevHandLayouts = this.currentHandLayouts;
    this.currentHandLayouts = makeEmptyHandCache();

    // Hard reset on hand boundary or snapshot resync. Detect via
    // a backwards / cleared `totalDiscards` (hand_start resets to
    // 0) or a drop in any per-seat discard pile (snapshot replace).
    let hardReset = false;
    if (prev) {
      if (view.totalDiscards < prev.totalDiscards) {
        hardReset = true;
      } else {
        for (let s = 0; s < SEAT_COUNT; s++) {
          if (
            (view.discards[s]?.length ?? 0) < (prev.discards[s]?.length ?? 0)
          ) {
            hardReset = true;
            break;
          }
        }
      }
    }
    if (hardReset) {
      this.anims.clear();
      // A hard reset means the semantic hand/discard relation
      // jumped discontinuously (call claimed a discard, hand_end,
      // snapshot resync). The layouts we cached from the previous
      // frame no longer describe the visible hand, so keep them
      // from seeding the next discard snapshot.
      this.prevHandLayouts = makeEmptyHandCache();
    }

    const snap = this.snapNextFlag || !this.enabled;
    this.snapNextFlag = false;

    // Drop completed animations (we still scan them below to
    // decide phase transitions, so we drop *after* the diff).
    if (!snap && prev) {
      for (let seat = 0; seat < SEAT_COUNT; seat++) {
        const prevDiscards = prev.discards[seat] ?? [];
        const currDiscards = view.discards[seat] ?? [];
        const prevLen = prevDiscards.length;
        const currLen = currDiscards.length;

        // --- (a) New discard? Schedule phase A. ----------------
        if (currLen > prevLen && currLen > 0) {
          const lastIdx = currLen - 1;
          const tile = currDiscards[lastIdx];
          const isTsumogiri = view.discardTsumogiri[seat]?.[lastIdx] ?? false;
          const isRiichi = view.riichiTileIdx[seat] === lastIdx;

          // The pre-discard layout we want to capture is exactly
          // what was rendered on the previous frame for this seat.
          const prevLayout = this.prevHandLayouts[seat];
          const hint = this.nextDiscardSourceHints.get(seat) ?? null;
          this.nextDiscardSourceHints.delete(seat);
          const sourceSlot = pickHiddenSlot({
            sortedHand: prevLayout.sorted,
            isFreshlyDrawn: prevLayout.isFreshlyDrawn,
            isConcealed: prevLayout.isConcealed,
            discardedTile: tile,
            isTsumogiri,
            hint,
          });

          this.anims.set(seat, {
            seat,
            discardIndex: lastIdx,
            tile,
            isRiichi,
            isTsumogiri,
            phase: "to-nudge",
            startMs: now,
            durationMs: PHASE_A_DURATION_MS,
            sourceSlot: {
              handIndex: sourceSlot,
              handLength: prevLayout.sorted.length,
            },
            phaseASnapshot: makePhaseASnapshot(prevLayout, sourceSlot),
          });
        }

        // --- (b) Phase A → Phase B on next *draw* event. -------
        //
        // We deliberately ignore other transitions that clear
        // `freshlyDiscardedSeat` (e.g. an in-flight call prompt
        // that ends with a `call` event, or a `hand_end`):
        //   - `call` shrinks the discarder's pile, which the
        //     hard-reset block above catches and clears.
        //   - `hand_end` zeroes `totalDiscards`, same.
        //   - A pure pass (everyone declines the call prompt)
        //     resolves into a `draw` for the next seat, which
        //     is exactly what we trigger phase B on.
        // The upshot: between a discard and the next draw the
        // hand keeps its gap and the discard tile stays parked
        // at the +10/+10 nudged position, which is what users
        // expect while a call window is still open.
        const wasFresh = prev.freshlyDiscardedSeat === seat;
        const isFresh = view.freshlyDiscardedSeat === seat;
        const drewThisFrame =
          view.freshlyDrawnSeat !== null &&
          prev.freshlyDrawnSeat !== view.freshlyDrawnSeat;
        const existing = this.anims.get(seat);
        if (
          wasFresh &&
          !isFresh &&
          drewThisFrame &&
          existing &&
          existing.phase === "to-nudge" &&
          currLen > 0
        ) {
          // The static last-discard index might shift if a new
          // discard happens in the same frame (rare; would imply
          // two discards per frame, which the wire protocol
          // doesn't produce). Re-anchor to the current last index.
          //
          // We keep `phaseASnapshot` populated through phase B
          // so the hand stays gapped while the discard tile
          // slides to its flush position; the gap closes only
          // once the animation is dropped after phase B elapses.
          this.anims.set(seat, {
            ...existing,
            discardIndex: currLen - 1,
            phase: "to-final",
            startMs: now,
            durationMs: PHASE_B_DURATION_MS,
          });
        }
      }
    }

    // --- (c) Drop animations whose progress has elapsed. --------
    //
    // Phase A animations are NOT dropped on duration elapse:
    // once the tile has reached the nudged position we want it
    // to *stay* there (with the hand free to close its gap)
    // until a draw event triggers phase B. They're dropped via
    // hard-reset (call / hand_end) or via the phase-B transition
    // above.
    //
    // We DO clear `phaseASnapshot` once phase A elapses: the
    // discarder's hand should re-flow into the gap as soon as
    // the slide animation reaches the nudged position, rather
    // than waiting for the next draw. The animation entry stays
    // alive (with `phase: "to-nudge"` and progress saturating at
    // 1) so the discard tile keeps painting at the nudged
    // position; only the per-frame hand snapshot is dropped.
    for (const [seat, anim] of this.anims) {
      if (anim.phase === "to-final" && now - anim.startMs >= anim.durationMs) {
        this.anims.delete(seat);
        continue;
      }
      if (
        anim.phase === "to-nudge" &&
        anim.phaseASnapshot !== null &&
        now - anim.startMs >= anim.durationMs
      ) {
        anim.phaseASnapshot = null;
      }
    }

    this.prevView = view;
  }

  /** True iff at least one animation is *currently sliding*
   * (i.e. has elapsed less than its full duration), OR a phase-A
   * snapshot is still pending clearance. The latter case is
   * needed so the host keeps pumping renders past the phase-A
   * duration: the snapshot is cleared inside `beginFrame`, so
   * one more render must fire after elapse to actually close
   * the hand's gap on screen. Phase-A entries whose snapshot
   * has already been cleared (tile parked at the nudged
   * position, hand re-flowed) are stable and don't count. */
  hasActive(): boolean {
    const now = this.now();
    for (const anim of this.anims.values()) {
      if (now - anim.startMs < anim.durationMs) {
        return true;
      }
      if (anim.phase === "to-nudge" && anim.phaseASnapshot !== null) {
        return true;
      }
    }
    return false;
  }

  /** Lookup the active animation for `seat`, if any. */
  getAnim(seat: number): DiscardAnimation | null {
    return this.anims.get(seat) ?? null;
  }

  /** Normalized progress 0..1 of the seat's animation, post-easing. */
  getProgress(seat: number, nowMs: number = this.now()): number {
    const anim = this.anims.get(seat);
    if (!anim) {
      return 1;
    }
    const t = Math.max(
      0,
      Math.min(1, (nowMs - anim.startMs) / anim.durationMs)
    );
    return easeOutCubic(t);
  }
}

function makeEmptyHandCache(): PrevHandCache {
  return Array.from({ length: SEAT_COUNT }, () => ({
    sorted: [] as Array<string | null>,
    isFreshlyDrawn: false,
    isConcealed: false,
  }));
}

/**
 * Choose which slot to hide in the pre-discard hand layout.
 *
 *   - Tsumogiri → always the rightmost slot (the drawn tile).
 *   - Tedashi on a revealed hand → the matching tile's sorted
 *     slot (we know exactly which tile left).
 *   - Tedashi on a concealed hand → a fixed middle slot per
 *     spec ({@link HIDDEN_HAND_TEDASHI_SLOT}).
 *
 * Falls back to the last slot if no good match is found (eg the
 * pre-discard cache hasn't populated yet — first event after
 * mount).
 */
function pickHiddenSlot(args: {
  sortedHand: Array<string | null>;
  isFreshlyDrawn: boolean;
  isConcealed: boolean;
  discardedTile: string;
  isTsumogiri: boolean;
  hint?: { tile: string; ord: number } | null;
}): number {
  const {
    sortedHand,
    isFreshlyDrawn,
    isConcealed,
    discardedTile,
    isTsumogiri,
    hint,
  } = args;
  const len = sortedHand.length;
  if (len === 0) {
    return 0;
  }
  if (isTsumogiri) {
    return len - 1;
  }
  if (isConcealed) {
    // Hand is all backs — pick the configured middle slot but
    // never the freshly-drawn slot (that's reserved for tsumogiri).
    const cap = isFreshlyDrawn ? Math.max(0, len - 2) : len - 1;
    return Math.min(HIDDEN_HAND_TEDASHI_SLOT, cap);
  }
  const closedEnd = isFreshlyDrawn ? len - 1 : len;
  // Click-hint path: if the click handler told us "the player
  // discarded the N-th occurrence of `tile` in display order",
  // honour that so duplicate-tile clicks animate from the
  // actually-clicked slot rather than always the leftmost copy.
  // Tile equality uses red-five normalization to match the
  // fallback scan below.
  if (hint !== null && hint !== undefined) {
    const hintNorm = normalizeFive(hint.tile);
    const discardNorm = normalizeFive(discardedTile);
    if (hintNorm === discardNorm) {
      let found = 0;
      for (let i = 0; i < closedEnd; i++) {
        const t = sortedHand[i];
        if (t !== null && normalizeFive(t) === discardNorm) {
          if (found === hint.ord) {
            return i;
          }
          found++;
        }
      }
    }
  }
  // Revealed / focused hand → find the discarded tile.
  // Red-five (`0X`) ↔ plain five (`5X`) collide visually but
  // never simultaneously appear in a hand, so an equality check
  // is safe.
  for (let i = 0; i < closedEnd; i++) {
    if (sortedHand[i] === discardedTile) {
      return i;
    }
  }
  // Edge case: tile only matches via red-five normalization.
  const normDiscard = normalizeFive(discardedTile);
  for (let i = 0; i < closedEnd; i++) {
    const t = sortedHand[i];
    if (!t) {
      continue;
    }
    if (normalizeFive(t) === normDiscard) {
      return i;
    }
  }
  // Should not reach here in well-formed input; default to last
  // closed slot so the animation still produces something.
  return Math.max(0, closedEnd - 1);
}

function normalizeFive(tile: string): string {
  return tile[0] === "0" ? `5${tile[1]}` : tile;
}

function makePhaseASnapshot(
  prevLayout: {
    sorted: Array<string | null>;
    isFreshlyDrawn: boolean;
    isConcealed: boolean;
  },
  hiddenSlot: number
): PhaseAHandSnapshot {
  return {
    hand: prevLayout.sorted.slice(),
    hiddenSlot,
    isFreshlyDrawn: prevLayout.isFreshlyDrawn,
    isConcealed: prevLayout.isConcealed,
  };
}
