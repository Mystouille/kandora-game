import { type SeatValues } from "~/game/protocol/seat";
/**
 * Pure step-function reducer for the rules engine.
 *
 *   step(state, action) → { state, events }
 *
 * - Returns a *new* state object; never mutates the input.
 * - Returns an empty event list (and the input state) when the action
 *   is illegal in the current phase. The caller decides whether to
 *   surface that to a UI; this keeps `step()` safe to use from
 *   speculative bot lookahead.
 *
 * Phase 1 step 5a adds win declarations (`tsumo`, `ron`) and the
 * hand → next-hand transition (`start_next_hand`). The event union
 * grows additively. Wire-format events live in
 * `app/game/protocol/messages.ts`; their shapes track this union.
 */

import type { Action, DiscardSource } from "./actions";
import {
  isActiveSeat,
  mapSeatValues,
  nextSeat,
  participantCount,
  seatDistance,
  seatValues,
  windForSeat,
  type PlayerCount,
} from "./seats";
import { handScoringContext } from "./scoringContext";
import {
  canDeclareNuki,
  getPendingRobbery,
  hasNukiInterruption,
  isNukiTile,
} from "./nuki";
import { waitsForRules } from "./tileAvailability";
import { dealMatch } from "./wall";
import {
  canTakeSanmaReplacement,
  getSanmaIndicatorPair,
  takeSanmaReplacement,
  type SanmaIndicatorPair,
  type SanmaReplacementKind,
} from "./wallTransitions";
import type { HandResult, MatchState, Meld } from "./state";
import { distributePayments } from "./payments";
import {
  shouldEndMatch,
  isFinalHandOfMatch,
  type MatchEndReason,
} from "./matchEnd";
import { scoreHand, type ScoreResult } from "./score";
import { settleMcrWin, type McrScoreResult } from "./scoring/mcr";
import { isQualifiedMcrScore, scoreMcrForState } from "./mcr/scoringContext";
import { isWinningShape } from "./shanten";
import { isAnkanLegalDuringRiichi } from "./riichiKan";
import { type Seat, type Tile, type Wind } from "./types";
import {
  applyChipDelta,
  checkBuuVictoryLegality,
  type ChipDelta,
  type IllegalVictoryReason,
} from "./buu";

export type EngineEvent =
  | {
      type: "draw";
      seat: Seat;
      tile: Tile;
      wallRemaining: number;
      /** Dead-wall rendering marker. Sanma Duplicate emits false because its
       * replacement comes from a personal queue; scoring follows the cause. */
      fromDeadWall?: boolean;
      /** Replacement cause is independent of Duplicate's physical tile source. */
      replacementKind?: "kan" | "nuki" | "flower";
      /** Opening-hand normalization restores thirteen tiles, not a playable turn. */
      opening?: boolean;
    }
  | {
      type: "nuki";
      seat: Seat;
      tile: Tile;
      stage: "declared" | "completed";
    }
  | {
      type: "flower";
      seat: Seat;
      tile: Tile;
    }
  | {
      type: "discard";
      seat: Seat;
      tile: Tile;
      tsumogiri: boolean;
      discardSource: DiscardSource;
      riichi?: boolean;
    }
  | {
      type: "win";
      winner: Seat;
      loser: Seat | null;
      winTile: Tile;
      /** Riichi-compatible display envelope retained for existing consumers. */
      score: ScoreResult;
      /** Authoritative MCR breakdown when the active family is MCR. */
      mcrScore?: McrScoreResult;
      delta: SeatValues<number>;
    }
  | {
      type: "hand_end";
      reason: "exhaustive_draw" | "tsumo" | "ron" | "abort";
      delta: SeatValues<number>;
      abortKind?: "kyuushuu" | "suufon_renda" | "suucha_riichi" | "sanchahou";
      /** Buu chip delta (winner gain, sinkers loss). Omitted when `buuMode` off. */
      chipDelta?: ChipDelta;
      /** Buu sinking-player count for this hand (winner excluded). */
      sinkingCount?: 0 | 1 | 2 | 3;
      /** True iff this hand consumed the winner's dabuken token. */
      dabukenConsumed?: boolean;
      /** True iff this hand awarded a dabuken to the winner. */
      dabukenAwarded?: boolean;
    }
  | {
      type: "ryuukyoku_declaration";
      seat: Seat;
      tenpai: boolean;
    }
  | {
      type: "buu_chombo";
      /** Seat penalized for an illegal victory under Buu rules. */
      seat: Seat;
      reason: IllegalVictoryReason;
      /** Chip delta applied as the penalty (sums to zero). */
      chipDelta: ChipDelta;
      /** In-game chip totals AFTER the penalty has been applied. */
      chips: ChipDelta;
    }
  | {
      type: "call";
      seat: Seat;
      meld: Meld;
    }
  | {
      type: "new_dora";
      indicator: Tile;
    }
  | {
      type: "hand_start";
      dealer: Seat;
      roundWind: Wind;
      roundNumber: number;
      honba: number;
      doraIndicators: Tile[];
    }
  | {
      type: "match_end";
      reason: MatchEndReason;
      finalScores: SeatValues<number>;
    };

/**
 * Per-seat furiten transition caused by a single `step()` call.
 * The engine emits one entry per seat whose
 * `isFuritenForRon(state, seat)` predicate flipped value
 * between the input and output states. Drives the UI's
 * "Furiten" indicator without forcing the renderer to recompute
 * the (relatively expensive) wait/scoreHand probes itself.
 *
 * Kept as a sibling field on `StepResult` rather than a member of
 * the `EngineEvent` union so existing event-array assertions in
 * the test suite stay stable.
 */
export type FuritenChange = { seat: Seat; active: boolean };

export interface StepResult {
  state: MatchState;
  events: EngineEvent[];
  /**
   * Per-seat furiten transitions caused by this step (empty/absent
   * when no seat's furiten status changed). Absent on rejected
   * actions (`events.length === 0`).
   */
  furitenChanges?: FuritenChange[];
}

const WINDS: readonly Wind[] = ["E", "S", "W", "N"];

function tileValue(tile: Tile): string {
  return `${tile[0] === "0" ? "5" : tile[0]}${tile[1]}`;
}

/** Whether `tile` is forbidden for the immediate discard after chi or pon. */
export function isDiscardForbiddenByKuikae(
  state: MatchState,
  seat: Seat,
  tile: Tile
): boolean {
  if (
    state.ruleSet.kuikae === "allowed" ||
    state.phase !== "awaiting_discard" ||
    state.turn !== seat ||
    state.lastDrawn[seat] !== null
  ) {
    return false;
  }

  const seatMelds = state.melds[seat];
  const meld = seatMelds[seatMelds.length - 1];
  if (meld?.type !== "chi" && meld?.type !== "pon") {
    return false;
  }
  const claimedTile = meld.claimedTile;
  if (claimedTile === null) {
    return false;
  }

  if (tileValue(tile) === tileValue(claimedTile)) {
    return true;
  }
  if (state.ruleSet.kuikae !== "full" || meld.type === "pon") {
    return false;
  }

  if (tile[1] !== claimedTile[1]) {
    return false;
  }

  const contributed = [...meld.tiles];
  const claimedIndex = contributed.lastIndexOf(claimedTile);
  if (claimedIndex < 0) {
    return false;
  }
  contributed.splice(claimedIndex, 1);
  const contributedRanks = contributed.map((value) =>
    Number(value[0] === "0" ? "5" : value[0])
  );
  const discardRank = Number(tile[0] === "0" ? "5" : tile[0]);
  const sequence = [...contributedRanks, discardRank].sort((a, b) => a - b);
  return sequence[1] - sequence[0] === 1 && sequence[2] - sequence[1] === 1;
}

/**
 * Draw a replacement through the explicit sanma policy, or the unchanged
 * four-player reserve path. Replacement cause is independent of tile source.
 */
function drawRinshan(
  next: MatchState,
  replacementTile?: Tile,
  kind: SanmaReplacementKind = "kan"
):
  | { tile: Tile; fixedDeadWall: boolean; indicators?: SanmaIndicatorPair }
  | undefined {
  if (next.ruleSet.rulesFamily === "mcr") {
    if (replacementTile !== undefined) {
      const replacementIndex = next.liveWall.lastIndexOf(replacementTile);
      if (replacementIndex < 0) {
        return undefined;
      }

      next.liveWall.splice(replacementIndex, 1);
      return { tile: replacementTile, fixedDeadWall: true };
    }
    const replacement = next.liveWall.pop();
    return replacement === undefined
      ? undefined
      : { tile: replacement, fixedDeadWall: false };
  }
  if (next.ruleSet.playerCount === 3) {
    if (next.sanmaWall?.sanmaType !== next.ruleSet.sanmaType) {
      return undefined;
    }
    const replacement = takeSanmaReplacement(next, kind, replacementTile);
    if (!replacement) {
      return undefined;
    }
    return {
      ...replacement,
      fixedDeadWall: next.sanmaWall.mode === "duplicate",
    };
  }
  if (next.deadWall.length === 0 || next.liveWall.length === 0) {
    return undefined;
  }
  if (replacementTile !== undefined) {
    const replacementIndex = next.liveWall.indexOf(replacementTile);
    if (replacementIndex < 0) {
      return undefined;
    }
    next.liveWall.splice(replacementIndex, 1);
    return { tile: replacementTile, fixedDeadWall: true };
  }
  const rinshan = next.deadWall.shift();
  const reserved = next.liveWall.pop();
  if (rinshan === undefined || reserved === undefined) {
    return undefined;
  }
  next.deadWall.push(reserved);
  return { tile: rinshan, fixedDeadWall: false };
}

function finishReplacementDraw(next: MatchState, seat: Seat, tile: Tile): void {
  next.lastDrawFromDeadWall = true;
  next.lastDrawFromKong = true;
  if (next.ruleSet.rulesFamily === "mcr" && tile.endsWith("f")) {
    next.pendingFlower = { seat, tile };
    next.lastDrawn[seat] = null;
    next.phase = "awaiting_flower_replacement";
    return;
  }
  next.lastDrawn[seat] = tile;
  next.phase = "awaiting_discard";
}

/**
 * Capture the next kan-dora indicator and either reveal it now
 * (push to `doraIndicators` + emit `new_dora`) or defer it
 * (push to `pendingKanDora` for drainage at the declarer's next
 * discard). Mutates `next` in place and appends to `events`.
 *
 * The decision is driven by the per-kind rule-set flag:
 *   - minkan (daiminkan / shouminkan) → `instantlyRevealDoraForMinkan`
 *   - ankan                            → `instantlyRevealDoraForAnkan`
 *
 * Sanma uses the pair reserved by this replacement, independently of
 * nuki draws and reveal timing. The four-player slot calculation retains
 * `doraIndicators.length + pendingKanDora.length`
 * so consecutive deferred kans pick correct successive indicators
 * (the dead wall has shifted once per kan; the indicator tile is
 * captured at kan time so its identity is stable even if more
 * shifts happen before drainage). Caps the total reveals per
 * hand at 5 (matching the immediate-reveal path).
 *
 * No-op when `ruleSet.kanDora` is false.
 */
function captureKanDora(
  next: MatchState,
  kind: "minkan" | "ankan",
  events: EngineEvent[],
  fixedDeadWall = false,
  reservedIndicators?: SanmaIndicatorPair
): void {
  if (!next.ruleSet.kanDora) {
    return;
  }
  const totalRevealed = next.doraIndicators.length + next.pendingKanDora.length;
  if (totalRevealed >= 5) {
    return;
  }
  const nextIdx = (fixedDeadWall ? 4 : 3) + totalRevealed * 2;
  const indicator =
    next.ruleSet.playerCount === 3
      ? reservedIndicators?.dora
      : next.deadWall[nextIdx];
  if (indicator === undefined) {
    return;
  }
  const uraIndicator =
    next.ruleSet.playerCount === 3
      ? reservedIndicators?.ura
      : next.deadWall[nextIdx + 1];
  const instant =
    kind === "minkan"
      ? next.ruleSet.instantlyRevealDoraForMinkan
      : next.ruleSet.instantlyRevealDoraForAnkan;
  if (instant) {
    next.doraIndicators.push(indicator);
    if (uraIndicator !== undefined) {
      next.uraDoraIndicators.push(uraIndicator);
    }
    events.push({ type: "new_dora", indicator });
  } else {
    next.pendingKanDora.push(indicator);
    if (uraIndicator !== undefined) {
      next.pendingKanUraDora.push(uraIndicator);
    }
  }
}

/**
 * Drain any pending (deferred) kan-dora reveals onto the
 * `doraIndicators` array, emitting a `new_dora` event per entry.
 * Called at the end of any discard-style step (regular discard,
 * riichi discard) so deferred reveals from preceding kans become
 * visible to scoring on the very next ron / draw cycle.
 *
 * No-op when the queue is empty.
 */
function drainPendingKanDora(next: MatchState, events: EngineEvent[]): void {
  if (next.pendingKanDora.length === 0) {
    return;
  }
  for (const indicator of next.pendingKanDora) {
    next.doraIndicators.push(indicator);
    events.push({ type: "new_dora", indicator });
  }
  for (const uraIndicator of next.pendingKanUraDora) {
    next.uraDoraIndicators.push(uraIndicator);
  }
  next.pendingKanDora = [];
  next.pendingKanUraDora = [];
}

