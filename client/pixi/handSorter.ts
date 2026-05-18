/**
 * Focused-hand sort + drag-to-reorder + smooth-slide animator.
 *
 * Three responsibilities, bundled because they're tightly coupled:
 *
 *   1. Custom sort persistence.
 *      A per-hand `sortFlag` (resets to `true` at every
 *      `hand_start`) controls whether the focused player's hand
 *      auto-sorts via the natural sort key on every draw / discard
 *      / call. The first time the player drags a tile, the flag
 *      flips to `false` and a `customOrder` permutation takes
 *      over; from then until the next hand boundary, the renderer
 *      respects the player's manual order. Discards and calls
 *      transparently splice tiles out of `customOrder`; draws
 *      append the new raw index at the right end.
 *
 *   2. Drag interaction state machine.
 *      Pointerdown on a focused-hand tile starts a "maybe drag";
 *      pointermove that exceeds a small px threshold promotes it
 *      to a real drag (and flips `sortFlag` to false on first
 *      promotion). While dragging, the dragged tile's screen
 *      position follows the cursor on the horizontal axis; as its
 *      center crosses a neighbour's center, the two tiles swap in
 *      `customOrder` (the gap "stays under" the dragged tile).
 *      Pointerup with no promotion is a click (caller fires the
 *      discard); pointerup after promotion is a drop, and the
 *      dragged tile slides to its final slot.
 *
 *   3. Slide animation.
 *      Whenever a tile's *target* slot x changes (swap during
 *      drag, drop release, draw / discard / call reshuffle, even
 *      sort-flag toggle), we capture its previously-rendered x
 *      and ease toward the new target over `SLIDE_DURATION_MS`.
 *      The dragged tile bypasses easing — it tracks the cursor
 *      directly.
 *
 * The renderer rebuilds Pixi sprites every frame, so we have no
 * stable graphics handles — everything is keyed by *raw-hand
 * index* (the index into `view.hands[seat]`). Raw indices are
 * stable across renders within a single non-mutating period; on
 * any mutation we diff the previous and current raw hand contents
 * (multiset, with ordinal disambiguation for duplicates) to
 * remap.
 */

import type { MatchView } from "../store";

/** Slide duration for swap / drop / re-sort animations (ms). */
export const HAND_SLIDE_DURATION_MS = 120;

/** Pointer movement threshold (design px) before a pointerdown
 * promotes to a drag rather than firing as a click. */
export const DRAG_PROMOTE_THRESHOLD_PX = 5;

/** Linear → ease-out cubic for slide animations. */
export function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

/** Outcome of pointerup, returned to the caller so it can decide
 * whether to fire a discard click. */
export type PointerUpResult =
  | { kind: "click"; rawIdx: number }
  | { kind: "drop"; rawIdx: number }
  | { kind: "none" };

/** Snapshot of a tile's last-rendered x and (optionally) an
 * in-flight slide animation toward a target slot x. Both are
 * tracked in handContainer-local coords. */
interface TileTrack {
  /** Current rendered x (handContainer-local), updated every
   * frame the tile is queried. */
  renderedX: number;
  /** If a slide animation is active, the source x at the time
   * the animation started. `null` means the tile is parked at
   * `renderedX` (no animation). */
  fromX: number | null;
  /** Target x for the slide. Equal to `renderedX` while parked. */
  toX: number;
  /** Animation start time (performance.now), or 0 when parked. */
  startMs: number;
}

interface DragState {
  /** Raw-hand index of the tile being dragged. */
  rawIdx: number;
  /** handContainer-local x of the pointer at pointerdown. */
  downLocalX: number;
  /** handContainer-local x of the pointer right now. */
  currentLocalX: number;
  /** Tile-left-edge x at pointerdown (so we follow the cursor
   * with the same grab offset). */
  downTileLeftX: number;
  /** Tile width along the long axis (so we can compute the
   * dragged tile's center for swap-threshold tests). */
  tileLongAxisLen: number;
  /** Total movement magnitude since pointerdown; once it
   * exceeds {@link DRAG_PROMOTE_THRESHOLD_PX} we promote to a
   * real drag. */
  totalMovementPx: number;
  /** True once the drag has been promoted past the threshold. */
  promoted: boolean;
}

