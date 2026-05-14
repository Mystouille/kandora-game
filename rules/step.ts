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

import type { Action } from "./actions";
import { dealMatch } from "./wall";
import type { HandResult, MatchState, Meld } from "./state";
import { distributePayments } from "./payments";
import { scoreHand, type ScoreResult } from "./score";
import { isWinningShape, waits } from "./shanten";
import { isAnkanLegalDuringRiichi } from "./riichiKan";
import { type Seat, type Tile, type Wind } from "./types";

export type EngineEvent =
  | { type: "draw"; seat: Seat; tile: Tile; wallRemaining: number }
  | {
      type: "discard";
      seat: Seat;
      tile: Tile;
      tsumogiri: boolean;
      riichi?: boolean;
    }
  | {
      type: "win";
      winner: Seat;
      loser: Seat | null;
      winTile: Tile;
      score: ScoreResult;
      delta: [number, number, number, number];
    }
  | {
      type: "hand_end";
      reason: "exhaustive_draw" | "tsumo" | "ron" | "abort";
      delta: [number, number, number, number];
      abortKind?: "kyuushuu" | "suufon_renda" | "suucha_riichi" | "sanchahou";
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
      finalScores: [number, number, number, number];
    };

export interface StepResult {
  state: MatchState;
  events: EngineEvent[];
}

const WINDS: readonly Wind[] = ["E", "S", "W", "N"];

function clone(state: MatchState): MatchState {
  return {
    seed: state.seed,
    ruleSet: state.ruleSet,
    hands: state.hands.map((h) => [...h]),
    discards: state.discards.map((d) => [...d]),
    liveWall: [...state.liveWall],
    deadWall: [...state.deadWall],
    doraIndicators: [...state.doraIndicators],
    turn: state.turn,
    lastDrawn: [...state.lastDrawn],
    lastDiscard: state.lastDiscard ? { ...state.lastDiscard } : null,
    phase: state.phase,
    dealer: state.dealer,
    roundWind: state.roundWind,
    roundNumber: state.roundNumber,
    roundLimit: state.roundLimit,
    honba: state.honba,
    riichiSticks: state.riichiSticks,
    scores: [...state.scores] as [number, number, number, number],
    riichiDeclared: [...state.riichiDeclared] as [
      boolean,
      boolean,
      boolean,
      boolean,
    ],
    doubleRiichi: [...state.doubleRiichi] as [
      boolean,
      boolean,
      boolean,
      boolean,
    ],
    ippatsuEligible: [...state.ippatsuEligible] as [
      boolean,
      boolean,
      boolean,
      boolean,
    ],
    melds: state.melds.map((seatMelds) =>
      seatMelds.map((m) => ({ ...m, tiles: [...m.tiles] }))
    ),
    pendingShouminkan: state.pendingShouminkan
      ? { ...state.pendingShouminkan }
      : null,
    uraDoraIndicators: [...state.uraDoraIndicators],
    lastHandResult: state.lastHandResult,
    furitenLocked: [...state.furitenLocked] as [
      boolean,
      boolean,
      boolean,
      boolean,
    ],
    paoDaisangen: [...state.paoDaisangen],
    paoDaisuushii: [...state.paoDaisuushii],
  };
}

function noop(state: MatchState): StepResult {
  return { state, events: [] };
}

/** Seat wind for `seat` given current `dealer`. */
function seatWindFor(seat: Seat, dealer: Seat): Wind {
  return WINDS[(seat - dealer + 4) % 4];
}

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
  const distance = (winner - state.dealer + 4) % 4;
  for (let i = 0; i < 4; i++) {
    const s = ((state.dealer + i) % 4) as Seat;
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
function isFuritenForRon(state: MatchState, seat: Seat): boolean {
  if (state.furitenLocked[seat]) {
    return true;
  }
  if (state.discards[seat].length === 0) {
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
      hand: state.hands[seat],
      winTile: probe,
      tsumo: false,
      roundWind: state.roundWind,
      seatWind: seatWindFor(seat, state.dealer),
      doraIndicators: state.doraIndicators,
      uraDoraIndicators:
        state.ruleSet.uraDora && state.riichiDeclared[seat]
          ? state.uraDoraIndicators
          : undefined,
      riichi: state.riichiDeclared[seat],
      doubleRiichi: state.doubleRiichi[seat],
      ippatsu: state.ippatsuEligible[seat],
      melds: state.melds[seat],
      noKuitan: !state.ruleSet.kuitan,
      noAka: state.ruleSet.redFivesPerSuit === 0,
    });
    if (score.isAgari && (score.han > 0 || score.yakumanCount > 0)) {
      return true;
    }
  }
  return false;
}