function clone(state: MatchState): MatchState {
  return {
    seed: state.seed,
    ruleSet: state.ruleSet,
    hands: state.hands.map((h) => [...h]),
    discards: state.discards.map((d) => [...d]),
    nukiTiles: state.nukiTiles.map((tiles) => [...tiles]),
    flowerTiles: state.flowerTiles.map((tiles) => [...tiles]),
    liveWall: [...state.liveWall],
    deadWall: [...state.deadWall],
    ...(state.sanmaWall ? { sanmaWall: { ...state.sanmaWall } } : {}),
    doraIndicators: [...state.doraIndicators],
    turn: state.turn,
    lastDrawn: [...state.lastDrawn],
    lastDrawFromDeadWall: state.lastDrawFromDeadWall,
    lastDrawFromKong: state.lastDrawFromKong ?? false,
    lastDiscard: state.lastDiscard ? { ...state.lastDiscard } : null,
    phase: state.phase,
    dealer: state.dealer,
    roundWind: state.roundWind,
    roundNumber: state.roundNumber,
    roundLimit: state.roundLimit,
    honba: state.honba,
    riichiSticks: state.riichiSticks,
    scores: [...state.scores] as SeatValues<number>,
    riichiDeclared: [...state.riichiDeclared] as SeatValues<boolean>,
    pendingRiichiSeat: state.pendingRiichiSeat,
    doubleRiichi: [...state.doubleRiichi] as SeatValues<boolean>,
    ippatsuEligible: [...state.ippatsuEligible] as SeatValues<boolean>,
    melds: state.melds.map((seatMelds) =>
      seatMelds.map((m) => ({ ...m, tiles: [...m.tiles] }))
    ),
    pendingShouminkan: state.pendingShouminkan
      ? { ...state.pendingShouminkan }
      : null,
    pendingNuki: state.pendingNuki ? { ...state.pendingNuki } : null,
    pendingFlower: state.pendingFlower ? { ...state.pendingFlower } : null,
    pendingRyuukyoku: state.pendingRyuukyoku
      ? {
          actualTenpai: [
            ...state.pendingRyuukyoku.actualTenpai,
          ] as SeatValues<boolean>,
          declarations: [...state.pendingRyuukyoku.declarations] as SeatValues<
            boolean | null
          >,
          nagashi: [...state.pendingRyuukyoku.nagashi] as SeatValues<boolean>,
        }
      : null,
    uraDoraIndicators: [...state.uraDoraIndicators],
    pendingKanDora: [...state.pendingKanDora],
    pendingKanUraDora: [...state.pendingKanUraDora],
    lastHandResult: state.lastHandResult,
    furitenLocked: [...state.furitenLocked] as SeatValues<boolean>,
    furitenTemp: [...state.furitenTemp] as SeatValues<boolean>,
    paoDaisangen: [...state.paoDaisangen],
    paoDaisuushii: [...state.paoDaisuushii],
    chips: [...state.chips] as SeatValues<number>,
    dabuken: [...state.dabuken] as SeatValues<boolean>,
  };
}

function closeDiscardWindow(next: MatchState): void {
  next.lastDiscard = null;
  next.pendingRiichiSeat = null;
}

function rejectPendingRiichi(next: MatchState, seat: Seat): void {
  next.riichiDeclared[seat] = false;
  next.doubleRiichi[seat] = false;
  next.ippatsuEligible[seat] = false;
  next.pendingRiichiSeat = null;
}

function noop(state: MatchState): StepResult {
  return { state, events: [] };
}

/** Seat wind for `seat` given current `dealer`. */
/**
 * True if `seat` is winning on the first uninterrupted go-around:
 * no calls (open or closed melds) anywhere, and discards prior to
 * `seat` only contain one tile each from the seats that have
 * already drawn-and-discarded once. The `winner` seat must itself
 * have zero discards.
 *
 * For tsumo this means tenhou (dealer) or chiihou (non-dealer).
 * For ron this is renhou (non-dealer ron on the first go-around
 * before drawing).
 */
function isFirstUninterruptedGoAround(
  state: MatchState,
  winner: Seat
): boolean {
  if (hasNukiInterruption(state)) {
    return false;
  }
  // No calls anywhere — any meld (chi/pon/kan/ankan/shouminkan)
  // disqualifies the entire hand for tenhou/chiihou/renhou.
  for (const seatMelds of state.melds) {
    if (seatMelds.length > 0) {
      return false;
    }
  }
  if (state.discards[winner].length > 0) {
    return false;
  }
  // Each seat must have at most one discard (their first), and
  // only the seats strictly between dealer and winner (inclusive of
  // dealer, exclusive of winner) in the rotation may have it.
  const distance = seatDistance(
    state.dealer,
    winner,
    state.ruleSet.playerCount
  );
  for (let i = 0; i < state.ruleSet.playerCount; i++) {
    const s = ((state.dealer + i) % state.ruleSet.playerCount) as Seat;
    const expected = i < distance ? 1 : 0;
    if (state.discards[s].length !== expected) {
      return false;
    }
  }
  return true;
}

/** True if `tile` is a terminal (1 or 9 of a numbered suit) or honor. */
function isTerminalOrHonor(tile: Tile): boolean {
  const suit = tile[tile.length - 1];
  if (suit === "z") {
    return true;
  }
  // Red 5 ("0X") is never terminal.
  const digit = tile[0];
  return digit === "1" || digit === "9";
}

/** Canonical key for a tile (red 5 collapsed to plain 5). */
function tileKey(tile: Tile): string {
  return (tile[0] === "0" ? "5" : tile[0]) + tile[1];
}

/**
 * After a chi/pon/daiminkan call lands, check whether the caller
 * just completed a third dragon meld (daisangen) or fourth wind
 * meld (daisuushii). If so, record the discarder as the pao
 * payer for that yakuman.
 *
 * Shouminkan upgrades and ankan declarations are intentionally
 * skipped — pao only triggers on a meld that another player fed
 * into the caller's hand.
 */
function detectPao(next: MatchState, caller: Seat, feeder: Seat): void {
  const melds = next.melds[caller];
  // Distinct dragon ranks present as pon/kan-class melds.
  const dragons = new Set<string>();
  const winds = new Set<string>();
  for (const m of melds) {
    if (m.type === "chi" || m.type === "ankan") {
      continue;
    }
    const tile = m.tiles[0];
    const suit = tile[tile.length - 1];
    if (suit !== "z") {
      continue;
    }
    const rank = Number(tile[0]);
    if (rank >= 5 && rank <= 7) {
      dragons.add(String(rank));
    } else if (rank >= 1 && rank <= 4) {
      winds.add(String(rank));
    }
  }
  if (dragons.size === 3 && next.paoDaisangen[caller] === null) {
    next.paoDaisangen[caller] = feeder;
  }
  if (winds.size === 4 && next.paoDaisuushii[caller] === null) {
    next.paoDaisuushii[caller] = feeder;
  }
}

/**
 * Furiten check for a ron declaration. Two flavors collapse into
 * one predicate:
 *   1. **Permanent / missed-ron furiten** — `state.furitenLocked[seat]`,
 *      set when the seat had a wait on a discard they did not ron
 *      (typically a riichi seat passing a winning tile).
 *   2. **Self-discard furiten** — any wait tile of `seat` is sitting
 *      in `state.discards[seat]`. Computed on demand by probing each
 *      unique own-discard tile through `scoreHand` with `tsumo:false`.
 *      A scoring agari with han ≥ 1 (or yakuman) on a probe tile
 *      means that tile is a true ron-wait, and therefore blocks all
 *      rons (full-furiten rule).
 *
 * Returns `true` if ron should be rejected.
 */
export function isFuritenForRon(state: MatchState, seat: Seat): boolean {
  if (state.ruleSet.rulesFamily === "mcr") {
    return false;
  }
  if (state.furitenLocked[seat] || state.furitenTemp[seat]) {
    return true;
  }
  if (state.discards[seat].length === 0) {
    return false;
  }
  // Hand-length invariant gate: `scoreHand` requires
  // `hand.length === 13 - 3 * melds.length`. The predicate is
  // meaningful only for waiting-to-ron hands (no drawn tile in
  // hand); the active seat mid-turn holds 14 tiles and would
  // otherwise blow up the probe below. `computeFuritenAll`
  // snapshots every seat on every step, so this guard is
  // necessary — not optional. The seat's furiten status doesn't
  // change just because they're holding their own draw.
  if (state.hands[seat].length !== 13 - 3 * state.melds[seat].length) {
    return false;
  }
  const seen = new Set<string>();
  for (const d of state.discards[seat]) {
    const key = tileKey(d);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    // Probe: would this tile complete the hand as a valid agari?
    const probe = (key[0] + key[1]) as Tile;
    // Fast shape gate before the expensive scoreHand call.
    if (!isWinningShape(state.hands[seat], state.melds[seat], probe)) {
      continue;
    }
    const score = scoreHand({
      ...handScoringContext(state, seat),
      hand: state.hands[seat],
      winTile: probe,
      tsumo: false,
      haiteiOrHoutei:
        state.phase === "awaiting_draw" && state.liveWall.length === 0,
      rinshanOrChankan: getPendingRobbery(state) !== null,
    });
    if (score.isAgari && (score.han > 0 || score.yakumanCount > 0)) {
      return true;
    }
  }
  return false;
}

/**
 * Update furiten state for any seat that had a wait on the
 * just-expired discard but did not ron. Called whenever
 * `lastDiscard` is consumed without a winning ron — i.e. the next
 * draw fires, or a chi/pon/kan call is taken.
 *
 * For every non-discarder seat whose `scoreHand` on `discardTile`
 * yields a valid agari (han ≥ 1 or yakuman):
 *   - if the seat is in riichi → set `furitenLocked[seat] = true`
 *     (permanent: cleared only at hand start);
 *   - otherwise → set `furitenTemp[seat] = true` (temporary:
 *     cleared at that seat's next discard).
 *
 * Together these cover the three furiten flavors:
 *   1. Self-discard furiten — checked on demand in
 *      `isFuritenForRon` by probing own discards.
 *   2. Temporary missed-ron furiten — `furitenTemp`, set here,
 *      cleared in the discard handler.
 *   3. Riichi (permanent) missed-ron furiten — `furitenLocked`,
 *      set here, persists for the hand.
 */
function lockMissedRonFuriten(
  next: MatchState,
  discardTile: Tile,
  discarder: Seat,
  chankan = false
): void {
  if (next.ruleSet.rulesFamily === "mcr") {
    return;
  }
  for (let s = 0; s < next.ruleSet.playerCount; s++) {
    if (s === discarder) {
      continue;
    }
    if (next.furitenLocked[s]) {
      continue;
    }
    const isRiichi = next.riichiDeclared[s];
    // Non-riichi seats that already have a temp lock don't need to
    // be re-evaluated — the lock stays set until their next discard
    // either way.
    if (!isRiichi && next.furitenTemp[s]) {
      continue;
    }
    const seat = s as Seat;
    // Fast shape gate: skip the expensive scoreHand call when the
    // discard doesn't even complete the hand. Wide-wait riichi
    // hands (e.g. suuankou tanki on `1112223334449s`) make this
    // gate the difference between sub-millisecond and multi-second
    // step(draw) latency.
    if (!isWinningShape(next.hands[seat], next.melds[seat], discardTile)) {
      continue;
    }
    // Hand-length invariant gate: `scoreHand` requires
    // `hand.length === 13 - 3 * melds.length`. The engine
    // normally maintains this, but transient mid-call states
    // (e.g. fixture setups for pon detection) can violate it.
    // Skip those seats rather than throw — they couldn't legally
    // win on this tile anyway.
    if (next.hands[seat].length !== 13 - 3 * next.melds[seat].length) {
      continue;
    }
    const score = scoreHand({
      ...handScoringContext(next, seat),
      hand: next.hands[seat],
      winTile: discardTile,
      tsumo: false,
      rinshanOrChankan: chankan,
    });
    if (score.isAgari && (score.han > 0 || score.yakumanCount > 0)) {
      if (isRiichi) {
        next.furitenLocked[seat] = true;
      } else {
        next.furitenTemp[seat] = true;
      }
    }
  }
}

/**
 * Stamp `next` with an abortive-draw result and emit the matching
 * `hand_end` event. Aborts carry zero score deltas (sticks stay on
 * the table and roll forward via the standard `start_next_hand`
 * dealer-keep / honba bookkeeping).
 */
function endAbort(
  next: MatchState,
  kind: "kyuushuu" | "suufon_renda" | "suucha_riichi" | "sanchahou"
): EngineEvent[] {
  const delta: SeatValues<number> = seatValues(
    next.ruleSet.playerCount,
    () => 0
  );
  next.phase = "hand_ended";
  next.lastHandResult = {
    reason: "abort",
    winner: null,
    loser: null,
    delta,
    tenpai: null,
    abortKind: kind,
    winHan: null,
    winYakuman: null,
  };
  return [{ type: "hand_end", reason: "abort", delta, abortKind: kind }];
}