export class HandSorter {
  /** When `true`, the focused hand auto-sorts on every draw /
   * discard / call (natural sort). When `false`, the player's
   * `customOrder` permutation is respected. Reset to `true` on
   * every {@link reset} (hand_start). */
  private sortFlag = true;

  /** Player-chosen display order, as raw-hand indices.
   * `customOrder[displaySlot] = rawIdx`. Length matches the
   * raw hand. `null` until the player first drags. */
  private customOrder: number[] | null = null;

  /** Cached previous-frame raw hand (tile strings, `null`
   * placeholders preserved). Used by {@link reconcile} to diff
   * draws / discards / calls and remap `customOrder`. */
  private prevRawHand: Array<string | null> | null = null;

  /** Per-rawIdx slide-animation tracking. */
  private tracks = new Map<number, TileTrack>();

  /** Drag state, or `null` when no pointer is down. */
  private drag: DragState | null = null;

  /** Listener fired whenever {@link sortFlag} flips (drag
   * promotion, explicit toggle, or boundary reset). Used by the
   * match route to keep the live-play menu's “Auto sort”
   * indicator in sync with the engine's actual state. */
  private onSortFlagChange: ((on: boolean) => void) | null = null;

  /** Injectable clock (defaults to performance.now). */
  private now: () => number = () => performance.now();

  setNow(fn: () => number): void {
    this.now = fn;
  }

  setOnSortFlagChange(cb: ((on: boolean) => void) | null): void {
    this.onSortFlagChange = cb;
  }

  /** Wipe all state. Call on `hand_start` (or on any boundary
   * where the previous hand's manual order must not bleed into
   * the next).
   *
   * `initialSortFlag` lets the host apply the player's menu
   * preference at round start: `true` (default) restores the
   * historical auto-sort behaviour; `false` starts the hand in
   * custom-order mode (no auto re-sort on draw, no TSUMO_GAP).
   */
  reset(initialSortFlag: boolean = true): void {
    const prev = this.sortFlag;
    this.sortFlag = initialSortFlag;
    this.customOrder = null;
    this.prevRawHand = null;
    this.tracks.clear();
    this.drag = null;
    if (prev !== initialSortFlag && this.onSortFlagChange) {
      this.onSortFlagChange(initialSortFlag);
    }
  }

  /** Imperative toggle for the auto-sort flag. When turning ON,
   * clears `customOrder` so the next render snaps the hand back
   * to natural sort (with smooth slide via the per-tile tracks).
   * When turning OFF, seeds `customOrder` from the current
   * natural order if missing, so subsequent reconciles preserve
   * whatever the player rearranges next. */
  setSortFlag(on: boolean, naturalRawIndices?: number[]): void {
    if (this.sortFlag === on) {
      return;
    }
    this.sortFlag = on;
    if (on) {
      this.customOrder = null;
    } else if (this.customOrder === null && naturalRawIndices) {
      this.customOrder = naturalRawIndices.slice();
    }
    if (this.onSortFlagChange) {
      this.onSortFlagChange(on);
    }
  }

  isSortFlagOn(): boolean {
    return this.sortFlag;
  }

  /** True while the pointer is down on a tile, regardless of
   * whether the gesture has promoted to a drag. */
  hasPointerDown(): boolean {
    return this.drag !== null;
  }

  /** True iff the gesture has crossed the promote threshold.
   * The renderer uses this to know whether to render the tile
   * as "floating" (follows cursor) vs. parked. */
  isDragging(): boolean {
    return this.drag !== null && this.drag.promoted;
  }

  /** Raw-hand index of the currently-dragged tile, if any. */
  getDraggedRawIdx(): number | null {
    return this.drag !== null && this.drag.promoted ? this.drag.rawIdx : null;
  }

