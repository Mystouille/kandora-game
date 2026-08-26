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
 *   Phase B ("to-final", on the next `draw`):
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

/** Discard slide timings (ms). Phase A slides hand → nudge and remains
 * there until the next draw proves the tile was not called. Phase B then
 * settles nudge → final. */
export const PHASE_A_DURATION_MS = 350;
export const PHASE_B_DURATION_MS = 150;
/** Draw-in slide: the freshly drawn tile enters sliding from the wall
 * into the tsumo slot. Fixed 0.3s. */
export const DRAW_SLIDE_MS = 300;
/** Minimum visual time from a draw starting to that seat's discard starting. */
export const MIN_DRAW_TO_DISCARD_MS = 500;

/**
 * Live-spectator "sequenced" timeline (relay feeds only, enabled via
 * {@link DiscardAnimator.setSequenced}). A Tenhou relay delivers the
 * next player's draw ~0 ms after the previous discard, so without
 * spacing the discard and draw animate on top of each other. In
 * sequenced mode each discard/draw is scheduled on a serial clock so
 * one turn reads:
 *
 *   0.0s  discard starts sliding out of the hand
 *   0.3s  discard reaches the hover (nudge) position   → discard SFX
 *   0.8s  next action begins; the discard settles flush
 *   1.1s  draw slide finishes                          → draw SFX
 *   1.3s  earliest following discard
 *
 * (Plus any real server delay K from call windows, absorbed by the
 * `max(now, …)` in {@link DiscardAnimator.schedule}.)
 */
export const SEQ_SLIDE_MS = 300;
export const SEQ_HOVER_MS = 500;
/**
 * Catch-up bound. If the serial clock would schedule an animation
 * more than this far ahead of real time (rapid tsumogiri exchanges
 * arriving faster than the fixed cadence can play), snap it to
 * `now` so the viewer can't fall unboundedly behind the feed.
 */
export const SEQ_CATCHUP_CAP_MS = 2000;

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
  /** True iff this discard occupies the seat's current sideways
   * riichi marker. This may be the replacement tile after the original
   * declaration discard was called. Drives visual geometry only. */
  isRiichi: boolean;
  /** True only for the actual declaration event. Unlike `isRiichi`,
   * this does not transfer to the next pond tile when the declaration
   * tile is called away. Drives the one-time riichi SFX. */
  isRiichiDeclaration: boolean;
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
  /** Optional phase-A source center captured from a drag release,
   * expressed in focused hand-container coordinates. */
  draggedSourceCenter: { x: number; y: number } | null;
  /** Phase-A only: snapshot of the pre-discard hand to display
   * while the slot animates. Cleared on phase-B transition so
   * the renderer falls back to the live `view.hands[seat]`. */
  phaseASnapshot: PhaseAHandSnapshot | null;
  /** Sequenced mode: whether the "tile lands at hover" SFX has
   * already fired for this discard (fired once when phase A
   * elapses). Ignored outside sequenced mode. */
  landSoundPlayed: boolean;
}

/**
 * Active draw-in slide for a single seat.
 *
 * `startMs` may be in the *future* in sequenced mode: the draw is
 * held "pending" (the drawn tile stays hidden) until the preceding
 * discard has finished sliding + hovering, then the back slides in.
 */