/** Apply a delta vector into `scores` (mutates `scores` in place). */
function applyDelta(
  scores: SeatValues<number>,
  delta: readonly number[]
): void {
  for (let i = 0; i < scores.length; i++) {
    scores[i] += delta[i];
  }
}

/**
 * Resolve the pao payer for `winner` given `score`. Returns the
 * payer seat if pao applies (winner has a recorded pao liability
 * AND the corresponding yakuman is in the score), `null` otherwise.
 *
 * If both daisangen and daisuushii would apply (theoretically
 * possible with overlapping yakuman), the daisangen payer wins —
 * arbitrary tiebreak chosen for determinism.
 */
function paoPayerFor(
  state: MatchState,
  winner: Seat,
  score: ScoreResult
): Seat | null {
  if (!score.isYakuman) {
    return null;
  }
  const hasDaisangen = score.yaku["大三元"] !== undefined;
  const hasDaisuushii = score.yaku["大四喜"] !== undefined;
  if (hasDaisangen && state.paoDaisangen[winner] !== null) {
    return state.paoDaisangen[winner];
  }
  if (hasDaisuushii && state.paoDaisuushii[winner] !== null) {
    return state.paoDaisuushii[winner];
  }
  return null;
}

/**
 * Redirect the loser's payment to the pao payer.
 *   - Ron: the discarder pays nothing; the pao payer pays the full
 *     ron amount. If discarder == payer, delta is unchanged.
 *   - Tsumo: every non-winner's share is redirected to the pao
 *     payer (so payer pays the full mangan/yakuman amount, the
 *     other two non-winners pay zero).
 */
function applyPaoOverride(
  delta: readonly number[],
  winner: Seat,
  loser: Seat | null,
  payer: Seat
): SeatValues<number> {
  const out = mapSeatValues(delta, (value) => value);
  if (loser !== null) {
    if (loser === payer) {
      return out;
    }
    const owed = -delta[loser]; // discarder's outflow
    out[loser] = 0;
    out[payer] -= owed;
    return out;
  }
  // Tsumo: shift every non-winner's negative share to the payer.
  for (let s = 0; s < delta.length; s++) {
    if (s === winner || s === payer) {
      continue;
    }
    const owed = -out[s];
    if (owed === 0) {
      continue;
    }
    out[s] = 0;
    out[payer] -= owed;
  }
  return out;
}

/**
 * Buu side-effects on a successful win: legality check, chip
 * distribution, dabuken bookkeeping. On an illegal win this
 * reverts the point delta in place, applies the chip chombo
 * penalty, and returns the events the engine should emit
 * INSTEAD of the win + hand_end pair.
 *
 * Returns `{kind: "ok", ...}` when no chombo fires; the caller
 * proceeds with its normal win/hand_end emission and merges
 * the chip metadata into the `hand_end` event.
 *
 * A no-op (returns ok with a zero chip delta) when `buuMode`
 * is off.
 */
function applyBuuWinSideEffects(
  next: MatchState,
  args: {
    winner: Seat;
    delta: SeatValues<number>;
    winnerPreScore: number;
    score: ScoreResult;
    /**
     * `riichiSticks` count just before `applyWin` collected them
     * into the winner's delta. Needed in the chombo branch to
     * restore the table to its pre-win state before applying
     * the per-declarer refund — otherwise the refund loop
     * decrements from 0 and drives the count negative.
     */
    preWinRiichiSticks: number;
  }
):
  | {
      kind: "ok";
      chipDelta: ChipDelta;
      sinkingCount: 0 | 1 | 2 | 3;
      consumedDabuken: boolean;
      awardedDabuken: boolean;
    }
  | { kind: "chombo"; events: EngineEvent[] } {
  const rs = next.ruleSet;
  if (!rs.buuMode) {
    return {
      kind: "ok",
      chipDelta: seatValues(next.ruleSet.playerCount, () => 0),
      sinkingCount: 0,
      consumedDabuken: false,
      awardedDabuken: false,
    };
  }

  // Centralized check: would this win end the match? We need this
  // to apply illegal-victory rules 2 & 3 BEFORE returning a normal
  // result. We synthesize a stub `HandResult` for the helper.
  const stubResult: HandResult = {
    reason: args.score === null ? "tsumo" : "tsumo",
    winner: args.winner,
    loser: null,
    delta: args.delta,
    tenpai: null,
    abortKind: null,
    winHan: args.score.han,
    winYakuman: args.score.isYakuman,
  };
  // dealerKeeps is irrelevant for the match-end branches we care
  // about (busted / winner_threshold); pass `false`
  // so the round-limit branch only fires at all-last.
  const endDecision = shouldEndMatch(next, stubResult, false);
  const wouldEndMatch = endDecision.ended;
  const isFinalHand = isFinalHandOfMatch(next);

  const legality = checkBuuVictoryLegality({
    state: next,
    winner: args.winner,
    winnerWasSinking: args.winnerPreScore <= rs.sinkThreshold,
    wouldEndMatch,
    isFinalHand,
  });

  if (!legality.legal) {
    // Chombo: revert the point delta we just applied.
    for (let s = 0; s < next.ruleSet.playerCount; s++) {
      next.scores[s] -= args.delta[s];
    }
    // `applyWin` already collected every stick on the table
    // into the winner's delta and zeroed `riichiSticks`. The
    // score revert above gave those points back to the payers,
    // so the sticks logically belong on the table again —
    // restore the count before refunding this-hand
    // declarations below, otherwise the refund loop would
    // drive `riichiSticks` negative (declared seats are a
    // subset of `preWinRiichiSticks`, but starting from 0
    // every decrement undershoots).
    next.riichiSticks = args.preWinRiichiSticks;
    // Refund any riichi sticks declared THIS hand. Convention:
    // a chombo aborts the hand cleanly, so anyone who declared
    // riichi (including the offender) gets their bet back —
    // `ruleSet.riichiBetValue` points per declaration — and the
    // matching sticks are taken back off the table. Carried-over
    // sticks from prior unfinished hands stay on the table for
    // the next winner. The score refund is reflected in the
    // `hand_end` delta so renderers (and stored replays) show
    // the per-seat point change.
    const riichiRefundDelta: SeatValues<number> = seatValues(
      next.ruleSet.playerCount,
      () => 0
    );
    const refundValue = rs.riichiBetValue;
    for (let s = 0; s < next.ruleSet.playerCount; s++) {
      if (next.riichiDeclared[s]) {
        next.scores[s] += refundValue;
        next.riichiSticks -= 1;
        riichiRefundDelta[s] = refundValue;
      }
    }
    // Apply chip chombo penalty: `chipChomboPenalty` from the
    // offender to every other seat.
    const penalty = rs.chipChomboPenalty;
    const chipPenalty: ChipDelta = seatValues(
      next.ruleSet.playerCount,
      () => 0
    );
    if (penalty !== null && penalty > 0) {
      for (let s = 0; s < next.ruleSet.playerCount; s++) {
        if (s === args.winner) {
          chipPenalty[s] -= penalty * 3;
        } else {
          chipPenalty[s] += penalty;
        }
      }
      applyChipDelta(next.chips, chipPenalty);
    }
    // Match the standard chombo convention: cancel payments,
    // dealer keeps, honba advances by one. The only point-level
    // change is the riichi-bet refund recorded above.
    next.lastHandResult = {
      reason: "abort",
      winner: null,
      loser: null,
      delta: riichiRefundDelta,
      tenpai: null,
      abortKind: null,
      winHan: null,
      winYakuman: null,
    };
    next.phase = "hand_ended";
    return {
      kind: "chombo",
      events: [
        {
          type: "buu_chombo",
          seat: args.winner,
          reason: legality.reason!,
          chipDelta: chipPenalty,
          chips: [...next.chips] as ChipDelta,
        },
        {
          type: "hand_end",
          reason: "abort",
          delta: riichiRefundDelta,
        },
      ],
    };
  }

  // Legal: per-hand sankoro/nikoro/chinmai chip distribution and
  // dabuken bookkeeping are DISABLED for the in-house Buu rules.
  // Chips only move via the chombo penalty (handled above) or
  // the end-of-game payout computed in `match.ts#endMatch`,
  // which keys off final scores rather than per-hand sinkers.
  // `state.chips` and `state.dabuken` are therefore left untouched
  // here; the win/hand_end events carry no chip metadata, so the
  // result panel only shows the point delta mid-match.
  return {
    kind: "ok",
    chipDelta: seatValues(next.ruleSet.playerCount, () => 0),
    sinkingCount: 0,
    consumedDabuken: false,
    awardedDabuken: false,
  };
}

/**
 * Build the win event + transition phase to `hand_ended`.
 * `winner`'s hand should already be the 13-tile concealed shape (i.e.
 * for tsumo, splice out the winning draw before calling; for ron the
 * hand is already 13 tiles).
 */
function applyWin(
  next: MatchState,
  winner: Seat,
  loser: Seat | null,
  winTile: Tile,
  score: ScoreResult | McrScoreResult
): EngineEvent[] {
  if ("isWinningShape" in score) {
    if (!isQualifiedMcrScore(score)) {
      return [];
    }
    const settled = settleMcrWin({
      method: loser === null ? "self-draw" : "discard",
      winner,
      ...(loser === null ? {} : { discarder: loser }),
      totalFan: score.totalFan,
      nonFlowerFan: score.nonFlowerFan,
    });
    const delta = [...settled] as SeatValues<number>;
    applyDelta(next.scores, delta);
    const result: HandResult = {
      reason: loser === null ? "tsumo" : "ron",
      winner,
      loser,
      delta,
      tenpai: null,
      abortKind: null,
      winHan: score.totalFan,
      winYakuman: false,
    };
    next.lastHandResult = result;
    next.phase = "hand_ended";
    const legacyScore: ScoreResult = {
      isAgari: true,
      han: score.totalFan,
      fu: 0,
      ten: delta[winner],
      yaku: Object.fromEntries(
        score.fans.map((fan) => [fan.englishName, `${fan.awardedPoints} pts`])
      ),
      doraCount: 0,
      akaDoraCount: 0,
      uraDoraCount: 0,
      isYakuman: false,
      yakumanCount: 0,
      oya: [],
      ko: [],
      text: `${score.totalFan} points`,
      raw: score,
    };
    return [
      {
        type: "win",
        winner,
        loser,
        winTile,
        score: legacyScore,
        mcrScore: score,
        delta,
      },
      { type: "hand_end", reason: result.reason, delta },
    ];
  }
  return applyRiichiWin(next, winner, loser, winTile, score);
}

function applyRiichiWin(
  next: MatchState,
  winner: Seat,
  loser: Seat | null,
  winTile: Tile,
  score: ScoreResult
): EngineEvent[] {
  let delta = distributePayments({
    playerCount: next.ruleSet.playerCount,
    score,
    winner,
    dealer: next.dealer,
    loser,
  });
  // Pao (sekinin barai): if the winner agaris with a yakuman that
  // a pao-feeder is responsible for, the feeder pays the entire
  // amount. For tsumo, pao redirects all three non-winners' shares
  // to the feeder. For ron, pao redirects the discarder's share to
  // the feeder (or, if the discarder *is* the feeder, no change).
  // Multi-yakuman with multiple pao seats: the lib reports a
  // single bundled `oya/ko` payout; we redirect to the union — if
  // both daisangen and daisuushii are responsible, the daisangen
  // payer takes the bill (arbitrary deterministic choice; this
  // overlap only happens in pathological yakuman stackings).
  const paoPayer = paoPayerFor(next, winner, score);
  if (paoPayer !== null && paoPayer !== winner) {
    delta = applyPaoOverride(delta, winner, loser, paoPayer);
  }
  // Honba bonus: ron → 300/honba from discarder; tsumo → 100/honba
  // from each non-winner. Goes entirely to the winner. Gated by
  // `ruleSet.honbaPayments` (Buu has no repeat-counter bonus).
  if (next.honba > 0 && next.ruleSet.honbaPayments) {
    if (loser !== null) {
      const bonus = next.honba * 300;
      delta[loser] -= bonus;
      delta[winner] += bonus;
    } else {
      const bonusPer = next.honba * 100;
      for (let s = 0; s < next.ruleSet.playerCount; s++) {
        if (s === winner) {
          continue;
        }
        delta[s] -= bonusPer;
        delta[winner] += bonusPer;
      }
    }
  }
  // Carry over riichi sticks to the winner; reset. Stick value
  // is `ruleSet.riichiBetValue` (1000 standard, 100 Buu).
  // A declaration discard won by ron never established riichi:
  // exclude that pending stick from the award and refund its
  // already-applied deduction through the result delta.
  const rejectedRiichiSeat =
    loser !== null && next.pendingRiichiSeat === loser ? loser : null;
  // Snapshot the pre-collection count so the Buu chombo path
  // can restore sticks to the table when the win is invalidated
  // (otherwise the refund loop in `applyBuuWinSideEffects`
  // double-debits and drives `riichiSticks` negative, which
  // crashes the next `hand_end`/`hand_start` schema validation).
  const preWinRiichiSticks = next.riichiSticks;
  const awardedRiichiSticks =
    preWinRiichiSticks - (rejectedRiichiSeat === null ? 0 : 1);
  delta[winner] += awardedRiichiSticks * next.ruleSet.riichiBetValue;
  if (rejectedRiichiSeat !== null) {
    delta[rejectedRiichiSeat] += next.ruleSet.riichiBetValue;
  }
  next.riichiSticks = 0;
  // Snapshot winner's pre-win sinking status for Buu legality.
  const winnerPreScore = next.scores[winner];
  applyDelta(next.scores, delta);
  // Buu victory-legality + chip distribution. On illegal wins
  // (chombo) the point delta is reverted, a chip penalty is
  // applied, and the dealer keeps + honba advances — the hand is
  // effectively replayed. See `buu.ts`.
  const buuOutcome = applyBuuWinSideEffects(next, {
    winner,
    delta,
    winnerPreScore,
    score,
    preWinRiichiSticks,
  });
  if (buuOutcome.kind === "chombo") {
    next.pendingRiichiSeat = null;
    // Emit the would-be `win` event first so the client renders
    // the win-info panel (yaku / han / fu / winning hand) for its
    // normal display duration before the `buu_chombo` event
    // switches the panel over to the chombo screen. The server
    // inserts the inter-screen delay between these two events
    // (see `emitEngineEvent` in `game-server/src/match.ts`).
    return [
      { type: "win", winner, loser, winTile, score, delta },
      ...buuOutcome.events,
    ];
  }
  if (rejectedRiichiSeat !== null) {
    rejectPendingRiichi(next, rejectedRiichiSeat);
  } else {
    next.pendingRiichiSeat = null;
  }
  const result: HandResult = {
    reason: loser === null ? "tsumo" : "ron",
    winner,
    loser,
    delta,
    tenpai: null,
    abortKind: null,
    winHan: score.han,
    winYakuman: score.isYakuman,
  };
  next.lastHandResult = result;
  next.phase = "hand_ended";
  const handEndEvent: EngineEvent = {
    type: "hand_end",
    reason: result.reason,
    delta,
    ...(buuOutcome.kind === "ok" && next.ruleSet.buuMode
      ? {
          chipDelta: buuOutcome.chipDelta,
          sinkingCount: buuOutcome.sinkingCount,
          dabukenConsumed: buuOutcome.consumedDabuken,
          dabukenAwarded: buuOutcome.awardedDabuken,
        }
      : {}),
  };
  return [{ type: "win", winner, loser, winTile, score, delta }, handEndEvent];
}