  /** True iff at least one slide animation is mid-flight, or a
   * drag is in progress. Renderer uses this to keep pumping
   * re-renders via the ticker hook. */
  hasActiveAnimation(): boolean {
    if (this.drag?.promoted) {
      return true;
    }
    const now = this.now();
    for (const t of this.tracks.values()) {
      if (t.fromX !== null && now - t.startMs < HAND_SLIDE_DURATION_MS) {
        return true;
      }
    }
    return false;
  }

  /**
   * Reconcile internal state with the current raw hand. Call
   * once per render at the top, after any hand-boundary reset.
   *
   * Diffs `prevRawHand` vs `rawHand` to figure out which raw
   * indices were removed (discard / call) or appended (draw),
   * and rewrites `customOrder` so it continues to reference the
   * same physical tiles (with stable identity through the
   * re-indexing that the store does on every mutation).
   */
  reconcile(rawHand: Array<string | null>): void {
    if (
      this.prevRawHand !== null &&
      !rawHandsEqual(this.prevRawHand, rawHand)
    ) {
      // Skip the multiset remap when `rawHand` hasn't actually
      // mutated since the previous frame: `remapCustomOrder`'s
      // duplicate-disambiguation policy claims occurrences in
      // newRawHand index order, which can rotate raw-index
      // assignments between identical tiles even when the
      // contents are unchanged. The per-tile slide animator
      // then visually interpolates those phantom moves,
      // producing the "the other copy follows the dragged
      // tile" feedback loop. Identity-equal hands are by far
      // the common case (every render frame during a drag), so
      // this also cuts the per-frame work.
      if (this.customOrder !== null) {
        const oldOrder = this.customOrder.slice();
        const oldRawHand = this.prevRawHand;
        this.customOrder = remapCustomOrder(
          this.customOrder,
          oldRawHand,
          rawHand
        );
        // Migrate per-tile slide tracks across the remap so the
        // surviving tiles slide *from their previous visual
        // slot* to the new one (rather than from wherever the
        // newly-assigned rawIdx happened to be parked before).
        // Without this, a discard re-shuffles raw-index → slot
        // assignments for duplicate tiles, and each surviving
        // tile's track interpolates across the whole hand —
        // the "big shuffle" the user sees while the gap
        // collapses.
        this.migrateTracksAcrossRemap(
          oldOrder,
          oldRawHand,
          this.customOrder,
          rawHand
        );
      } else {
        // sortFlag-ON path: no customOrder to remap, but tracks
        // are still keyed by raw-hand index. A `discard` splices
        // the hand in the store, shifting raw indices ≥ the
        // discarded one down by 1; a `call` removes 1–3 tiles
        // with the same effect. Without re-keying tracks by
        // physical tile identity, every surviving tile to the
        // right of the spliced position inherits the previous
        // raw-idx neighbour's slot, producing visible spurious
        // slides on tiles that should have stayed put (and a
        // wrong source position for tiles that did move).
        this.tracks = remapTracksByTileIdentity(
          this.tracks,
          this.prevRawHand,
          rawHand
        );
      }
    }
    // Snapshot for next frame's diff.
    this.prevRawHand = rawHand.slice();
  }