interface DrawAnim {
  /** Real tsumo tile is painted hidden from here through slide end
   * (equals `startMs` outside sequenced mode — no pending phase). */
  hideFrom: number;
  /** Wall-clock ms the back starts sliding into the tsumo slot. */
  startMs: number;
  /** Sequenced mode: whether the "draw lands" SFX has fired. */
  soundPlayed: boolean;
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
  /** Per-seat draw-in animations. A fresh draw slides a face-down
   * back into the tsumo slot; independent of the discard `anims`
   * map (a seat never draws and discards in the same frame). */
  private readonly drawAnims = new Map<number, DrawAnim>();
  /** Per-seat draw start retained after the slide ends so a fast
   * following discard still observes the common minimum delay. */
  private readonly lastDrawStartMs: Array<number | null> = Array.from(
    { length: SEAT_COUNT },
    () => null
  );
  /** Whether this host requires the live draw-to-discard viewing beat. */
  private minimumDrawToDiscardDelayEnabled = false;
  /** Live-spectator serial timeline (see {@link setSequenced}). */
  private sequenced = false;
  /** Earliest wall-clock ms the next sequenced animation may start.
   * Advanced by {@link schedule} as each discard/draw is queued. */
  private sequenceFreeMs = 0;
  /** Sequenced-mode SFX hooks. Fired at the animation landings
   * (discard reaches hover; draw slide completes) so the cue tracks
   * the visual instead of the event arrival. Unset ⇒ silent (the
   * host plays event-driven SFX in non-sequenced modes). */
  private onDiscardLand:
    ((seat: number, isRiichiDeclaration: boolean) => void) | null = null;
  private onDrawLand: ((seat: number) => void) | null = null;
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
    {
      tile: string;
      ord: number;
      draggedSourceCenter: { x: number; y: number } | null;
    }
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
      this.drawAnims.clear();
      this.lastDrawStartMs.fill(null);
    }
  }

  /** Enable the live-only minimum between a draw and its discard. */
  setMinimumDrawToDiscardDelayEnabled(enabled: boolean): void {
    if (this.minimumDrawToDiscardDelayEnabled === enabled) {
      return;
    }
    this.minimumDrawToDiscardDelayEnabled = enabled;
    this.lastDrawStartMs.fill(null);
  }

  /**
   * Enable / disable the live-spectator "sequenced" timeline. When
   * on, discards hold at a hover and the following draw is delayed
   * so the two never animate on top of each other (see the
   * module-level {@link SEQ_SLIDE_MS} doc). Off (default) starts the
   * following draw immediately; in both modes that draw triggers the
   * discard's move from hover to its final position.
   */
  setSequenced(flag: boolean): void {
    if (this.sequenced === flag) {
      return;
    }
    this.sequenced = flag;
    this.anims.clear();
    this.drawAnims.clear();
    this.sequenceFreeMs = 0;
    this.lastDrawStartMs.fill(null);
  }

  /**
   * Register (or clear) the sequenced-mode SFX hooks. Only invoked
   * while {@link setSequenced} is on; the host must then suppress its
   * own event-driven discard/draw cues so they don't double up.
   */
  setSoundHooks(hooks: {
    onDiscardLand?: (seat: number, isRiichiDeclaration: boolean) => void;
    onDrawLand?: (seat: number) => void;
  }): void {
    this.onDiscardLand = hooks.onDiscardLand ?? null;
    this.onDrawLand = hooks.onDrawLand ?? null;
  }

  /**
   * Reserve the next slot on the serial timeline. Returns the start
   * time for an animation queued now, and advances the clock by
   * `handoffMs`. Falls back to `now` (dropping accumulated backlog)
   * when the clock has drifted more than {@link SEQ_CATCHUP_CAP_MS}
   * ahead of real time, so fast exchanges can't lag without bound.
   */
  private schedule(
    now: number,
    handoffMs: number,
    earliestStartMs: number = now
  ): number {
    let start = Math.max(now, this.sequenceFreeMs);
    if (start - now > SEQ_CATCHUP_CAP_MS) {
      start = now;
    }
    start = Math.max(start, earliestStartMs);
    this.sequenceFreeMs = start + handoffMs;
    return start;
  }

  /**
  * Stash a hint that the player's *next* discard from `seat`
   * originated at the `ord`-th visible occurrence of `tile` in
   * their current display order (0-based). The hint is
   * consumed by the next phase-A schedule for that seat and
   * lets {@link pickHiddenSlot} pick the actually-clicked copy
   * of a duplicate tile instead of falling back to "first
  * occurrence in display order". Drag releases additionally carry
  * the floating hand tile's center so phase A can start there.
   */
  setNextDiscardSourceHint(
    seat: number,
    tile: string,
    ord: number,
    draggedSourceCenter: { x: number; y: number } | null = null
  ): void {
    this.nextDiscardSourceHints.set(seat, {
      tile,
      ord,
      draggedSourceCenter,
    });
  }

  /** One-shot: skip animation diffing for the next
   * {@link beginFrame} call only. Used by the replay viewer to
   * suppress animations during scroll-scrubbing while keeping
   * single-step clicks animated. */
  snapNext(): void {
    this.snapNextFlag = true;
    this.anims.clear();
    this.drawAnims.clear();
    this.lastDrawStartMs.fill(null);
    this.nextDiscardSourceHints.clear();
    this.sequenceFreeMs = 0;
  }

  /** Drop all in-flight animations and forget prev state.
   * Called on snapshot resync, hand boundaries, and unmount. */
  reset(): void {
    this.anims.clear();
    this.drawAnims.clear();
    this.lastDrawStartMs.fill(null);
    this.sequenceFreeMs = 0;
    this.prevView = null;
    this.prevHandLayouts = makeEmptyHandCache();
    this.currentHandLayouts = makeEmptyHandCache();
    this.nextDiscardSourceHints.clear();
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
      this.drawAnims.clear();
      this.lastDrawStartMs.fill(null);
      this.sequenceFreeMs = 0;
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
    let nonSequencedDrawStarted = false;
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
          const discardSource = view.discardSources?.[seat]?.[lastIdx] ?? null;
          const isTsumogiri =
            discardSource === "draw" ||
            (discardSource === null &&
              (view.discardTsumogiri[seat]?.[lastIdx] ?? false));
          const isRiichi = view.riichiTileIdx[seat] === lastIdx;
          const isRiichiDeclaration =
            !(prev.riichiDeclared?.[seat] ?? false) &&
            (view.riichiDeclared?.[seat] ?? false);

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
            sourceKnown: discardSource !== null,
            hint,
          });
          const drawStartMs = this.minimumDrawToDiscardDelayEnabled
            ? this.lastDrawStartMs[seat]
            : null;
          const earliestDiscardStartMs =
            drawStartMs === null
              ? now
              : drawStartMs + MIN_DRAW_TO_DISCARD_MS;
          const discardStartMs = this.sequenced
            ? this.schedule(
                now,
                SEQ_SLIDE_MS + SEQ_HOVER_MS,
                earliestDiscardStartMs
              )
            : Math.max(now, earliestDiscardStartMs);
          this.lastDrawStartMs[seat] = null;

          this.anims.set(seat, {
            seat,
            discardIndex: lastIdx,
            tile,
            isRiichi,
            isRiichiDeclaration,
            isTsumogiri,
            phase: "to-nudge",
            // Sequenced mode queues the slide on the serial clock so it
            // can be held pending behind an in-flight draw; otherwise it
            // starts immediately.
            startMs: discardStartMs,
            durationMs: this.sequenced ? SEQ_SLIDE_MS : PHASE_A_DURATION_MS,
            sourceSlot: {
              handIndex: sourceSlot,
              handLength: prevLayout.sorted.length,
            },
            draggedSourceCenter: hint?.draggedSourceCenter ?? null,
            phaseASnapshot: makePhaseASnapshot(prevLayout, sourceSlot),
            landSoundPlayed: false,
          });
        }

        // --- (d) Fresh draw? Start the wall-slide draw animation. ---
        // A seat draws at the start of its turn (freshlyDrawnSeat set)
        // and discards at the end; the two never collide in one frame.
        if (view.freshlyDrawnSeat === seat && prev.freshlyDrawnSeat !== seat) {
          nonSequencedDrawStarted = !this.sequenced;
          // Sequenced mode delays the slide until the preceding discard
          // has slid + hovered (serial clock), holding the drawn tile
          // hidden until then; otherwise it slides immediately.
          const startMs = this.sequenced
            ? this.schedule(now, DRAW_SLIDE_MS)
            : now;
          this.lastDrawStartMs[seat] = this.minimumDrawToDiscardDelayEnabled
            ? startMs
            : null;
          this.drawAnims.set(seat, {
            hideFrom: now,
            startMs,
            soundPlayed: false,
          });
        }
      }
    }

    // A hovering discard settles to its flush slot ONLY once the following
    // draw begins, proving nobody called it. In sequenced mode that means
    // the scheduled draw slide has actually started; otherwise the draw
    // event itself is the trigger. A called tile is claimed straight from
    // hover by the hard reset above. Runs after the loop so this frame's
    // draw animation is available.
    if (!snap) {
      for (const [seat, anim] of this.anims) {
        if (anim.phase !== "to-nudge") {
          continue;
        }
        let nextDrawBegun = nonSequencedDrawStarted;
        if (this.sequenced) {
          for (const d of this.drawAnims.values()) {
            if (d.startMs > anim.startMs && now >= d.startMs) {
              nextDrawBegun = true;
              break;
            }
          }
        }
        if (nextDrawBegun) {
          this.anims.set(seat, {
            ...anim,
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
      // Sequenced: fire the "tile lands at hover" cue exactly once, the
      // moment phase A elapses (independent of the later +1s settle).
      if (
        this.sequenced &&
        anim.phase === "to-nudge" &&
        !anim.landSoundPlayed &&
        now - anim.startMs >= SEQ_SLIDE_MS
      ) {
        anim.landSoundPlayed = true;
        this.onDiscardLand?.(seat, anim.isRiichiDeclaration);
      }
      if (
        anim.phase === "to-nudge" &&
        anim.phaseASnapshot !== null &&
        now - anim.startMs >= anim.durationMs
      ) {
        anim.phaseASnapshot = null;
      }
    }

    // Draw-in animations are pure overlays; drop them once the slide
    // completes (a pending draw with a future `startMs` is kept). The
    // sequenced "draw lands" cue fires here, at slide completion.
    for (const [seat, d] of this.drawAnims) {
      if (now - d.startMs >= DRAW_SLIDE_MS) {
        if (this.sequenced && !d.soundPlayed) {
          d.soundPlayed = true;
          this.onDrawLand?.(seat);
        }
        this.drawAnims.delete(seat);
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
    for (const d of this.drawAnims.values()) {
      // `< startMs + DRAW_SLIDE_MS` is also true while a sequenced draw
      // is pending (future startMs), so the ticker reaches its slide.
      if (now - d.startMs < DRAW_SLIDE_MS) {
        return true;
      }
    }
    return false;
  }

  /** Lookup the active animation for `seat`, if any. */
  getAnim(seat: number): DiscardAnimation | null {
    return this.anims.get(seat) ?? null;
  }

  /** True while a confirmed discard is held at its hand source. */
  isDiscardWaitingToStart(seat: number): boolean {
    const anim = this.anims.get(seat);
    return anim !== undefined && this.now() < anim.startMs;
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

  /** True while the seat's draw-in slide is actually sliding (not
   * during a sequenced pending hold, where `startMs` is still in the
   * future — the back should not yet be on screen). */
  isDrawing(seat: number, nowMs: number = this.now()): boolean {
    const d = this.drawAnims.get(seat);
    return (
      d !== undefined && nowMs >= d.startMs && nowMs - d.startMs < DRAW_SLIDE_MS
    );
  }

  /** True while the real (view) tsumo tile must stay hidden: from the
   * draw event through slide completion, including the sequenced
   * pending hold before the slide begins. Equals {@link isDrawing}
   * outside sequenced mode. */
  isDrawTileHidden(seat: number, nowMs: number = this.now()): boolean {
    const d = this.drawAnims.get(seat);
    return (
      d !== undefined &&
      nowMs >= d.hideFrom &&
      nowMs - d.startMs < DRAW_SLIDE_MS
    );
  }

  /** Normalized 0..1 progress of the seat's draw-in slide, eased.
   * Clamped to 0 during a sequenced pending hold. */
  getDrawProgress(seat: number, nowMs: number = this.now()): number {
    const d = this.drawAnims.get(seat);
    if (d === undefined) {
      return 1;
    }
    const t = Math.max(0, Math.min(1, (nowMs - d.startMs) / DRAW_SLIDE_MS));
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
  sourceKnown: boolean;
  hint?: { tile: string; ord: number } | null;
}): number {
  const {
    sortedHand,
    isFreshlyDrawn,
    isConcealed,
    discardedTile,
    isTsumogiri,
    sourceKnown,
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
  // Legacy/external events may lack authoritative `discardSource`
  // provenance (the Tenhou relay reports every tsumogiri flag as false).
  // In that compatibility case only, a freshly-drawn revealed hand
  // discarding its drawn value is inferred as tsumogiri. Authoritative
  // `sourceKnown` tedashi must never take this value-based fallback when
  // an identical copy remains in the draw slot.
  if (!sourceKnown && isFreshlyDrawn && len > 0) {
    const drawn = sortedHand[len - 1];
    if (
      drawn !== null &&
      normalizeFive(drawn) === normalizeFive(discardedTile)
    ) {
      return len - 1;
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