/**
 * Apply a double / triple ron: each winner is scored independently
 * and paid by the discarder; per-seat deltas sum into one combined
 * delta. The head bumper (the first seat in `winners`) collects all
 * outstanding riichi sticks. `lastHandResult.winner` records the
 * head bumper so the rotation rules below see a single winning seat;
 * if any winner is the dealer, the dealer keeps + honba advances
 * (handled in `start_next_hand`).
 */
function applyMultiRon(
  next: MatchState,
  winners: Seat[],
  loser: Seat,
  winTile: Tile,
  scores: ScoreResult[]
): EngineEvent[] {
  const combined: SeatValues<number> = seatValues(
    next.ruleSet.playerCount,
    () => 0
  );
  const events: EngineEvent[] = [];
  for (let i = 0; i < winners.length; i++) {
    const w = winners[i];
    const score = scores[i];
    let d = distributePayments({
      playerCount: next.ruleSet.playerCount,
      score,
      winner: w,
      dealer: next.dealer,
      loser,
    });
    // Per-winner pao: redirect this winner's discarder payment to
    // their own pao feeder if they agari with a pao yakuman.
    const paoPayer = paoPayerFor(next, w, score);
    if (paoPayer !== null && paoPayer !== w) {
      d = applyPaoOverride(d, w, loser, paoPayer);
    }
    for (let s = 0; s < next.ruleSet.playerCount; s++) {
      combined[s] += d[s];
    }
    events.push({ type: "win", winner: w, loser, winTile, score, delta: d });
  }
  // Honba bonus on multi-ron: only the head bumper collects, paid in
  // full by the discarder (Tenhou / standard ruling). Gated by
  // `ruleSet.honbaPayments`.
  if (next.honba > 0 && next.ruleSet.honbaPayments) {
    const bonus = next.honba * 300;
    combined[loser] -= bonus;
    combined[winners[0]] += bonus;
  }
  // Riichi sticks all go to the head bumper, except a pending
  // declaration stick from the winning discard itself.
  const rejectedRiichiSeat = next.pendingRiichiSeat === loser ? loser : null;
  const awardedRiichiSticks =
    next.riichiSticks - (rejectedRiichiSeat === null ? 0 : 1);
  combined[winners[0]] += awardedRiichiSticks * next.ruleSet.riichiBetValue;
  if (rejectedRiichiSeat !== null) {
    combined[rejectedRiichiSeat] += next.ruleSet.riichiBetValue;
  }
  next.riichiSticks = 0;
  applyDelta(next.scores, combined);
  if (rejectedRiichiSeat !== null) {
    rejectPendingRiichi(next, rejectedRiichiSeat);
  } else {
    next.pendingRiichiSeat = null;
  }
  // Pick the dealer-favoring winner so the rotation logic in
  // `start_next_hand` correctly keeps the dealer when they're among
  // the winners.
  const headIfDealer = winners.find((w) => w === next.dealer);
  const recordedWinner = headIfDealer ?? winners[0];
  const result: HandResult = {
    reason: "ron",
    winner: recordedWinner,
    loser,
    delta: combined,
    tenpai: null,
    abortKind: null,
    winHan: scores.reduce((m, s) => Math.max(m, s.han), 0),
    winYakuman: scores.some((s) => s.isYakuman),
  };
  next.lastHandResult = result;
  next.phase = "hand_ended";
  events.push({ type: "hand_end", reason: "ron", delta: combined });
  return events;
}

/**
 * Tenpai-payment distribution at an exhaustive draw.
 *   0 or 4 tenpai → no payments.
 *   k tenpai (1–3): the noten side pays a total of 3000,
 *   split equally between the noten seats; the tenpai side
 *   receives that 3000 split equally between the tenpai seats.
 */
function tenpaiPaymentDelta(tenpai: readonly boolean[]): SeatValues<number> {
  const delta: SeatValues<number> = seatValues(
    participantCount(tenpai),
    () => 0
  );
  const tenpaiSeats: Seat[] = [];
  const notenSeats: Seat[] = [];
  for (let s = 0; s < participantCount(tenpai); s++) {
    if (tenpai[s]) {
      tenpaiSeats.push(s as Seat);
    } else {
      notenSeats.push(s as Seat);
    }
  }
  if (tenpaiSeats.length === 0 || notenSeats.length === 0) {
    return delta;
  }
  const perNotenPay = -3000 / notenSeats.length;
  const perTenpaiGain = 3000 / tenpaiSeats.length;
  for (const s of notenSeats) {
    delta[s] = perNotenPay;
  }
  for (const s of tenpaiSeats) {
    delta[s] = perTenpaiGain;
  }
  return delta;
}

/**
 * Nagashi mangan payment distribution. Each qualifying seat is
 * paid as if they tsumo'd a mangan: dealer-winner is paid 4000
 * by each non-dealer (12000 total); non-dealer-winner is paid
 * 4000 by the dealer + 2000 by each other non-dealer (8000
 * total). Multiple winners stack independently. Stacks on top of
 * the regular tenpai-payment computation.
 */
function nagashiPaymentDelta(
  nagashi: readonly boolean[],
  dealer: Seat
): SeatValues<number> {
  const delta: SeatValues<number> = seatValues(
    participantCount(nagashi),
    () => 0
  );
  for (let s = 0; s < participantCount(nagashi); s++) {
    if (!nagashi[s]) {
      continue;
    }
    const winner = s as Seat;
    if (winner === dealer) {
      // Dealer nagashi: each of the three non-dealers pays 4000.
      for (let p = 0; p < participantCount(nagashi); p++) {
        if (p === winner) {
          continue;
        }
        delta[p] -= 4000;
        delta[winner] += 4000;
      }
    } else {
      // Non-dealer nagashi: dealer pays 4000, other non-dealers 2000.
      for (let p = 0; p < participantCount(nagashi); p++) {
        if (p === winner) {
          continue;
        }
        const owed = p === dealer ? 4000 : 2000;
        delta[p] -= owed;
        delta[winner] += owed;
      }
    }
  }
  return delta;
}

type BooleanSeatValues = SeatValues<boolean>;

function computeRyuukyokuStatus(state: MatchState): {
  actualTenpai: BooleanSeatValues;
  nagashi: BooleanSeatValues;
} {
  const isTenpai = (seat: Seat): boolean =>
    state.riichiDeclared[seat] ||
    waitsForRules(state.hands[seat], state.melds[seat].length, state.ruleSet)
      .length > 0;
  const actualTenpai = seatValues(state.ruleSet.playerCount, isTenpai);
  const nagashi = seatValues(state.ruleSet.playerCount, () => false);
  if (state.ruleSet.nagashiMangan) {
    for (let seat = 0; seat < state.ruleSet.playerCount; seat++) {
      const discards = state.discards[seat];
      if (discards.length === 0 || !discards.every(isTerminalOrHonor)) {
        continue;
      }
      let wasCalled = false;
      for (let other = 0; other < state.ruleSet.playerCount; other++) {
        if (other === seat) {
          continue;
        }
        for (const meld of state.melds[other]) {
          if (meld.from === seat) {
            wasCalled = true;
            break;
          }
        }
        if (wasCalled) {
          break;
        }
      }
      if (!wasCalled) {
        nagashi[seat] = true;
      }
    }
  }
  return { actualTenpai, nagashi };
}

function settleRyuukyoku(
  next: MatchState,
  tenpai: BooleanSeatValues,
  nagashi: BooleanSeatValues
): StepResult {
  const tenpaiDelta: SeatValues<number> = next.ruleSet.tenpaiPayments
    ? tenpaiPaymentDelta(tenpai)
    : seatValues(next.ruleSet.playerCount, () => 0);
  const nagashiDelta = nagashiPaymentDelta(nagashi, next.dealer);
  const delta = mapSeatValues(
    tenpaiDelta,
    (value, seat) => value + nagashiDelta[seat]
  );
  applyDelta(next.scores, delta);
  next.pendingRyuukyoku = null;
  next.phase = "hand_ended";
  const anyNagashi = nagashi.some((qualifies) => qualifies);
  next.lastHandResult = {
    reason: "exhaustive_draw",
    winner: null,
    loser: null,
    delta,
    tenpai,
    abortKind: null,
    nagashi: anyNagashi ? nagashi : null,
    winHan: null,
    winYakuman: null,
  };
  return {
    state: next,
    events: [{ type: "hand_end", reason: "exhaustive_draw", delta }],
  };
}

/** Shared entry for ordinary wall exhaustion and mandatory Duplicate nuki. */
function beginRyuukyoku(next: MatchState): StepResult {
  const { actualTenpai, nagashi } = computeRyuukyokuStatus(next);
  const statusAffectsOutcome =
    next.ruleSet.tenpaiPayments ||
    next.ruleSet.tenpaiRenchan ||
    (next.ruleSet.tenpaiYame && isFinalHandOfMatch(next));
  if (statusAffectsOutcome) {
    next.pendingRyuukyoku = {
      actualTenpai,
      declarations: seatValues(next.ruleSet.playerCount, () => null),
      nagashi,
    };
    next.turn = next.dealer;
    next.phase = "awaiting_ryuukyoku_declarations";
    return { state: next, events: [] };
  }
  return settleRyuukyoku(next, actualTenpai, nagashi);
}

/**
 * Snapshot per-seat furiten status using the same predicate the
 * engine uses to gate ron — so the indicator the client renders is
 * always consistent with the engine's "can this seat ron?" answer.
 */
function computeFuritenAll(state: MatchState): SeatValues<boolean> {
  return seatValues(state.ruleSet.playerCount, (seat) =>
    isFuritenForRon(state, seat)
  );
}

function resolveDiscardSelection(
  state: MatchState,
  seat: Seat,
  tile: Tile,
  source: DiscardSource | undefined
): { index: number; tsumogiri: boolean } | null {
  const hand = state.hands[seat];
  const drawn = state.lastDrawn[seat];
  const drawnIndex = drawn === null ? -1 : hand.length - 1;

  if (source === "draw") {
    return drawn === tile && hand[drawnIndex] === tile
      ? { index: drawnIndex, tsumogiri: true }
      : null;
  }
  if (source === "hand") {
    const lastHandIndex = drawnIndex >= 0 ? drawnIndex - 1 : hand.length - 1;
    for (let index = lastHandIndex; index >= 0; index--) {
      if (hand[index] === tile) {
        return { index, tsumogiri: false };
      }
    }
    return null;
  }

  const index = hand.lastIndexOf(tile);
  return index >= 0 ? { index, tsumogiri: drawn === tile } : null;
}