  /**
   * Re-key per-rawIdx slide tracks after a remap so that each
   * new display slot's track inherits the *previous* visual
   * position of the same physical tile (matched by
   * `(tileName, ordinal-within-tile-in-display-order)`). Tiles
   * with no old counterpart (e.g. a fresh draw appended to the
   * end) get no track and will pop in at their target slot;
   * the next `getRenderX` call seeds a parked track there. The
   * dragged tile (if any) keeps its existing track verbatim so
   * the cursor-pinned position is preserved across the remap.
   */
  private migrateTracksAcrossRemap(
    oldOrder: number[],
    oldRawHand: Array<string | null>,
    newOrder: number[],
    newRawHand: Array<string | null>
  ): void {
    const NULL_KEY = "\u0000";
    // Snapshot each old slot's last-painted target x (== the
    // slot it was visually parked at on the previous frame).
    const oldSlotToX: Array<number | null> = oldOrder.map((oldRawIdx) => {
      const track = this.tracks.get(oldRawIdx);
      return track !== undefined ? track.toX : null;
    });
    // Group old slots by tile, in display order: the i-th entry
    // in `oldSlotsByTile.get(tile)` is the slot of the i-th
    // visible occurrence of `tile` in the *previous* display.
    const oldSlotsByTile = new Map<string, number[]>();
    for (let i = 0; i < oldOrder.length; i++) {
      const tile = oldRawHand[oldOrder[i]] ?? NULL_KEY;
      let list = oldSlotsByTile.get(tile);
      if (list === undefined) {
        list = [];
        oldSlotsByTile.set(tile, list);
      }
      list.push(i);
    }
    const draggedRawIdx =
      this.drag !== null && this.drag.promoted ? this.drag.rawIdx : null;
    // Rebuild `tracks` keyed by the new raw indices, inheriting
    // the visual x of the same (tile, ordinal) old slot when
    // available.
    const newTracks = new Map<number, TileTrack>();
    const claimedByTile: Record<string, number> = {};
    for (let i = 0; i < newOrder.length; i++) {
      const newRawIdx = newOrder[i];
      if (newRawIdx === draggedRawIdx) {
        // Preserve the cursor-pinned track for the dragged tile.
        const t = this.tracks.get(newRawIdx);
        if (t !== undefined) {
          newTracks.set(newRawIdx, t);
        }
        const tile = newRawHand[newRawIdx] ?? NULL_KEY;
        claimedByTile[tile] = (claimedByTile[tile] ?? 0) + 1;
        continue;
      }
      const tile = newRawHand[newRawIdx] ?? NULL_KEY;
      const ord = claimedByTile[tile] ?? 0;
      claimedByTile[tile] = ord + 1;
      const oldSlots = oldSlotsByTile.get(tile);
      const oldSlot =
        oldSlots !== undefined && ord < oldSlots.length ? oldSlots[ord] : null;
      const inheritedX = oldSlot !== null ? oldSlotToX[oldSlot] : null;
      if (inheritedX !== null) {
        // Park at the inherited x; the next `getRenderX` call
        // with the actual new slot x will detect the mismatch
        // and start a slide from here to there.
        newTracks.set(newRawIdx, {
          renderedX: inheritedX,
          fromX: null,
          toX: inheritedX,
          startMs: 0,
        });
      }
      // else: no inheritance (newly-drawn tile); leave it
      // unset so getRenderX pops it in at its target slot.
    }
    this.tracks = newTracks;
  }