/**
 * Update `furitenLocked` for any seat that had a wait on the
 * just-expired discard but did not ron. Called whenever
 * `lastDiscard` is consumed without a winning ron — i.e. the next
 * draw fires, or a chi/pon/kan call is taken.
 *
 * For every non-discarder seat whose `scoreHand` on `discardTile`
 * yields a valid agari, set `furitenLocked[seat] = true`. This
 * captures both "riichi seat passed" and "open-hand seat passed"
 * cases under a single rule (most rulesets agree: missing a ron in
 * any state locks you in furiten until your next discard, but in
 * riichi the lock is permanent — and since riichi seats can only
 * tsumogiri, the lock effectively persists for the rest of the
 * hand anyway).
 */
function lockMissedRonFuriten(
  next: MatchState,
  discardTile: Tile,
  discarder: Seat
): void {
  // Only riichi seats trigger the permanent furiten lock — they're
  // the only ones for whom "missed a ron" is durable across the
  // rest of the hand. Non-riichi seats use temporary furiten which
  // is enforced via the on-demand self-discard check at ron time
  // (and which clears at their next discard); skipping them here
  // is both correct and keeps `step()` cheap on the hot draw path.
  if (!next.riichiDeclared.some(Boolean)) {
    return;
  }
  for (let s = 0; s < 4; s++) {
    if (s === discarder) {
      continue;
    }
    if (next.furitenLocked[s]) {
      continue;
    }
    if (!next.riichiDeclared[s]) {
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
    const score = scoreHand({
      hand: next.hands[seat],
      winTile: discardTile,
      tsumo: false,
      roundWind: next.roundWind,
      seatWind: seatWindFor(seat, next.dealer),
      doraIndicators: next.doraIndicators,
      uraDoraIndicators: next.ruleSet.uraDora
        ? next.uraDoraIndicators
        : undefined,
      riichi: true,
      doubleRiichi: next.doubleRiichi[seat],
      ippatsu: next.ippatsuEligible[seat],
      melds: next.melds[seat],
      noKuitan: !next.ruleSet.kuitan,
      noAka: next.ruleSet.redFivesPerSuit === 0,
    });
    if (score.isAgari && (score.han > 0 || score.yakumanCount > 0)) {
      next.furitenLocked[seat] = true;
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
  const delta: [number, number, number, number] = [0, 0, 0, 0];
  next.phase = "hand_ended";
  next.lastHandResult = {
    reason: "abort",
    winner: null,
    loser: null,
    delta,
    tenpai: null,
    abortKind: kind,
  };
  return [{ type: "hand_end", reason: "abort", delta, abortKind: kind }];
}

/** Apply a delta vector into `scores` (mutates `scores` in place). */
function applyDelta(
  scores: [number, number, number, number],
  delta: readonly number[]
): void {
  for (let i = 0; i < 4; i++) {
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
): [number, number, number, number] {
  const out: [number, number, number, number] = [
    delta[0],
    delta[1],
    delta[2],
    delta[3],
  ];
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
  for (let s = 0; s < 4; s++) {
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
  score: ScoreResult
): EngineEvent[] {
  let delta = distributePayments({
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
  // from each non-winner. Goes entirely to the winner.
  if (next.honba > 0) {
    if (loser !== null) {
      const bonus = next.honba * 300;
      delta[loser] -= bonus;
      delta[winner] += bonus;
    } else {
      const bonusPer = next.honba * 100;
      for (let s = 0; s < 4; s++) {
        if (s === winner) {
          continue;
        }
        delta[s] -= bonusPer;
        delta[winner] += bonusPer;
      }
    }
  }
  // Carry over riichi sticks to the winner; reset.
  delta[winner] += next.riichiSticks * 1000;
  next.riichiSticks = 0;
  applyDelta(next.scores, delta);
  const result: HandResult = {
    reason: loser === null ? "tsumo" : "ron",
    winner,
    loser,
    delta,
    tenpai: null,
    abortKind: null,
  };
  next.lastHandResult = result;
  next.phase = "hand_ended";
  return [
    { type: "win", winner, loser, winTile, score, delta },
    { type: "hand_end", reason: result.reason, delta },
  ];
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
  const combined: [number, number, number, number] = [0, 0, 0, 0];
  const events: EngineEvent[] = [];
  for (let i = 0; i < winners.length; i++) {
    const w = winners[i];
    const score = scores[i];
    let d = distributePayments({
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
    for (let s = 0; s < 4; s++) {
      combined[s] += d[s];
    }
    events.push({ type: "win", winner: w, loser, winTile, score, delta: d });
  }
  // Honba bonus on multi-ron: only the head bumper collects, paid in
  // full by the discarder (Tenhou / standard ruling).
  if (next.honba > 0) {
    const bonus = next.honba * 300;
    combined[loser] -= bonus;
    combined[winners[0]] += bonus;
  }
  // Riichi sticks all go to the head bumper.
  combined[winners[0]] += next.riichiSticks * 1000;
  next.riichiSticks = 0;
  applyDelta(next.scores, combined);
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
function tenpaiPaymentDelta(
  tenpai: readonly boolean[]
): [number, number, number, number] {
  const delta: [number, number, number, number] = [0, 0, 0, 0];
  const tenpaiSeats: Seat[] = [];
  const notenSeats: Seat[] = [];
  for (let s = 0; s < 4; s++) {
    if (tenpai[s]) {
      tenpaiSeats.push(s as Seat);
    } else {
      notenSeats.push(s as Seat);
    }
  }
  if (tenpaiSeats.length === 0 || notenSeats.length === 4) {
    return delta;
  }
  if (tenpaiSeats.length === 4) {
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
): [number, number, number, number] {
  const delta: [number, number, number, number] = [0, 0, 0, 0];
  for (let s = 0; s < 4; s++) {
    if (!nagashi[s]) {
      continue;
    }
    const winner = s as Seat;
    if (winner === dealer) {
      // Dealer nagashi: each of the three non-dealers pays 4000.
      for (let p = 0; p < 4; p++) {
        if (p === winner) {
          continue;
        }
        delta[p] -= 4000;
        delta[winner] += 4000;
      }
    } else {
      // Non-dealer nagashi: dealer pays 4000, other non-dealers 2000.
      for (let p = 0; p < 4; p++) {
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

export function step(state: MatchState, action: Action): StepResult {
  if (state.phase === "match_ended") {
    return noop(state);
  }

  // ----- Draw ------------------------------------------------------------
  if (action.type === "draw") {
    if (state.phase !== "awaiting_draw" || action.seat !== state.turn) {
      return noop(state);
    }
    if (state.liveWall.length === 0) {
      const next = clone(state);
      // A seat is tenpai for payment purposes when at least one
      // wait tile exists. Riichi-declared seats are always
      // counted tenpai (they had to clear the same `waits()`
      // check at declaration time).
      const isTenpai = (s: Seat): boolean =>
        state.riichiDeclared[s] || waits(state.hands[s]).length > 0;
      const tenpai: [boolean, boolean, boolean, boolean] = [
        isTenpai(0),
        isTenpai(1),
        isTenpai(2),
        isTenpai(3),
      ];
      // Nagashi mangan: every discard is terminal/honor AND no
      // discard was ever called. We detect "called" by scanning
      // all melds for `from === seat` (called tiles are removed
      // from `discards[seat]` at call time, so the array itself
      // is not enough — but the meld provenance is).
      const nagashi: [boolean, boolean, boolean, boolean] = [
        false,
        false,
        false,
        false,
      ];
      if (next.ruleSet.nagashiMangan) {
        for (let s = 0; s < 4; s++) {
          const ds = state.discards[s];
          if (ds.length === 0) {
            continue;
          }
          if (!ds.every(isTerminalOrHonor)) {
            continue;
          }
          let wasCalled = false;
          for (let other = 0; other < 4; other++) {
            if (other === s) {
              continue;
            }
            for (const m of state.melds[other]) {
              if (m.from === s) {
                wasCalled = true;
                break;
              }
            }
            if (wasCalled) {
              break;
            }
          }
          if (!wasCalled) {
            nagashi[s] = true;
          }
        }
      }
      const tenpaiDelta = tenpaiPaymentDelta(tenpai);
      const nagashiDelta = nagashiPaymentDelta(nagashi, next.dealer);
      const delta: [number, number, number, number] = [
        tenpaiDelta[0] + nagashiDelta[0],
        tenpaiDelta[1] + nagashiDelta[1],
        tenpaiDelta[2] + nagashiDelta[2],
        tenpaiDelta[3] + nagashiDelta[3],
      ];
      applyDelta(next.scores, delta);
      next.phase = "hand_ended";
      const anyNagashi = nagashi.some((n) => n);
      next.lastHandResult = {
        reason: "exhaustive_draw",
        winner: null,
        loser: null,
        delta,
        tenpai,
        abortKind: null,
        nagashi: anyNagashi ? nagashi : null,
      };
      return {
        state: next,
        events: [{ type: "hand_end", reason: "exhaustive_draw", delta }],
      };
    }
    const next = clone(state);
    if (state.lastDiscard !== null) {
      // Compute missed-ron furiten BEFORE drawing — scoreHand
      // expects a 13-tile hand for ron evaluation.
      lockMissedRonFuriten(
        next,
        state.lastDiscard.tile,
        state.lastDiscard.seat
      );
    }
    const tile = next.liveWall.shift() as Tile;
    next.hands[next.turn].push(tile);
    next.lastDrawn[next.turn] = tile;
    next.lastDiscard = null; // ron window closes once next seat draws.
    next.phase = "awaiting_discard";
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
    // Riichi-declared seats are locked into tsumogiri (no choice of
    // discard) on every turn after their riichi declaration.
    if (
      state.riichiDeclared[action.seat] &&
      action.tile !== state.lastDrawn[action.seat]
    ) {
      return noop(state);
    }
    const idx = state.hands[action.seat].lastIndexOf(action.tile);
    if (idx < 0) {
      return noop(state);
    }
    const next = clone(state);
    const tsumogiri = next.lastDrawn[action.seat] === action.tile;
    next.hands[action.seat].splice(idx, 1);
    next.discards[action.seat].push(action.tile);
    next.lastDrawn[action.seat] = null;
    next.lastDiscard = { seat: action.seat, tile: action.tile };
    // Ippatsu lapses on the declarer's next discard. (Calls would
    // clear everyone's ippatsu in 5c; for now this is the only
    // path that clears it without a win.)
    if (next.ippatsuEligible[action.seat]) {
      next.ippatsuEligible[action.seat] = false;
    }
    next.turn = ((action.seat + 1) % 4) as Seat;
    next.phase = "awaiting_draw";
    const discardEvent: EngineEvent = {
      type: "discard",
      seat: action.seat,
      tile: action.tile,
      tsumogiri,
    };
    // Suufon renda: aborts the hand if all four seats' very first
    // discards are the same wind tile (1z–4z) and no calls have
    // been made. Triggered by the 4th seat's first discard.
    if (next.ruleSet.aborts.suufonRenda) {
      const allFirstDiscards =
        next.discards.every((d) => d.length === 1) &&
        next.melds.every((m) => m.length === 0);
      if (allFirstDiscards) {
        const first = next.discards[0][0];
        const isWind =
          first === "1z" || first === "2z" || first === "3z" || first === "4z";
        const allSame = isWind && next.discards.every((d) => d[0] === first);
        if (allSame) {
          const abortEvents = endAbort(next, "suufon_renda");
          return { state: next, events: [discardEvent, ...abortEvents] };
        }
      }
    }
    return {
      state: next,
      events: [discardEvent],
    };
  }

  // ----- Riichi ----------------------------------------------------------
  if (action.type === "riichi") {
    if (state.phase !== "awaiting_discard" || action.seat !== state.turn) {
      return noop(state);
    }
    if (state.riichiDeclared[action.seat]) {
      return noop(state);
    }
    if (state.scores[action.seat] < 1000) {
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
    if (state.liveWall.length < 4) {
      return noop(state);
    }
    const idx = state.hands[action.seat].lastIndexOf(action.tile);
    if (idx < 0) {
      return noop(state);
    }
    // Tenpai check on the 13-tile hand left after discarding.
    // `waits(hand)` returns `[]` when no tile completes the hand
    // (including the kara-ten case where all four wait copies are
    // already in the seat's own hand), so the declaration is
    // rejected in that case.
    const after = [...state.hands[action.seat]];
    after.splice(idx, 1);
    if (waits(after).length === 0) {
      return noop(state);
    }
    const next = clone(state);
    const tsumogiri = next.lastDrawn[action.seat] === action.tile;
    next.hands[action.seat].splice(idx, 1);
    next.discards[action.seat].push(action.tile);
    next.lastDrawn[action.seat] = null;
    next.lastDiscard = { seat: action.seat, tile: action.tile };
    // Pay the 1000-point stick to the table.
    next.scores[action.seat] -= 1000;
    next.riichiSticks += 1;
    next.riichiDeclared[action.seat] = true;
    if (next.ruleSet.ippatsu) {
      next.ippatsuEligible[action.seat] = true;
    }
    // Double riichi: every seat's discard pile was still empty right
    // before this action (i.e. nobody has discarded yet this hand).
    if (next.ruleSet.doubleRiichi) {
      const noDiscardsYet = state.discards.every((d) => d.length === 0);
      if (noDiscardsYet) {
        next.doubleRiichi[action.seat] = true;
      }
    }
    next.turn = ((action.seat + 1) % 4) as Seat;
    next.phase = "awaiting_draw";
    const discardEvent: EngineEvent = {
      type: "discard",
      seat: action.seat,
      tile: action.tile,
      tsumogiri,
      riichi: true,
    };
    // Suucha riichi: hand aborts when all four seats are in riichi.
    // Standard rule defers the abort until after the 4th declarer's
    // discard passes safely (no ron); since the engine doesn't yet
    // resolve a multi-seat ron window between actions, we abort
    // immediately on the 4th successful declaration.
    if (
      next.ruleSet.aborts.suuchaRiichi &&
      next.riichiDeclared.every((r) => r)
    ) {
      const abortEvents = endAbort(next, "suucha_riichi");
      return { state: next, events: [discardEvent, ...abortEvents] };
    }
    return {
      state: next,
      events: [discardEvent],
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
      hand: handBeforeWin,
      winTile,
      tsumo: true,
      roundWind: state.roundWind,
      seatWind: seatWindFor(action.seat, state.dealer),
      doraIndicators: state.doraIndicators,
      uraDoraIndicators:
        state.ruleSet.uraDora && state.riichiDeclared[action.seat]
          ? state.uraDoraIndicators
          : undefined,
      riichi: state.riichiDeclared[action.seat],
      doubleRiichi: state.doubleRiichi[action.seat],
      ippatsu: state.ippatsuEligible[action.seat],
      blessingOfHeavenOrEarth: isFirstUninterruptedGoAround(state, action.seat),
      melds: state.melds[action.seat],
      noKuitan: !state.ruleSet.kuitan,
      noAka: state.ruleSet.redFivesPerSuit === 0,
    });
    if (!score.isAgari) {
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
    //   2. `awaiting_chankan` — chankan ("robbing the kan"), where
    //      the win tile is the pending shouminkan upgrade tile and
    //      the "discarder" is the seat who declared the shouminkan.
    let discarder: Seat;
    let winTile: Tile;
    let isChankan = false;
    if (state.phase === "awaiting_chankan") {
      if (state.pendingShouminkan === null) {
        return noop(state);
      }
      discarder = state.pendingShouminkan.seat;
      winTile = state.pendingShouminkan.tile;
      isChankan = true;
    } else if (state.phase === "awaiting_draw" && state.lastDiscard !== null) {
      discarder = state.lastDiscard.seat;
      winTile = state.lastDiscard.tile;
    } else {
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
      if (w === discarder || seen.has(w)) {
        return noop(state);
      }
      seen.add(w);
      winners.push(w);
    }
    if (winners.length === 0 || winners.length > 3) {
      return noop(state);
    }
    // Reject any winner who is in furiten. (Chankan rons are exempt
    // from self-discard furiten in some rulesets, but the
    // permanent / missed-ron lock still applies. We apply both
    // checks uniformly here; chankan-specific carve-outs can ship
    // as a follow-up if needed.)
    for (const w of winners) {
      if (isFuritenForRon(state, w)) {
        return noop(state);
      }
    }
    // Score each winner; bail if any of them is not a valid agari.
    const scores: ScoreResult[] = [];
    for (const w of winners) {
      // Fast shape gate before the expensive scoreHand call.
      if (!isWinningShape(state.hands[w], state.melds[w], winTile)) {
        return noop(state);
      }
      const score = scoreHand({
        hand: state.hands[w],
        winTile,
        tsumo: false,
        roundWind: state.roundWind,
        seatWind: seatWindFor(w, state.dealer),
        doraIndicators: state.doraIndicators,
        uraDoraIndicators:
          state.ruleSet.uraDora && state.riichiDeclared[w]
            ? state.uraDoraIndicators
            : undefined,
        riichi: state.riichiDeclared[w],
        doubleRiichi: state.doubleRiichi[w],
        ippatsu: state.ippatsuEligible[w],
        // Renhou: non-dealer ron on the first uninterrupted
        // go-around. Dealer cannot renhou (they don't ron before
        // their first draw). Gated by ruleSet.
        blessingOfHeavenOrEarth:
          state.ruleSet.renhou &&
          w !== state.dealer &&
          !isChankan &&
          isFirstUninterruptedGoAround(state, w),
        melds: state.melds[w],
        noKuitan: !state.ruleSet.kuitan,
        noAka: state.ruleSet.redFivesPerSuit === 0,
        rinshanOrChankan: isChankan,
      });
      if (!score.isAgari) {
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
    if (state.phase !== "awaiting_draw" || state.lastDiscard === null) {
      return noop(state);
    }
    // Chi only legal from the seat immediately to the discarder's
    // left (i.e. the next-to-act seat under turn order).
    const expected = ((state.lastDiscard.seat + 1) % 4) as Seat;
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
    next.lastDiscard = null;
    next.lastDrawn = [null, null, null, null];
    next.ippatsuEligible = [false, false, false, false];
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
    if (action.seat === state.lastDiscard.seat) {
      return noop(state);
    }
    if (state.riichiDeclared[action.seat]) {
      return noop(state);
    }
    const claimed = state.lastDiscard.tile;
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
    next.lastDiscard = null;
    next.lastDrawn = [null, null, null, null];
    next.ippatsuEligible = [false, false, false, false];
    next.turn = action.seat;
    next.phase = "awaiting_discard";
    return {
      state: next,
      events: [{ type: "call", seat: action.seat, meld }],
    };
  }

  // ----- Kan -------------------------------------------------------------
  if (action.type === "kan") {
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
      next.lastDrawn = [null, null, null, null];
      next.ippatsuEligible = [false, false, false, false];
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
      next.lastDiscard = null;
      next.lastDrawn = [null, null, null, null];
      next.ippatsuEligible = [false, false, false, false];
      // Rinshan draw from the front of the dead wall, then reveal a
      // new dora indicator.
      const rinshan = next.deadWall.shift();
      if (rinshan === undefined) {
        return noop(state);
      }
      next.hands[action.seat].push(rinshan);
      next.lastDrawn[action.seat] = rinshan;
      const events: EngineEvent[] = [
        { type: "call", seat: action.seat, meld },
        {
          type: "draw",
          seat: action.seat,
          tile: rinshan,
          wallRemaining: next.liveWall.length,
        },
      ];
      // New dora indicator: the dead-wall layout shifts when rinshan
      // is removed, so the dora index advances by one in the original
      // layout. Cap at 4 additional reveals. Skipped entirely when
      // `ruleSet.kanDora` is off.
      if (next.ruleSet.kanDora && next.doraIndicators.length < 5) {
        const nextIdx = 3 + next.doraIndicators.length * 2;
        const indicator = next.deadWall[nextIdx];
        if (indicator !== undefined) {
          next.doraIndicators.push(indicator);
          const uraIndicator = next.deadWall[nextIdx + 1];
          if (uraIndicator !== undefined) {
            next.uraDoraIndicators.push(uraIndicator);
          }
          events.push({ type: "new_dora", indicator });
        }
      }
      next.turn = action.seat;
      next.phase = "awaiting_discard";
      return { state: next, events };
    }
    // Ankan
    if (state.phase !== "awaiting_discard" || action.seat !== state.turn) {
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
      if (!isAnkanLegalDuringRiichi(fullHand, action.tile)) {
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
    next.ippatsuEligible = [false, false, false, false];
    const rinshan = next.deadWall.shift();
    if (rinshan === undefined) {
      return noop(state);
    }
    next.hands[action.seat].push(rinshan);
    next.lastDrawn[action.seat] = rinshan;
    const events: EngineEvent[] = [
      { type: "call", seat: action.seat, meld },
      {
        type: "draw",
        seat: action.seat,
        tile: rinshan,
        wallRemaining: next.liveWall.length,
      },
    ];
    if (next.ruleSet.kanDora && next.doraIndicators.length < 5) {
      const nextIdx = 3 + next.doraIndicators.length * 2;
      const indicator = next.deadWall[nextIdx];
      if (indicator !== undefined) {
        next.doraIndicators.push(indicator);
        const uraIndicator = next.deadWall[nextIdx + 1];
        if (uraIndicator !== undefined) {
          next.uraDoraIndicators.push(uraIndicator);
        }
        events.push({ type: "new_dora", indicator });
      }
    }
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
    if (state.melds.some((m) => m.length > 0)) {
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
    const rinshan = next.deadWall.shift();
    if (rinshan === undefined) {
      return noop(state);
    }
    next.hands[declarer].push(rinshan);
    next.lastDrawn[declarer] = rinshan;
    next.pendingShouminkan = null;
    next.phase = "awaiting_discard";
    const events: EngineEvent[] = [
      {
        type: "draw",
        seat: declarer,
        tile: rinshan,
        wallRemaining: next.liveWall.length,
      },
    ];
    if (next.ruleSet.kanDora && next.doraIndicators.length < 5) {
      const nextIdx = 3 + next.doraIndicators.length * 2;
      const indicator = next.deadWall[nextIdx];
      if (indicator !== undefined) {
        next.doraIndicators.push(indicator);
        const uraIndicator = next.deadWall[nextIdx + 1];
        if (uraIndicator !== undefined) {
          next.uraDoraIndicators.push(uraIndicator);
        }
        events.push({ type: "new_dora", indicator });
      }
    }
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
      (result.reason === "tsumo" || result.reason === "ron") &&
      result.winner === state.dealer
        ? true
        : result.reason === "exhaustive_draw"
          ? result.tenpai !== null && result.tenpai[state.dealer]
          : // Abortive draws: dealer always keeps; honba advances.
            result.reason === "abort";
    if (dealerKeeps) {
      honba += 1;
    } else {
      honba = result.reason === "exhaustive_draw" ? honba + 1 : 0;
      dealer = ((state.dealer + 1) % 4) as Seat;
      roundNumber += 1;
      if (roundNumber > state.roundLimit) {
        // Round-wind progression (e.g. hanchan E→S). When the
        // configured number of round winds is exhausted the match
        // ends; otherwise we roll over to the next wind, reset the
        // hand counter, and dealer goes back to seat 0.
        const currentWindIdx = WINDS.indexOf(state.roundWind);
        const nextWindIdx = currentWindIdx + 1;
        if (nextWindIdx >= state.ruleSet.roundWindCount) {
          const ended = clone(state);
          ended.phase = "match_ended";
          return {
            state: ended,
            events: [
              {
                type: "match_end",
                finalScores: [...state.scores] as [
                  number,
                  number,
                  number,
                  number,
                ],
              },
            ],
          };
        }
        roundWind = WINDS[nextWindIdx];
        roundNumber = 1;
        dealer = 0;
      }
    }
    // Deal a fresh hand. The new seed mixes the original seed with
    // round + honba so each hand is deterministic and distinct.
    const handSeed =
      (state.seed ^ (roundNumber * 1000003) ^ (honba * 7919)) >>> 0;
    const dealt = dealMatch(handSeed, {
      redFives: state.ruleSet.redFivesPerSuit > 0,
    });
    const next = clone(state);
    next.hands = dealt.hands.map((h) => [...h]);
    next.discards = [[], [], [], []];
    next.liveWall = [...dealt.liveWall];
    next.deadWall = [...dealt.deadWall];
    next.doraIndicators = [...dealt.doraIndicators];
    next.uraDoraIndicators = [dealt.deadWall[5]];
    next.lastDrawn = [null, null, null, null];
    next.lastDiscard = null;
    next.dealer = dealer;
    next.roundWind = roundWind;
    next.roundNumber = roundNumber;
    next.honba = honba;
    next.riichiDeclared = [false, false, false, false];
    next.doubleRiichi = [false, false, false, false];
    next.ippatsuEligible = [false, false, false, false];
    next.melds = [[], [], [], []];
    next.turn = dealer;
    next.phase = "awaiting_draw";
    next.lastHandResult = null;
    next.furitenLocked = [false, false, false, false];
    next.paoDaisangen = [null, null, null, null];
    next.paoDaisuushii = [null, null, null, null];
    return {
      state: next,
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
export function seatWind(seat: Seat, dealer: Seat): Wind {
  return seatWindFor(seat, dealer);
}