export function step(state: MatchState, action: Action): StepResult {
  if (
    "seat" in action &&
    !isActiveSeat(action.seat, state.ruleSet.playerCount)
  ) {
    return noop(state);
  }
  const before = computeFuritenAll(state);
  const result = stepInternal(state, action);
  if (result.events.length === 0) {
    return result;
  }
  const after = computeFuritenAll(result.state);
  const changes: FuritenChange[] = [];
  for (let s = 0; s < state.ruleSet.playerCount; s++) {
    if (before[s] !== after[s]) {
      changes.push({ seat: s as Seat, active: after[s] });
    }
  }
  if (changes.length > 0) {
    result.furitenChanges = changes;
  }
  return result;
}

function stepInternal(state: MatchState, action: Action): StepResult {
  if (state.phase === "match_ended") {
    return noop(state);
  }
  if (state.pendingNuki != null && state.pendingShouminkan != null) {
    return noop(state);
  }
  if (
    state.phase === "awaiting_nuki_replacement" &&
    action.type !== "complete_nuki"
  ) {
    return noop(state);
  }
  if (
    state.phase === "awaiting_flower_replacement" &&
    action.type !== "complete_flower"
  ) {
    return noop(state);
  }
  const mandatoryNuki =
    state.ruleSet.playerCount === 3 && state.ruleSet.sanmaType === "kansai";
  if (
    mandatoryNuki &&
    state.phase === "awaiting_discard" &&
    state.hands[state.turn].some((tile) => isNukiTile(tile, state.ruleSet)) &&
    action.type !== "nuki"
  ) {
    return noop(state);
  }

  // ----- Exhaustive-draw declarations -----------------------------------
  if (action.type === "declare_ryuukyoku_status") {
    const pending = state.pendingRyuukyoku;
    if (
      state.phase !== "awaiting_ryuukyoku_declarations" ||
      pending === null ||
      action.seat !== state.turn ||
      pending.declarations[action.seat] !== null ||
      (action.tenpai && !pending.actualTenpai[action.seat]) ||
      (!action.tenpai && state.riichiDeclared[action.seat])
    ) {
      return noop(state);
    }
    const next = clone(state);
    const nextPending = next.pendingRyuukyoku;
    if (nextPending === null) {
      return noop(state);
    }
    nextPending.declarations[action.seat] = action.tenpai;
    if (nextPending.declarations.every((value) => value !== null)) {
      next.phase = "awaiting_ryuukyoku_settlement";
    } else {
      next.turn = nextSeat(action.seat, state.ruleSet.playerCount);
    }
    return {
      state: next,
      events: [
        {
          type: "ryuukyoku_declaration",
          seat: action.seat,
          tenpai: action.tenpai,
        },
      ],
    };
  }

  if (action.type === "complete_ryuukyoku") {
    const pending = state.pendingRyuukyoku;
    if (
      state.phase !== "awaiting_ryuukyoku_settlement" ||
      pending === null ||
      pending.declarations.some((value) => value === null)
    ) {
      return noop(state);
    }
    const tenpai = mapSeatValues(
      pending.declarations,
      (value) => value === true
    );
    const nagashi = mapSeatValues(pending.nagashi, (value) => value);
    return settleRyuukyoku(clone(state), tenpai, nagashi);
  }

  // ----- Nuki declaration / mandatory extraction ------------------------
  if (action.type === "nuki") {
    if (!canDeclareNuki(state, action)) {
      return noop(state);
    }
    const next = clone(state);
    next.hands[action.seat].splice(
      next.hands[action.seat].lastIndexOf(action.tile),
      1
    );
    next.lastDrawn[action.seat] = null;
    next.lastDrawFromDeadWall = false;
    next.lastDrawFromKong = false;
    closeDiscardWindow(next);
    next.pendingNuki = {
      seat: action.seat,
      tile: action.tile,
      opening: action.opening === true,
    };
    if (mandatoryNuki) {
      next.nukiTiles[action.seat].push(action.tile);
      next.phase = "awaiting_nuki_replacement";
    } else {
      next.ippatsuEligible = seatValues(state.ruleSet.playerCount, () => false);
      next.phase = "awaiting_chankan";
    }
    return {
      state: next,
      events: [
        {
          type: "nuki",
          seat: action.seat,
          tile: action.tile,
          stage: mandatoryNuki ? "completed" : "declared",
        },
      ],
    };
  }

  if (action.type === "complete_nuki") {
    const pending = state.pendingNuki;
    if (
      pending == null ||
      !isActiveSeat(pending.seat, state.ruleSet.playerCount) ||
      !isNukiTile(pending.tile, state.ruleSet) ||
      state.pendingRyuukyoku !== null ||
      (!pending.opening && state.turn !== pending.seat) ||
      (mandatoryNuki
        ? state.phase !== "awaiting_nuki_replacement"
        : getPendingRobbery(state)?.kind !== "nuki")
    ) {
      return noop(state);
    }
    const duplicate = state.sanmaWall?.mode === "duplicate";
    if (
      action.forceExhaustive === true &&
      (!mandatoryNuki || !duplicate || action.replacementTile !== undefined)
    ) {
      return noop(state);
    }
    const next = clone(state);
    if (
      mandatoryNuki &&
      duplicate &&
      (action.forceExhaustive === true ||
        (action.replacementTile === undefined && state.liveWall.length === 0))
    ) {
      next.pendingNuki = null;
      next.lastDrawn[pending.seat] = null;
      next.lastDrawFromDeadWall = false;
      next.lastDrawFromKong = false;
      return beginRyuukyoku(next);
    }
    const replacement = drawRinshan(next, action.replacementTile, "nuki");
    if (replacement === undefined) {
      return noop(state);
    }
    const events: EngineEvent[] = [];
    if (!mandatoryNuki) {
      lockMissedRonFuriten(next, pending.tile, pending.seat, true);
      next.nukiTiles[pending.seat].push(pending.tile);
      events.push({
        type: "nuki",
        seat: pending.seat,
        tile: pending.tile,
        stage: "completed",
      });
    }
    next.pendingNuki = null;
    next.hands[pending.seat].push(replacement.tile);
    next.lastDrawn[pending.seat] = pending.opening ? null : replacement.tile;
    next.lastDrawFromDeadWall = !pending.opening;
    next.lastDrawFromKong = false;
    next.phase = pending.opening ? "awaiting_draw" : "awaiting_discard";
    events.push({
      type: "draw",
      seat: pending.seat,
      tile: replacement.tile,
      wallRemaining: next.liveWall.length,
      fromDeadWall: !replacement.fixedDeadWall,
      replacementKind: "nuki",
      ...(pending.opening ? { opening: true } : {}),
    });
    return { state: next, events };
  }

  if (action.type === "complete_flower") {
    const pending = state.pendingFlower;
    if (
      state.ruleSet.rulesFamily !== "mcr" ||
      state.phase !== "awaiting_flower_replacement" ||
      pending === null ||
      state.turn !== pending.seat
    ) {
      return noop(state);
    }
    const next = clone(state);
    const hand = next.hands[pending.seat];
    const flowerIndex = hand.lastIndexOf(pending.tile);
    if (flowerIndex < 0) {
      return noop(state);
    }
    hand.splice(flowerIndex, 1);
    next.pendingFlower = null;

    if (action.forceExhaustive === true) {
      next.discards[pending.seat].push(pending.tile);
      next.lastDrawn[pending.seat] = null;
      next.lastDrawFromDeadWall = false;
      next.lastDrawFromKong = false;
      const settled = beginRyuukyoku(next);
      return {
        state: settled.state,
        events: [
          {
            type: "discard",
            seat: pending.seat,
            tile: pending.tile,
            tsumogiri: true,
            discardSource: "draw",
          },
          ...settled.events,
        ],
      };
    }

    let replacement: Tile | undefined;
    if (action.replacementTile !== undefined) {
      const replacementIndex = next.liveWall.lastIndexOf(
        action.replacementTile
      );
      if (replacementIndex < 0) {
        return noop(state);
      }
      [replacement] = next.liveWall.splice(replacementIndex, 1);
    } else {
      replacement = next.liveWall.pop();
    }
    if (replacement === undefined) {
      return noop(state);
    }

    next.flowerTiles[pending.seat].push(pending.tile);
    next.hands[pending.seat].push(replacement);
    next.lastDrawFromDeadWall = true;
    const events: EngineEvent[] = [
      { type: "flower", seat: pending.seat, tile: pending.tile },
      {
        type: "draw",
        seat: pending.seat,
        tile: replacement,
        wallRemaining: next.liveWall.length,
        fromDeadWall: false,
        replacementKind: "flower",
      },
    ];
    if (replacement.endsWith("f")) {
      next.pendingFlower = { seat: pending.seat, tile: replacement };
      next.lastDrawn[pending.seat] = null;
      next.phase = "awaiting_flower_replacement";
    } else {
      next.lastDrawn[pending.seat] = replacement;
      next.phase = "awaiting_discard";
    }
    return { state: next, events };
  }

  // ----- Draw ------------------------------------------------------------
  if (action.type === "draw") {
    if (state.phase !== "awaiting_draw" || action.seat !== state.turn) {
      return noop(state);
    }
    if (state.liveWall.length === 0 || action.forceExhaustive === true) {
      return beginRyuukyoku(clone(state));
    }
    const next = clone(state);
    if (
      next.pendingRiichiSeat !== null &&
      next.ruleSet.aborts.suuchaRiichi &&
      next.riichiDeclared.every((declared) => declared)
    ) {
      closeDiscardWindow(next);
      return {
        state: next,
        events: endAbort(next, "suucha_riichi"),
      };
    }
    if (state.lastDiscard !== null) {
      // Compute missed-ron furiten BEFORE drawing — scoreHand
      // expects a 13-tile hand for ron evaluation.
      lockMissedRonFuriten(
        next,
        state.lastDiscard.tile,
        state.lastDiscard.seat
      );
    }
    let tile: Tile;
    if (action.tile !== undefined) {
      const suppliedIndex = next.liveWall.indexOf(action.tile);
      if (suppliedIndex < 0) {
        return noop(state);
      }
      [tile] = next.liveWall.splice(suppliedIndex, 1);
    } else {
      tile = next.liveWall.shift() as Tile;
    }
    next.hands[next.turn].push(tile);
    closeDiscardWindow(next);
    if (next.ruleSet.rulesFamily === "mcr" && tile.endsWith("f")) {
      next.pendingFlower = { seat: next.turn, tile };
      next.lastDrawn[next.turn] = null;
      next.lastDrawFromDeadWall = false;
      next.lastDrawFromKong = false;
      next.phase = "awaiting_flower_replacement";
    } else {
      next.lastDrawn[next.turn] = tile;
      next.lastDrawFromDeadWall = false;
      next.lastDrawFromKong = false;
      next.phase = "awaiting_discard";
    }
    return {
      state: next,
      events: [
        {
          type: "draw",
          seat: next.turn,
          tile,
          wallRemaining: next.liveWall.length,
        },
      ],
    };
  }

  // ----- Discard ---------------------------------------------------------
  if (action.type === "discard") {
    if (state.phase !== "awaiting_discard" || action.seat !== state.turn) {
      return noop(state);
    }
    if (isDiscardForbiddenByKuikae(state, action.seat, action.tile)) {
      return noop(state);
    }
    // Riichi-declared seats are locked into tsumogiri (no choice of
    // discard) on every turn after their riichi declaration.
    if (
      state.riichiDeclared[action.seat] &&
      (action.tile !== state.lastDrawn[action.seat] ||
        action.discardSource === "hand")
    ) {
      return noop(state);
    }
    const selection = resolveDiscardSelection(
      state,
      action.seat,
      action.tile,
      action.discardSource
    );
    if (selection === null) {
      return noop(state);
    }
    const next = clone(state);
    next.hands[action.seat].splice(selection.index, 1);
    next.discards[action.seat].push(action.tile);
    next.lastDrawn[action.seat] = null;
    next.lastDiscard = { seat: action.seat, tile: action.tile };
    // Temporary furiten lock clears on the seat's own next discard.
    // Riichi (permanent) lock stays — but riichi seats are
    // tsumogiri-only so the lock is durable in practice either way.
    if (next.furitenTemp[action.seat]) {
      next.furitenTemp[action.seat] = false;
    }
    // Ippatsu lapses on the declarer's next discard. (Calls would
    // clear everyone's ippatsu in 5c; for now this is the only
    // path that clears it without a win.)
    if (next.ippatsuEligible[action.seat]) {
      next.ippatsuEligible[action.seat] = false;
    }
    next.turn = ((action.seat + 1) % state.ruleSet.playerCount) as Seat;
    next.phase = "awaiting_draw";
    const discardEvent: EngineEvent = {
      type: "discard",
      seat: action.seat,
      tile: action.tile,
      tsumogiri: selection.tsumogiri,
      discardSource: selection.tsumogiri ? "draw" : "hand",
    };
    const events: EngineEvent[] = [discardEvent];
    // Deferred kan-dora reveals (from earlier kans this hand under
    // `instantlyRevealDoraFor{Minkan,Ankan} = false`) become visible
    // alongside the discard event so any ron on this discard is
    // scored with the new dora active.
    drainPendingKanDora(next, events);
    // Suufon renda: aborts the hand if all four seats' very first
    // discards are the same wind tile (1z–4z) and no calls have
    // been made. Triggered by the 4th seat's first discard.
    if (next.ruleSet.aborts.suufonRenda) {
      const allFirstDiscards =
        next.discards.every((d) => d.length === 1) &&
        next.melds.every((m) => m.length === 0) &&
        !hasNukiInterruption(next);
      if (allFirstDiscards) {
        const first = next.discards[0][0];
        const isWind =
          first === "1z" || first === "2z" || first === "3z" || first === "4z";
        const allSame = isWind && next.discards.every((d) => d[0] === first);
        if (allSame) {
          const abortEvents = endAbort(next, "suufon_renda");
          events.push(...abortEvents);
          return { state: next, events };
        }
      }
    }
    return {
      state: next,
      events,
    };
  }

  // ----- Riichi ----------------------------------------------------------
  if (action.type === "riichi") {
    if (state.ruleSet.rulesFamily !== "riichi") {
      return noop(state);
    }
    if (state.phase !== "awaiting_discard" || action.seat !== state.turn) {
      return noop(state);
    }
    if (state.riichiDeclared[action.seat]) {
      return noop(state);
    }
    if (
      state.ruleSet.bustedScore !== null &&
      state.scores[action.seat] < state.ruleSet.riichiBetValue
    ) {
      return noop(state);
    }
    // Concealed-hand rule: any open meld (chi / pon / daiminkan /
    // shouminkan) disqualifies riichi. Ankan is concealed and OK.
    for (const m of state.melds[action.seat]) {
      if (m.type !== "ankan") {
        return noop(state);
      }
    }
    // Standard rule: ≥4 tiles in the live wall (so all seats can take
    // at least one more turn).
    if (state.liveWall.length < state.ruleSet.playerCount) {
      return noop(state);
    }
    const selection = resolveDiscardSelection(
      state,
      action.seat,
      action.tile,
      action.discardSource
    );
    if (selection === null) {
      return noop(state);
    }
    // Tenpai check on the 13-tile hand left after discarding.
    // `waits(hand)` returns `[]` when no tile completes the hand
    // (including the kara-ten case where all four wait copies are
    // already in the seat's own hand), so the declaration is
    // rejected in that case. `meldCount` adjusts the target for
    // any concealed kans already declared (ankan during prior
    // turns / earlier this turn via rinshan).
    const after = [...state.hands[action.seat]];
    after.splice(selection.index, 1);
    if (
      waitsForRules(after, state.melds[action.seat].length, state.ruleSet)
        .length === 0
    ) {
      return noop(state);
    }
    const next = clone(state);
    next.hands[action.seat].splice(selection.index, 1);
    next.discards[action.seat].push(action.tile);
    next.lastDrawn[action.seat] = null;
    next.lastDiscard = { seat: action.seat, tile: action.tile };
    // Tentatively pay the riichi stick to the table. It remains
    // pending until this discard's ron window closes; a ron on
    // the declaration tile rejects riichi and refunds the bet.
    // Stick value is `ruleSet.riichiBetValue` (1000 standard, 100 Buu).
    next.scores[action.seat] -= next.ruleSet.riichiBetValue;
    next.riichiSticks += 1;
    next.riichiDeclared[action.seat] = true;
    next.pendingRiichiSeat = action.seat;
    if (next.ruleSet.ippatsu) {
      next.ippatsuEligible[action.seat] = true;
    }
    // Double riichi: this seat hasn't discarded yet (so this is
    // their first turn of the hand) and no call of any kind
    // (chi / pon / kan / ankan — all of which add a meld) has
    // interrupted the natural turn order.
    if (next.ruleSet.doubleRiichi) {
      const seatHasNotDiscarded = state.discards[action.seat].length === 0;
      const noCallsYet =
        state.melds.every((m) => m.length === 0) && !hasNukiInterruption(state);
      if (seatHasNotDiscarded && noCallsYet) {
        next.doubleRiichi[action.seat] = true;
      }
    }
    next.turn = ((action.seat + 1) % state.ruleSet.playerCount) as Seat;
    next.phase = "awaiting_draw";
    const discardEvent: EngineEvent = {
      type: "discard",
      seat: action.seat,
      tile: action.tile,
      tsumogiri: selection.tsumogiri,
      discardSource: selection.tsumogiri ? "draw" : "hand",
      riichi: true,
    };
    const events: EngineEvent[] = [discardEvent];
    // Deferred kan-dora reveals drain on this discard too (riichi
    // declarations are themselves a discard — same scoring
    // semantics for any ron on the riichi tile).
    drainPendingKanDora(next, events);
    return {
      state: next,
      events,
    };
  }

  // ----- Tsumo -----------------------------------------------------------
  if (action.type === "tsumo") {
    if (state.phase !== "awaiting_discard" || action.seat !== state.turn) {
      return noop(state);
    }
    const winTile = state.lastDrawn[action.seat];
    if (winTile === null) {
      return noop(state);
    }
    if (state.ruleSet.rulesFamily === "mcr") {
      const score = scoreMcrForState(state, action.seat, winTile, "self-draw", {
        replacementTile: state.lastDrawFromKong,
      });
      if (!isQualifiedMcrScore(score)) {
        return noop(state);
      }
      const next = clone(state);
      const events = applyWin(next, action.seat, null, winTile, score);
      return { state: next, events };
    }
    // Build 13-tile concealed hand by removing the winning tile.
    const fullHand = state.hands[action.seat];
    const winIdx = fullHand.lastIndexOf(winTile);
    if (winIdx < 0) {
      return noop(state);
    }
    const handBeforeWin: Tile[] = [...fullHand];
    handBeforeWin.splice(winIdx, 1);
    // Fast shape gate: bail before the expensive scoreHand call when
    // the hand isn't a winning shape (the tsumo legal-action probe
    // hits this on every human turn).
    if (!isWinningShape(handBeforeWin, state.melds[action.seat], winTile)) {
      return noop(state);
    }
    const score = scoreHand({
      ...handScoringContext(state, action.seat),
      hand: handBeforeWin,
      winTile,
      tsumo: true,
      blessingOfHeavenOrEarth: isFirstUninterruptedGoAround(state, action.seat),
      // Haitei raoyue: tsumo on the very last live-wall tile.
      // Exclude rinshan draws (those score rinshan kaihou via
      // `rinshanOrChankan` instead) — the two collide when the
      // wall is already empty at kan time.
      haiteiOrHoutei:
        state.liveWall.length === 0 && !state.lastDrawFromDeadWall,
      // Rinshan follows kan/nuki replacement cause, including Duplicate.
      rinshanOrChankan: state.lastDrawFromDeadWall,
    });
    // Reject no-yaku wins. The riichi lib zeroes `han` when the
    // hand has no scoring yaku (dora alone never qualifies), but
    // still flags `isAgari: true` for the winning shape — so a
    // shape-only check would let an open-tsumo with only dora
    // through. Yakuman wins are always accepted via `yakumanCount`.
    if (!score.isAgari || (score.han === 0 && score.yakumanCount === 0)) {
      return noop(state);
    }
    const next = clone(state);
    const events = applyWin(next, action.seat, null, winTile, score);
    return { state: next, events };
  }

  // ----- Ron -------------------------------------------------------------
  if (action.type === "ron") {
    // Ron is legal in two situations:
    //   1. `awaiting_draw` with a fresh discard on the table.
    //   2. `awaiting_chankan` — added-kan or Online North robbery.
    let discarder: Seat;
    let winTile: Tile;
    let isChankan = false;
    if (state.phase === "awaiting_chankan") {
      const pending = getPendingRobbery(state);
      if (pending === null) {
        return noop(state);
      }
      discarder = pending.seat;
      winTile = pending.tile;
      isChankan = true;
    } else if (state.phase === "awaiting_draw" && state.lastDiscard !== null) {
      discarder = state.lastDiscard.seat;
      winTile = state.lastDiscard.tile;
    } else {
      return noop(state);
    }
    if (mandatoryNuki && isNukiTile(winTile, state.ruleSet)) {
      return noop(state);
    }
    // Build the full winners list (head bumper + additional). Reject
    // duplicates, the discarder, and out-of-range seats.
    const seen = new Set<Seat>();
    const winners: Seat[] = [];
    const candidates: Seat[] = [
      action.seat,
      ...(action.additionalWinners ?? []),
    ];
    for (const w of candidates) {
      if (
        !isActiveSeat(w, state.ruleSet.playerCount) ||
        w === discarder ||
        seen.has(w)
      ) {
        return noop(state);
      }
      seen.add(w);
      winners.push(w);
    }
    if (winners.length === 0 || winners.length >= state.ruleSet.playerCount) {
      return noop(state);
    }
    if (state.ruleSet.rulesFamily === "mcr" && winners.length !== 1) {
      return noop(state);
    }
    // Reject any winner who is in furiten. (Chankan rons are exempt
    // from self-discard furiten in some rulesets, but the
    // permanent / missed-ron lock still applies. We apply both
    // checks uniformly here; chankan-specific carve-outs can ship
    // as a follow-up if needed.)
    for (const w of winners) {
      if (
        mandatoryNuki &&
        state.hands[w].some((tile) => isNukiTile(tile, state.ruleSet))
      ) {
        return noop(state);
      }
      if (isFuritenForRon(state, w)) {
        return noop(state);
      }
    }
    if (state.ruleSet.rulesFamily === "mcr") {
      const winner = winners[0];
      const score = scoreMcrForState(state, winner, winTile, "discard", {
        robbingPromotedKong: isChankan,
      });
      if (!isQualifiedMcrScore(score)) {
        return noop(state);
      }
      const next = clone(state);
      const events = applyWin(next, winner, discarder, winTile, score);
      return { state: next, events };
    }
    // Score each winner; bail if any of them is not a valid agari.
    const scores: ScoreResult[] = [];
    for (const w of winners) {
      // Fast shape gate before the expensive scoreHand call.
      if (!isWinningShape(state.hands[w], state.melds[w], winTile)) {
        return noop(state);
      }
      const score = scoreHand({
        ...handScoringContext(state, w),
        hand: state.hands[w],
        winTile,
        tsumo: false,
        // Renhou: non-dealer ron on the first uninterrupted
        // go-around. Dealer cannot renhou (they don't ron before
        // their first draw). Gated by ruleSet.
        blessingOfHeavenOrEarth:
          state.ruleSet.renhou &&
          w !== state.dealer &&
          !isChankan &&
          isFirstUninterruptedGoAround(state, w),
        rinshanOrChankan: isChankan,
        // Houtei raoyui: ron on the final discard of the hand —
        // i.e. the discarder's last draw emptied the live wall.
        // Chankan rons are excluded (they collide on the
        // `rinshanOrChankan` flag the riichi lib gates on).
        haiteiOrHoutei: !isChankan && state.liveWall.length === 0,
      });
      // Reject no-yaku wins (see tsumo branch above for context).
      if (!score.isAgari || (score.han === 0 && score.yakumanCount === 0)) {
        return noop(state);
      }
      scores.push(score);
    }
    const next = clone(state);
    const events =
      winners.length === 1
        ? applyWin(next, winners[0], discarder, winTile, scores[0])
        : applyMultiRon(next, winners, discarder, winTile, scores);
    return { state: next, events };
  }

  // ----- Chi -------------------------------------------------------------
  if (action.type === "chi") {
    if (state.ruleSet.playerCount === 3) {
      return noop(state);
    }
    if (state.phase !== "awaiting_draw" || state.lastDiscard === null) {
      return noop(state);
    }
    if (state.liveWall.length === 0) {
      return noop(state);
    }
    // Chi only legal from the seat immediately to the discarder's
    // left (i.e. the next-to-act seat under turn order).
    const expected = ((state.lastDiscard.seat + 1) %
      state.ruleSet.playerCount) as Seat;
    if (action.seat !== expected || action.seat !== state.turn) {
      return noop(state);
    }
    if (state.riichiDeclared[action.seat]) {
      return noop(state);
    }
    const claimed = state.lastDiscard.tile;
    // Chi requires a numbered suit; honors can never form a run.
    const suit = claimed[claimed.length - 1];
    if (suit === "z") {
      return noop(state);
    }
    if (action.tiles[0][1] !== suit || action.tiles[1][1] !== suit) {
      return noop(state);
    }
    const ns = [
      Number(claimed[0] === "0" ? "5" : claimed[0]),
      Number(action.tiles[0][0] === "0" ? "5" : action.tiles[0][0]),
      Number(action.tiles[1][0] === "0" ? "5" : action.tiles[1][0]),
    ].sort((a, b) => a - b);
    if (ns[1] - ns[0] !== 1 || ns[2] - ns[1] !== 1) {
      return noop(state);
    }
    // Both contributed tiles must actually be in the caller's hand.
    const handCopy = [...state.hands[action.seat]];
    for (const t of action.tiles) {
      const i = handCopy.lastIndexOf(t);
      if (i < 0) {
        return noop(state);
      }
      handCopy.splice(i, 1);
    }
    const next = clone(state);
    lockMissedRonFuriten(next, state.lastDiscard.tile, state.lastDiscard.seat);
    next.hands[action.seat] = handCopy;
    const meld: Meld = {
      type: "chi",
      tiles: [...action.tiles, claimed].sort(),
      claimedTile: claimed,
      from: state.lastDiscard.seat,
    };
    next.melds[action.seat].push(meld);
    next.discards[state.lastDiscard.seat].pop(); // remove called tile
    closeDiscardWindow(next);
    next.lastDrawn = seatValues(state.ruleSet.playerCount, () => null);
    next.ippatsuEligible = seatValues(state.ruleSet.playerCount, () => false);
    next.turn = action.seat;
    next.phase = "awaiting_discard";
    return {
      state: next,
      events: [{ type: "call", seat: action.seat, meld }],
    };
  }

  // ----- Pon -------------------------------------------------------------
  if (action.type === "pon") {
    if (state.phase !== "awaiting_draw" || state.lastDiscard === null) {
      return noop(state);
    }
    if (state.liveWall.length === 0) {
      return noop(state);
    }
    if (action.seat === state.lastDiscard.seat) {
      return noop(state);
    }
    if (state.riichiDeclared[action.seat]) {
      return noop(state);
    }
    const claimed = state.lastDiscard.tile;
    if (
      mandatoryNuki &&
      (isNukiTile(claimed, state.ruleSet) ||
        state.hands[action.seat].some((tile) =>
          isNukiTile(tile, state.ruleSet)
        ))
    ) {
      return noop(state);
    }
    // Pon matches by numeric tile value (red 5 and white 5 share).
    const claimedKey = (claimed[0] === "0" ? "5" : claimed[0]) + claimed[1];
    for (const t of action.tiles) {
      const key = (t[0] === "0" ? "5" : t[0]) + t[1];
      if (key !== claimedKey) {
        return noop(state);
      }
    }
    const handCopy = [...state.hands[action.seat]];
    for (const t of action.tiles) {
      const i = handCopy.lastIndexOf(t);
      if (i < 0) {
        return noop(state);
      }
      handCopy.splice(i, 1);
    }
    const next = clone(state);
    lockMissedRonFuriten(next, state.lastDiscard.tile, state.lastDiscard.seat);
    next.hands[action.seat] = handCopy;
    const meld: Meld = {
      type: "pon",
      tiles: [...action.tiles, claimed].sort(),
      claimedTile: claimed,
      from: state.lastDiscard.seat,
    };
    next.melds[action.seat].push(meld);
    detectPao(next, action.seat, state.lastDiscard.seat);
    next.discards[state.lastDiscard.seat].pop();
    closeDiscardWindow(next);
    next.lastDrawn = seatValues(state.ruleSet.playerCount, () => null);
    next.ippatsuEligible = seatValues(state.ruleSet.playerCount, () => false);
    next.turn = action.seat;
    next.phase = "awaiting_discard";
    return {
      state: next,
      events: [{ type: "call", seat: action.seat, meld }],
    };
  }

  // ----- Kan -------------------------------------------------------------
  if (action.type === "kan") {
    if (
      mandatoryNuki &&
      (isNukiTile(action.tile, state.ruleSet) ||
        (action.kind === "daiminkan" &&
          state.lastDiscard !== null &&
          isNukiTile(state.lastDiscard.tile, state.ruleSet)) ||
        state.hands[action.seat].some((tile) =>
          isNukiTile(tile, state.ruleSet)
        ))
    ) {
      return noop(state);
    }
    if (state.ruleSet.playerCount === 3) {
      if (state.sanmaWall?.sanmaType !== state.ruleSet.sanmaType) {
        return noop(state);
      }
      // Added-kan declarations do not consume a queue tile. The driver checks
      // that personal queue; completion must supply its actual replacement.
      const deferredQueueTile =
        action.kind === "shouminkan" &&
        state.sanmaWall.mode === "duplicate" &&
        action.replacementTile === undefined;
      const availabilityTile = deferredQueueTile
        ? state.liveWall[0]
        : action.replacementTile;
      if (!canTakeSanmaReplacement(state, "kan", availabilityTile)) {
        return noop(state);
      }
    } else if (
      state.liveWall.length === 0 ||
      (state.ruleSet.rulesFamily === "mcr" &&
        action.replacementTile === undefined &&
        state.liveWall.every((tile) => tile.endsWith("f")))
    ) {
      return noop(state);
    }
    if (action.kind === "shouminkan") {
      // Shouminkan ("added kan"): the active seat extends one of
      // their open pons with the matching tile from their hand.
      // Legal only in `awaiting_discard` (the seat must already
      // hold the 14th tile from a draw or rinshan).
      //
      // This is the *declaration* half of the shouminkan flow. It:
      //   1. Removes the upgrade tile from the caller's hand.
      //   2. Swaps the matching pon to a `shouminkan`-typed meld so
      //      the upgrade is visible to clients immediately.
      //   3. Sets `pendingShouminkan` and transitions to
      //      `awaiting_chankan`.
      //   4. Emits a `call` event for the upgraded meld.
      //
      // The orchestrator opens a chankan window after seeing the
      // event. Opponents may declare ron on the upgrade tile (see
      // the ron handler below — it consumes `pendingShouminkan` and
      // scores with `rinshanOrChankan: true`). When the window
      // closes with no rob, the orchestrator dispatches
      // `complete_shouminkan` to perform the rinshan draw and
      // reveal the post-kan dora.
      if (state.phase !== "awaiting_discard" || action.seat !== state.turn) {
        return noop(state);
      }
      if (state.riichiDeclared[action.seat]) {
        return noop(state);
      }
      // Kan is only legal immediately after a draw (live wall or
      // rinshan), never after a chi/pon. Chi/pon/daiminkan all
      // clear `lastDrawn[seat]` to null; only a `draw` or kan-
      // rinshan sets it. This gate prevents declaring shouminkan
      // on the called tile of a fresh pon (post-chi/pon there's
      // no rinshan window so the rules forbid it anyway).
      if (state.lastDrawn[action.seat] === null) {
        return noop(state);
      }
      const targetKey =
        (action.tile[0] === "0" ? "5" : action.tile[0]) + action.tile[1];
      // Find a matching open pon owned by this seat.
      const ponIdx = state.melds[action.seat].findIndex((m) => {
        if (m.type !== "pon") {
          return false;
        }
        const t = m.tiles[0];
        const k = (t[0] === "0" ? "5" : t[0]) + t[1];
        return k === targetKey;
      });
      if (ponIdx < 0) {
        return noop(state);
      }
      // Caller must hold the upgrading tile in hand.
      const handCopy = [...state.hands[action.seat]];
      const handIdx = handCopy.findIndex((t) => {
        const k = (t[0] === "0" ? "5" : t[0]) + t[1];
        return k === targetKey;
      });
      if (handIdx < 0) {
        return noop(state);
      }
      const upgraded = handCopy.splice(handIdx, 1)[0];
      const next = clone(state);
      next.hands[action.seat] = handCopy;
      const oldPon = next.melds[action.seat][ponIdx];
      const meld: Meld = {
        type: "shouminkan",
        tiles: [...oldPon.tiles, upgraded].sort(),
        claimedTile: oldPon.claimedTile,
        from: oldPon.from,
      };
      next.melds[action.seat][ponIdx] = meld;
      next.lastDrawn = seatValues(state.ruleSet.playerCount, () => null);
      next.ippatsuEligible = seatValues(state.ruleSet.playerCount, () => false);
      next.pendingShouminkan = {
        seat: action.seat,
        tile: upgraded,
        ponIdx,
      };
      next.phase = "awaiting_chankan";
      // Rinshan draw + dora reveal happen on `complete_shouminkan`,
      // after the chankan window closes without a robbing ron.
      return {
        state: next,
        events: [{ type: "call", seat: action.seat, meld }],
      };
    }
    if (action.kind === "daiminkan") {
      if (state.phase !== "awaiting_draw" || state.lastDiscard === null) {
        return noop(state);
      }
      if (action.seat === state.lastDiscard.seat) {
        return noop(state);
      }
      if (state.riichiDeclared[action.seat]) {
        return noop(state);
      }
      const claimed = state.lastDiscard.tile;
      const claimedKey = (claimed[0] === "0" ? "5" : claimed[0]) + claimed[1];
      // Caller must hold 3 matching tiles.
      const handCopy = [...state.hands[action.seat]];
      const matches: Tile[] = [];
      for (let i = handCopy.length - 1; i >= 0 && matches.length < 3; i--) {
        const key =
          (handCopy[i][0] === "0" ? "5" : handCopy[i][0]) + handCopy[i][1];
        if (key === claimedKey) {
          matches.push(handCopy[i]);
          handCopy.splice(i, 1);
        }
      }
      if (matches.length < 3) {
        return noop(state);
      }
      const next = clone(state);
      lockMissedRonFuriten(
        next,
        state.lastDiscard.tile,
        state.lastDiscard.seat
      );
      next.hands[action.seat] = handCopy;
      const meld: Meld = {
        type: "daiminkan",
        tiles: [...matches, claimed].sort(),
        claimedTile: claimed,
        from: state.lastDiscard.seat,
      };
      next.melds[action.seat].push(meld);
      detectPao(next, action.seat, state.lastDiscard.seat);
      next.discards[state.lastDiscard.seat].pop();
      closeDiscardWindow(next);
      next.lastDrawn = seatValues(state.ruleSet.playerCount, () => null);
      next.ippatsuEligible = seatValues(state.ruleSet.playerCount, () => false);
      // Rinshan draw from the front of the dead wall, then reveal a
      // new dora indicator.
      const rinshan = drawRinshan(next, action.replacementTile);
      if (rinshan === undefined) {
        return noop(state);
      }
      next.hands[action.seat].push(rinshan.tile);
      finishReplacementDraw(next, action.seat, rinshan.tile);
      const events: EngineEvent[] = [
        { type: "call", seat: action.seat, meld },
        {
          type: "draw",
          seat: action.seat,
          tile: rinshan.tile,
          wallRemaining: next.liveWall.length,
          fromDeadWall:
            state.ruleSet.rulesFamily === "riichi" &&
            (state.ruleSet.playerCount === 4 || !rinshan.fixedDeadWall),
          ...(state.ruleSet.playerCount === 3 ||
          state.ruleSet.rulesFamily === "mcr"
            ? { replacementKind: "kan" as const }
            : {}),
        },
      ];
      // New dora indicator: the dead-wall layout shifts when rinshan
      // is removed, so the dora index advances by one in the original
      // layout. Cap at 4 additional reveals. Skipped entirely when
      // `ruleSet.kanDora` is off, and deferred to the declarer's next
      // discard when `ruleSet.instantlyRevealDoraForMinkan` is off.
      captureKanDora(
        next,
        "minkan",
        events,
        rinshan.fixedDeadWall,
        rinshan.indicators
      );
      next.turn = action.seat;
      return { state: next, events };
    }
    // Ankan
    if (state.phase !== "awaiting_discard" || action.seat !== state.turn) {
      return noop(state);
    }
    // Kan is only legal immediately after a draw — see the
    // shouminkan branch above for the rationale.
    if (state.lastDrawn[action.seat] === null) {
      return noop(state);
    }
    const targetKey =
      (action.tile[0] === "0" ? "5" : action.tile[0]) + action.tile[1];
    const handCopy = [...state.hands[action.seat]];
    const matches: Tile[] = [];
    for (let i = handCopy.length - 1; i >= 0 && matches.length < 4; i--) {
      const key =
        (handCopy[i][0] === "0" ? "5" : handCopy[i][0]) + handCopy[i][1];
      if (key === targetKey) {
        matches.push(handCopy[i]);
        handCopy.splice(i, 1);
      }
    }
    if (matches.length < 4) {
      return noop(state);
    }
    // Riichi seats may only declare ankan when the kan doesn't
    // remove any winning interpretation of the tenpai hand. This
    // is strictly stronger than "the wait set is unchanged" — see
    // `riichiKan.ts` for the counterexample.
    if (state.riichiDeclared[action.seat]) {
      // Reconstruct the 13-tile pre-draw concealed hand: remove the
      // last-drawn tile (the seat's 14th) from a fresh copy of the
      // current hand. `lastDrawn` is guaranteed non-null in
      // `awaiting_discard`.
      const fullHand = [...state.hands[action.seat]];
      const drawn = state.lastDrawn[action.seat];
      if (drawn === null) {
        return noop(state);
      }
      const drawIdx = fullHand.lastIndexOf(drawn);
      if (drawIdx < 0) {
        return noop(state);
      }
      fullHand.splice(drawIdx, 1);
      if (
        !isAnkanLegalDuringRiichi(
          fullHand,
          action.tile,
          state.melds[action.seat].length
        )
      ) {
        return noop(state);
      }
    }
    const next = clone(state);
    next.hands[action.seat] = handCopy;
    const meld: Meld = {
      type: "ankan",
      tiles: [...matches].sort(),
      claimedTile: null,
      from: null,
    };
    next.melds[action.seat].push(meld);
    next.ippatsuEligible = seatValues(state.ruleSet.playerCount, () => false);
    const rinshan = drawRinshan(next, action.replacementTile);
    if (rinshan === undefined) {
      return noop(state);
    }
    next.hands[action.seat].push(rinshan.tile);
    finishReplacementDraw(next, action.seat, rinshan.tile);
    const events: EngineEvent[] = [
      { type: "call", seat: action.seat, meld },
      {
        type: "draw",
        seat: action.seat,
        tile: rinshan.tile,
        wallRemaining: next.liveWall.length,
        fromDeadWall:
          state.ruleSet.rulesFamily === "riichi" &&
          (state.ruleSet.playerCount === 4 || !rinshan.fixedDeadWall),
        ...(state.ruleSet.playerCount === 3 ||
        state.ruleSet.rulesFamily === "mcr"
          ? { replacementKind: "kan" as const }
          : {}),
      },
    ];
    captureKanDora(
      next,
      "ankan",
      events,
      rinshan.fixedDeadWall,
      rinshan.indicators
    );
    // Phase stays awaiting_discard — the seat now holds 14-3*melds
    // tiles and must discard (or declare another kan / tsumo).
    return { state: next, events };
  }

  // ----- Abort (kyuushuu kyuuhai / sanchahou) ----------------------------
  if (action.type === "abort") {
    if (action.kind === "sanchahou") {
      if (!state.ruleSet.aborts.sanchahou) {
        return noop(state);
      }
      // Sanchahou is orchestrator-driven: it fires immediately after
      // a discard when three opponents declare ron. The engine just
      // validates that there is a recent discard to abort against.
      if (state.lastDiscard === null) {
        return noop(state);
      }
      const next = clone(state);
      const events = endAbort(next, "sanchahou");
      return { state: next, events };
    }
    if (action.kind !== "kyuushuu") {
      return noop(state);
    }
    if (!state.ruleSet.aborts.kyuushuu) {
      return noop(state);
    }
    if (state.phase !== "awaiting_discard" || action.seat !== state.turn) {
      return noop(state);
    }
    // Must be the seat's first turn:
    //   - no calls yet from anyone (all melds empty)
    //   - no discards yet from any prior seat in turn order this go-round
    //     (the active seat just drew their 14th tile)
    if (state.melds.some((m) => m.length > 0) || hasNukiInterruption(state)) {
      return noop(state);
    }
    if (state.discards.some((d) => d.length > 0)) {
      return noop(state);
    }
    // ≥9 distinct terminal-or-honor tiles in the 14-tile hand.
    const seen = new Set<string>();
    for (const tile of state.hands[action.seat]) {
      if (isTerminalOrHonor(tile)) {
        // Normalize red 5 (`0X`) — irrelevant here since red 5 is
        // never terminal/honor, but use the same canonical key as
        // the rest of the engine for safety.
        const key = (tile[0] === "0" ? "5" : tile[0]) + tile[1];
        seen.add(key);
      }
    }
    if (seen.size < 9) {
      return noop(state);
    }
    const next = clone(state);
    const events = endAbort(next, "kyuushuu");
    return { state: next, events };
  }

  // ----- Complete shouminkan (chankan window closed without rob) ---------
  if (action.type === "complete_shouminkan") {
    if (
      state.phase !== "awaiting_chankan" ||
      state.pendingShouminkan === null
    ) {
      return noop(state);
    }
    const next = clone(state);
    const declarer = state.pendingShouminkan.seat;
    // Rinshan draw from the front of the dead wall.
    const rinshan = drawRinshan(next, action.replacementTile);
    if (rinshan === undefined) {
      return noop(state);
    }
    lockMissedRonFuriten(next, state.pendingShouminkan.tile, declarer, true);
    next.hands[declarer].push(rinshan.tile);
    finishReplacementDraw(next, declarer, rinshan.tile);
    next.pendingShouminkan = null;
    const events: EngineEvent[] = [
      {
        type: "draw",
        seat: declarer,
        tile: rinshan.tile,
        wallRemaining: next.liveWall.length,
        fromDeadWall:
          state.ruleSet.rulesFamily === "riichi" &&
          (state.ruleSet.playerCount === 4 || !rinshan.fixedDeadWall),
        ...(state.ruleSet.playerCount === 3 ||
        state.ruleSet.rulesFamily === "mcr"
          ? { replacementKind: "kan" as const }
          : {}),
      },
    ];
    captureKanDora(
      next,
      "minkan",
      events,
      rinshan.fixedDeadWall,
      rinshan.indicators
    );
    return { state: next, events };
  }

  // ----- Start next hand -------------------------------------------------
  if (action.type === "start_next_hand") {
    if (state.phase !== "hand_ended" || state.lastHandResult === null) {
      return noop(state);
    }
    const result = state.lastHandResult;
    // Dealer rotation:
    //   - Dealer win (tsumo or ron) → dealer stays, honba++.
    //   - Exhaustive draw → dealer keeps iff dealer was tenpai;
    //     honba++ either way.
    //   - Non-dealer win → dealer rotates, roundNumber++, honba reset.
    let dealer = state.dealer;
    let roundNumber = state.roundNumber;
    let roundWind = state.roundWind;
    let honba = state.honba;
    const dealerKeeps =
      state.ruleSet.rulesFamily === "mcr"
        ? false
        : (result.reason === "tsumo" || result.reason === "ron") &&
            result.winner === state.dealer
          ? true
          : result.reason === "exhaustive_draw"
            ? state.ruleSet.tenpaiRenchan &&
              result.tenpai !== null &&
              result.tenpai[state.dealer]
            : // Abortive draws: dealer always keeps; honba advances.
              result.reason === "abort";
    // Centralized end-of-match check. Covers tobi/agari-yame/
    // tenpai-yame/mangan-end (rule-flag driven) plus the
    // round-limit cutoff. See `matchEnd.ts` for the decision logic.
    const endDecision = shouldEndMatch(state, result, dealerKeeps);
    if (endDecision.ended) {
      const ended = clone(state);
      if (
        ended.ruleSet.unclaimedRiichiDeposits === "highest_score_player" &&
        ended.riichiSticks > 0
      ) {
        let highestSeat: Seat = 0;
        for (let seat = 1; seat < state.ruleSet.playerCount; seat++) {
          if (ended.scores[seat] > ended.scores[highestSeat]) {
            highestSeat = seat as Seat;
          }
        }
        ended.scores[highestSeat] +=
          ended.riichiSticks * ended.ruleSet.riichiBetValue;
        ended.riichiSticks = 0;
      }
      ended.phase = "match_ended";
      return {
        state: ended,
        events: [
          {
            type: "match_end",
            reason: endDecision.reason,
            finalScores: [...ended.scores] as SeatValues<number>,
          },
        ],
      };
    }
    // Chombos are surfaced as `reason: "abort"` with a `null`
    // `abortKind` (regular abortive draws always carry a
    // non-null kind — see `endAbort`). On a chombo the dealer
    // keeps but the repeat counter does NOT advance: the hand
    // is simply replayed.
    //
    // Buu Mahjong has no repeat counter at all — `honba` stays
    // pinned at 0 across every continuation, and the matching
    // `honbaPayments: false` flag on the preset already prevents
    // any honba-derived score bonus.
    const isChombo = result.reason === "abort" && result.abortKind === null;
    if (state.ruleSet.rulesFamily === "mcr") {
      honba = 0;
      dealer = ((state.dealer + 1) % state.ruleSet.playerCount) as Seat;
      roundNumber += 1;
      if (roundNumber > state.roundLimit) {
        const currentWindIdx = WINDS.indexOf(state.roundWind);
        roundWind = WINDS[currentWindIdx + 1];
        roundNumber = 1;
        dealer = 0;
      }
    } else if (dealerKeeps && !isChombo) {
      if (!state.ruleSet.buuMode) {
        honba += 1;
      }
    } else if (!dealerKeeps) {
      if (state.ruleSet.buuMode) {
        honba = 0;
      } else {
        honba = result.reason === "exhaustive_draw" ? honba + 1 : 0;
      }
      dealer = ((state.dealer + 1) % state.ruleSet.playerCount) as Seat;
      roundNumber += 1;
      if (roundNumber > state.roundLimit) {
        // Round-wind progression (e.g. hanchan E→S). When we get
        // here the round-limit branch in `shouldEndMatch` has
        // already declined to end the match, so we always have a
        // next wind to roll into.
        const currentWindIdx = WINDS.indexOf(state.roundWind);
        const nextWindIdx = currentWindIdx + 1;
        roundWind = WINDS[nextWindIdx];
        roundNumber = 1;
        dealer = 0;
      }
    }
    // Deal a fresh hand. Rotate the base seed deterministically on
    // every hand transition so the new wall always differs from the
    // previous one, even when neither `roundNumber` nor `honba`
    // advances (dealer renchan in Buu mode, chombo replays, etc.).
    // `roundNumber` / `honba` are still mixed in so the same seed
    // can't accidentally repeat later via the LCG cycle.
    const baseSeed = (Math.imul(state.seed, 1664525) + 1013904223) >>> 0;
    const handSeed =
      (baseSeed ^ (roundNumber * 1000003) ^ (honba * 7919)) >>> 0;
    const dealt =
      action.deal ??
      dealMatch(handSeed, {
        rulesFamily: state.ruleSet.rulesFamily,
        dealer,
        playerCount: state.ruleSet.playerCount,
        sanmaType: state.ruleSet.sanmaType,
        duplicate: state.sanmaWall?.mode === "duplicate",
        redFives: {
          m: state.ruleSet.nbRedFiveManzu,
          p: state.ruleSet.nbRedFivePinzu,
          s: state.ruleSet.nbRedFiveSouzu,
        },
      });
    const openingPair =
      state.ruleSet.playerCount === 3
        ? getSanmaIndicatorPair(dealt, 0)
        : undefined;
    if (
      state.ruleSet.playerCount === 3 &&
      (!openingPair ||
        !state.sanmaWall ||
        dealt.hands.length !== 3 ||
        dealt.doraIndicators.length !== 1 ||
        dealt.doraIndicators[0] !== openingPair.dora ||
        dealt.sanmaWall?.sanmaType !== state.ruleSet.sanmaType ||
        dealt.sanmaWall.mode !== state.sanmaWall.mode ||
        dealt.sanmaWall.replacementsTaken !== 0 ||
        dealt.sanmaWall.kanCount !== 0)
    ) {
      return noop(state);
    }
    const next = clone(state);
    next.hands = dealt.hands.map((h) => [...h]);
    next.discards = seatValues(state.ruleSet.playerCount, () => []);
    next.nukiTiles = seatValues(state.ruleSet.playerCount, () => []);
    next.flowerTiles =
      dealt.flowerTiles?.map((tiles) => [...tiles]) ??
      seatValues(state.ruleSet.playerCount, () => []);
    next.liveWall = [...dealt.liveWall];
    next.deadWall = [...dealt.deadWall];
    if (state.ruleSet.playerCount === 3 && dealt.sanmaWall) {
      next.sanmaWall = { ...dealt.sanmaWall };
    } else {
      delete next.sanmaWall;
    }
    next.doraIndicators = [...dealt.doraIndicators];
    next.uraDoraIndicators =
      state.ruleSet.rulesFamily === "mcr"
        ? []
        : state.ruleSet.playerCount === 3
          ? [openingPair!.ura]
          : [dealt.deadWall[5]];
    next.pendingKanDora = [];
    next.pendingKanUraDora = [];
    next.lastDrawn =
      state.ruleSet.rulesFamily === "mcr"
        ? seatValues<Tile | null>(state.ruleSet.playerCount, (seat) =>
            seat === dealer ? (dealt.hands[dealer].at(-1) ?? null) : null
          )
        : seatValues(state.ruleSet.playerCount, () => null);
    next.lastDrawFromDeadWall = false;
    next.lastDrawFromKong = false;
    next.lastDiscard = null;
    next.pendingRiichiSeat = null;
    next.dealer = dealer;
    next.roundWind = roundWind;
    next.roundNumber = roundNumber;
    next.honba = honba;
    next.riichiDeclared = seatValues(state.ruleSet.playerCount, () => false);
    next.doubleRiichi = seatValues(state.ruleSet.playerCount, () => false);
    next.ippatsuEligible = seatValues(state.ruleSet.playerCount, () => false);
    next.melds = seatValues(state.ruleSet.playerCount, () => []);
    next.pendingShouminkan = null;
    next.pendingNuki = null;
    next.pendingFlower = null;
    next.pendingRyuukyoku = null;
    next.turn = dealer;
    next.phase =
      state.ruleSet.rulesFamily === "mcr"
        ? "awaiting_discard"
        : "awaiting_draw";
    next.lastHandResult = null;
    next.furitenLocked = seatValues(state.ruleSet.playerCount, () => false);
    next.furitenTemp = seatValues(state.ruleSet.playerCount, () => false);
    next.paoDaisangen = seatValues(state.ruleSet.playerCount, () => null);
    next.paoDaisuushii = seatValues(state.ruleSet.playerCount, () => null);
    return {
      state: { ...next, seed: baseSeed },
      events: [
        {
          type: "hand_start",
          dealer,
          roundWind,
          roundNumber,
          honba,
          doraIndicators: next.doraIndicators,
        },
      ],
    };
  }

  return noop(state);
}

/** Test/debug accessor for the seat-wind helper. */
export function seatWind(
  seat: Seat,
  dealer: Seat,
  count: PlayerCount = 4
): Wind {
  return windForSeat(seat, dealer, count);
}