  /**
   * Resolve the active display order (raw-hand indices, in
   * display-slot order) and whether to apply the
   * freshly-drawn TSUMO_GAP.
   *
   * - sortFlag on → natural sort, last slot is the drawn tile,
   *   gap = `isFreshlyDrawn`.
   * - sortFlag off → `customOrder`. The freshly-drawn tile keeps
   *   its TSUMO_GAP as long as it still occupies the rightmost
   *   slot of `customOrder` — i.e. the player has dragged some
   *   *other* tile but not yet touched the drawn one. The gap
   *   only disappears once the drawn tile itself is moved out
   *   of the right edge.
   */
  getDisplayOrder(
    rawHand: Array<string | null>,
    isFreshlyDrawn: boolean,
    naturalRawIndices: number[]
  ): { rawIndices: number[]; freshGap: boolean } {
    if (this.sortFlag) {
      return { rawIndices: naturalRawIndices, freshGap: isFreshlyDrawn };
    }
    // sortFlag off and no customOrder yet → fall back to the
    // raw-hand deal order (identity permutation `[0, 1, …, N-1]`)
    // so a hand that begins with auto-sort OFF is rendered in
    // its dealt sequence, not natural-sorted. The player's first
    // drag will then re-seed `customOrder` from the live display
    // order (see {@link setSortFlag}); explicit toggles always
    // go through {@link setSortFlag}, which never lands here.
    if (this.customOrder === null) {
      this.customOrder = rawHand.map((_, i) => i);
    }
    // Defensive: length mismatch (reconcile bug) — pad with any
    // missing raw indices appended.
    if (this.customOrder.length !== rawHand.length) {
      const seen = new Set(this.customOrder);
      for (let i = 0; i < rawHand.length; i++) {
        if (!seen.has(i)) {
          this.customOrder.push(i);
        }
      }
      this.customOrder = this.customOrder.filter((i) => i < rawHand.length);
    }
    // The drawn tile's raw index is `rawHand.length - 1` (the
    // engine always appends it at the end of the raw hand). The
    // gap survives as long as that raw index is still parked in
    // the rightmost display slot.
    const lastRaw = rawHand.length - 1;
    const drawnStillAtRight =
      isFreshlyDrawn &&
      this.customOrder.length > 0 &&
      this.customOrder[this.customOrder.length - 1] === lastRaw;
    return {
      rawIndices: this.customOrder.slice(),
      freshGap: drawnStillAtRight,
    };
  }

  /**
   * Returns the x position (handContainer-local) at which the
   * tile with raw-hand index `rawIdx` should be drawn this
   * frame, given its target slot x. Handles both the slide
   * animation and the "dragged tile follows cursor" case.
   */
  getRenderX(rawIdx: number, targetSlotX: number): number {
    // Dragged tile: position is pinned to the cursor, no easing.
    if (
      this.drag !== null &&
      this.drag.promoted &&
      this.drag.rawIdx === rawIdx
    ) {
      const x =
        this.drag.downTileLeftX +
        (this.drag.currentLocalX - this.drag.downLocalX);
      let track = this.tracks.get(rawIdx);
      if (track === undefined) {
        track = {
          renderedX: x,
          fromX: null,
          toX: x,
          startMs: 0,
        };
        this.tracks.set(rawIdx, track);
      } else {
        track.renderedX = x;
        track.fromX = null;
        track.toX = x;
        track.startMs = 0;
      }
      return x;
    }

    let track = this.tracks.get(rawIdx);
    const now = this.now();

    // First time we see this tile this hand: pop in at target,
    // no animation.
    if (track === undefined) {
      track = {
        renderedX: targetSlotX,
        fromX: null,
        toX: targetSlotX,
        startMs: 0,
      };
      this.tracks.set(rawIdx, track);
      return targetSlotX;
    }

    // Target changed since last frame — start a new slide from
    // the current rendered x to the new target.
    if (track.toX !== targetSlotX) {
      const currentX = this.computeCurrentX(track, now);
      track.fromX = currentX;
      track.toX = targetSlotX;
      track.startMs = now;
    }

    const x = this.computeCurrentX(track, now);
    track.renderedX = x;
    return x;
  }

  private computeCurrentX(track: TileTrack, now: number): number {
    if (track.fromX === null) {
      return track.toX;
    }
    const elapsed = now - track.startMs;
    if (elapsed >= HAND_SLIDE_DURATION_MS) {
      // Animation done — park.
      track.fromX = null;
      track.startMs = 0;
      track.renderedX = track.toX;
      return track.toX;
    }
    const t = elapsed / HAND_SLIDE_DURATION_MS;
    const eased = easeOutCubic(t);
    return track.fromX + (track.toX - track.fromX) * eased;
  }

  /** Forget tiles that are no longer in the hand. Call after
   * `reconcile` so removed raw indices don't keep firing
   * `hasActiveAnimation`. */
  pruneTracks(rawHand: Array<string | null>): void {
    for (const key of [...this.tracks.keys()]) {
      if (key >= rawHand.length) {
        this.tracks.delete(key);
      }
    }
  }

  /**
   * Begin tracking a pointerdown on the focused-hand tile at
   * raw-hand index `rawIdx`. Records the geometry needed for
   * later swap-threshold checks but does NOT yet flip the
   * sort flag — promotion happens on first pointermove past
   * the threshold.
   */
  pointerDown(args: {
    rawIdx: number;
    pointerLocalX: number;
    tileLeftX: number;
    tileLongAxisLen: number;
  }): void {
    this.drag = {
      rawIdx: args.rawIdx,
      downLocalX: args.pointerLocalX,
      currentLocalX: args.pointerLocalX,
      downTileLeftX: args.tileLeftX,
      tileLongAxisLen: args.tileLongAxisLen,
      totalMovementPx: 0,
      promoted: false,
    };
  }

  /**
   * Update the pointer position. If movement exceeds the
   * promote threshold and we haven't promoted yet, flip
   * `sortFlag` to false (initializing `customOrder` from the
   * current natural display order) and begin treating the
   * pointer as a drag.
   *
   * `slotXs` is the *current* (post-render, pre-this-call) x
   * positions of every display slot, in display order; we use
   * them to figure out which slot the dragged tile's center
   * has crossed into, and swap accordingly.
   */
  pointerMove(
    pointerLocalX: number,
    naturalRawIndicesIfPromoting: number[]
  ): void {
    if (this.drag === null) {
      return;
    }
    const dx = pointerLocalX - this.drag.currentLocalX;
    this.drag.totalMovementPx += Math.abs(dx);
    this.drag.currentLocalX = pointerLocalX;
    if (
      !this.drag.promoted &&
      Math.abs(pointerLocalX - this.drag.downLocalX) >=
        DRAG_PROMOTE_THRESHOLD_PX
    ) {
      this.drag.promoted = true;
      // Flip the sort flag and seed customOrder from the
      // current natural display so the dragged tile is in the
      // same slot it was before promotion.
      const wasOn = this.sortFlag;
      this.sortFlag = false;
      if (this.customOrder === null) {
        this.customOrder = naturalRawIndicesIfPromoting.slice();
      }
      if (wasOn && this.onSortFlagChange) {
        this.onSortFlagChange(false);
      }
    }
  }

  /**
   * After the renderer has computed each display slot's target
   * x for this frame's display order, ask the sorter whether a
   * swap should fire. Returns the new `customOrder` (or `null`
   * if no swap). The caller should re-render once a swap is
   * applied.
   *
   * `slotCenters[displaySlot]` is the center-x of slot
   * `displaySlot` in handContainer-local coords, assuming the
   * current `customOrder` is the layout.
   */
  maybeSwap(slotCenters: number[]): boolean {
    if (
      this.drag === null ||
      !this.drag.promoted ||
      this.customOrder === null
    ) {
      return false;
    }
    // The dragged tile's center follows the cursor.
    const draggedCenterX =
      this.drag.downTileLeftX +
      (this.drag.currentLocalX - this.drag.downLocalX) +
      this.drag.tileLongAxisLen / 2;
    let swapped = false;
    // Walk left as far as the cursor has crossed: each iteration
    // swaps the dragged tile one slot leftward (the displaced
    // tile slides under the cursor) and re-checks against the
    // *new* left neighbour. Without this multi-step walk, a
    // single render frame can only progress by one slot, which
    // produces an apparent "blocked after N tiles" cap whenever
    // the render rate can't keep up with the cursor velocity.
    let draggedDisplaySlot = this.customOrder.indexOf(this.drag.rawIdx);
    if (draggedDisplaySlot < 0) {
      return false;
    }
    while (draggedDisplaySlot > 0) {
      const leftSlot = draggedDisplaySlot - 1;
      const leftCenter = slotCenters[leftSlot];
      if (draggedCenterX >= leftCenter) {
        break;
      }
      const tmp = this.customOrder[leftSlot];
      this.customOrder[leftSlot] = this.customOrder[draggedDisplaySlot];
      this.customOrder[draggedDisplaySlot] = tmp;
      swapped = true;
      draggedDisplaySlot = leftSlot;
    }
    while (draggedDisplaySlot < this.customOrder.length - 1) {
      const rightSlot = draggedDisplaySlot + 1;
      const rightCenter = slotCenters[rightSlot];
      if (draggedCenterX <= rightCenter) {
        break;
      }
      const tmp = this.customOrder[rightSlot];
      this.customOrder[rightSlot] = this.customOrder[draggedDisplaySlot];
      this.customOrder[draggedDisplaySlot] = tmp;
      swapped = true;
      draggedDisplaySlot = rightSlot;
    }
    return swapped;
  }

  /**
   * End the gesture. Returns whether the caller should treat
   * it as a click (fire the original discard handler) or a
   * drop (just let the slide animation settle the tile).
   */
  pointerUp(): PointerUpResult {
    const drag = this.drag;
    this.drag = null;
    if (drag === null) {
      return { kind: "none" };
    }
    if (!drag.promoted) {
      return { kind: "click", rawIdx: drag.rawIdx };
    }
    // Force the dragged tile to slide from its current
    // cursor-tracked x to its target slot x: we mark the track
    // as "needs new animation" by setting toX to the (current)
    // cursor x and letting the next getRenderX call detect the
    // mismatch with the real target. Simpler: just drop the
    // track and let it re-seed at the target with no slide.
    // To get the *slide* feel, instead manually set up the
    // animation now from the current rendered x to its target
    // — but we don't know the target here (the renderer does).
    // The renderer will call getRenderX next frame with the
    // real targetSlotX; the track's `toX` is currently the
    // last cursor x, so the inequality check there will
    // schedule a fresh slide. Perfect.
    return { kind: "drop", rawIdx: drag.rawIdx };
  }

  /** Cancel any in-progress gesture without firing a click.
   * Used when the pointer leaves the canvas, the renderer is
   * destroyed, etc. */
  cancelGesture(): void {
    this.drag = null;
  }

  /** Tell the sorter that the supplied `MatchView` is a brand
   * new hand and the previous hand's manual sort should be
   * discarded. The renderer detects hand_start via the
   * `totalDiscards` reset (mirrors DiscardAnimator's logic). */
  static isHandBoundary(prev: MatchView | null, view: MatchView): boolean {
    if (prev === null) {
      return true;
    }
    return view.totalDiscards < prev.totalDiscards;
  }
}

/**
 * Compute a permutation of raw-hand indices that matches the
 * natural sort order the renderer would produce. Mirrors
 * `sortHand` in TableRenderer but returns indices instead of
 * tile strings.
 *
 * - Hands with any `null` placeholder (opponent / spectator
 *   redaction) are passed through identity-permuted.
 * - Freshly-drawn hands keep the drawn tile pinned to the
 *   right.
 */
export function naturalOrderRawIndices(
  rawHand: Array<string | null>,
  isFreshlyDrawn: boolean,
  tileSortKey: (t: string) => number
): number[] {
  if (rawHand.length === 0) {
    return [];
  }
  if (rawHand.some((t) => t === null)) {
    return rawHand.map((_, i) => i);
  }
  const tiles = rawHand as string[];
  if (isFreshlyDrawn && tiles.length >= 2) {
    const closedIndices = tiles
      .slice(0, tiles.length - 1)
      .map((t, i) => ({ t, i }));
    closedIndices.sort((a, b) => tileSortKey(a.t) - tileSortKey(b.t));
    return [...closedIndices.map((x) => x.i), tiles.length - 1];
  }
  const idxs = tiles.map((t, i) => ({ t, i }));
  idxs.sort((a, b) => tileSortKey(a.t) - tileSortKey(b.t));
  return idxs.map((x) => x.i);
}

/** Fast equality check for raw-hand snapshots: same length and
 * pointwise-equal contents (null tolerant). */
function rawHandsEqual(
  a: Array<string | null>,
  b: Array<string | null>
): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

/**
 * Remap a `customOrder` permutation across a raw-hand
 * mutation (draw / discard / call).
 *
 * Strategy: for each old raw index referenced by `customOrder`,
 * look up its tile string in the old hand, then claim the next
 * available occurrence of the same tile in the new hand. Old
 * indices that no longer have a matching tile (removed) drop
 * out. New raw indices not yet claimed (drawn tiles) are
 * appended in raw-index order at the end.
 *
 * Handles duplicates (e.g. three 5m) by tracking how many
 * occurrences of each tile have been claimed.
 */
export function remapCustomOrder(
  customOrder: number[],
  oldRawHand: Array<string | null>,
  newRawHand: Array<string | null>
): number[] {
  const NULL_KEY = "\u0000";
  const newIndicesByTile = new Map<string, number[]>();
  for (let i = 0; i < newRawHand.length; i++) {
    const key = newRawHand[i] ?? NULL_KEY;
    let list = newIndicesByTile.get(key);
    if (list === undefined) {
      list = [];
      newIndicesByTile.set(key, list);
    }
    list.push(i);
  }
  const result: number[] = [];
  const claimed = new Map<string, number>();
  for (const oldIdx of customOrder) {
    if (oldIdx < 0 || oldIdx >= oldRawHand.length) {
      continue;
    }
    const key = oldRawHand[oldIdx] ?? NULL_KEY;
    const list = newIndicesByTile.get(key);
    if (list === undefined) {
      continue;
    }
    const n = claimed.get(key) ?? 0;
    if (n < list.length) {
      result.push(list[n]);
      claimed.set(key, n + 1);
    }
  }
  // Append any new raw indices not yet placed (newly-drawn
  // tiles), preserving raw-index order so the natural
  // "appended at the right" appearance holds for draws.
  const placed = new Set(result);
  for (let i = 0; i < newRawHand.length; i++) {
    if (!placed.has(i)) {
      result.push(i);
    }
  }
  return result;
}

/**
 * Re-key a `tracks` map across a raw-hand mutation
 * (discard / call / draw) by matching physical tile identity
 * with ordinal disambiguation (left-to-right in raw-hand
 * order). Each new raw index inherits the track of the old
 * raw index that referenced the same physical tile.
 *
 * Used by the sortFlag-ON path in `reconcile`. Old raw indices
 * whose tiles are absent from `newRawHand` (the discarded /
 * called tiles) drop out. New raw indices with no match
 * (freshly-drawn tiles) get no track — `getRenderX` will seed
 * a parked track at their target slot on the next call.
 */
function remapTracksByTileIdentity(
  oldTracks: Map<number, TileTrack>,
  oldRawHand: Array<string | null>,
  newRawHand: Array<string | null>
): Map<number, TileTrack> {
  const NULL_KEY = "\u0000";
  // Group old raw indices by tile in raw-hand order so the
  // i-th entry is the i-th occurrence of that tile.
  const oldIndicesByTile = new Map<string, number[]>();
  for (let i = 0; i < oldRawHand.length; i++) {
    const key = oldRawHand[i] ?? NULL_KEY;
    let list = oldIndicesByTile.get(key);
    if (list === undefined) {
      list = [];
      oldIndicesByTile.set(key, list);
    }
    list.push(i);
  }
  const claimed = new Map<string, number>();
  const newTracks = new Map<number, TileTrack>();
  for (let i = 0; i < newRawHand.length; i++) {
    const key = newRawHand[i] ?? NULL_KEY;
    const list = oldIndicesByTile.get(key);
    if (list === undefined) {
      continue;
    }
    const n = claimed.get(key) ?? 0;
    if (n >= list.length) {
      continue;
    }
    claimed.set(key, n + 1);
    const track = oldTracks.get(list[n]);
    if (track !== undefined) {
      newTracks.set(i, track);
    }
  }
  return newTracks;
}
