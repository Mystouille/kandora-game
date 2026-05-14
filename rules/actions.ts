/**
 * Action types accepted by `step()`. Phase 1 step 5a extends the
 * draw/discard loop with win declarations (`tsumo`, `ron`) and the
 * hand → next-hand transition (`start_next_hand`).
 *
 * Calls (pon/chi/kan), riichi declaration, and abortive-draw
 * declarations land in 5b–5d. New action shapes are added
 * additively — existing actions don't change.
 *
 * Actions are addressed to a `seat` and validated against
 * `state.turn` + `state.phase`. Engine output is `{ state, events }`
 * — never throws on illegal action; returns an empty event list and
 * leaves state untouched (caller decides whether to surface "illegal"
 * to a UI). This keeps `step` safe to call from speculative bot AI.
 */

import type { Seat, Tile } from "./types";

export interface DiscardAction {
  type: "discard";
  seat: Seat;
  tile: Tile;
}

/**
 * Engine-internal "pull next tile" advance. Synthesized by the engine
 * itself when `phase === "awaiting_draw"` — callers don't issue it.
 * Modeled as an action so the reducer stays the single source of truth.
 */
export interface DrawAction {
  type: "draw";
  seat: Seat;
}

/** Self-drawn win — the seat declares tsumo on their most recent draw. */
export interface TsumoAction {
  type: "tsumo";
  seat: Seat;
}

/**
 * Claim the most recent discard as a winning tile.
 *
 * Multi-ron: when two or three opponents both ron the same discard,
 * the orchestrator dispatches a single `ron` action with `seat` set
 * to the head bumper (closest non-discarder going counter-clockwise)
 * and the remaining winners listed in `additionalWinners`. The
 * engine scores each winner independently, sums per-seat payments,
 * awards riichi sticks to the head bumper, and emits one `win` event
 * per winner followed by a single combined `hand_end`.
 */
export interface RonAction {
  type: "ron";
  seat: Seat;
  /** Extra winners (double / triple ron). Order doesn't matter. */
  additionalWinners?: Seat[];
}

/**
 * Declare riichi while discarding `tile`. The engine validates that
 * the resulting 13-tile hand is tenpai, the seat has >=1000 points,
 * and the live wall has >=4 tiles remaining (the standard rule).
 * Double-riichi is auto-detected: if every seat's discard pile is
 * still empty when the action lands, `doubleRiichi[seat]` is set.
 */
export interface RiichiAction {
  type: "riichi";
  seat: Seat;
  tile: Tile;
}

/**
 * Call chi (open run) on the most recent discard. `tiles` are the
 * two tiles taken from the caller's hand; together with the claimed
 * discard they form the run. Chi is only legal when the caller is
 * the seat immediately to the discarder's left (next turn).
 */
export interface ChiAction {
  type: "chi";
  seat: Seat;
  tiles: [Tile, Tile];
}

/**
 * Call pon (open triplet) on the most recent discard. `tiles` are
 * the two matching tiles taken from the caller's hand.
 */
export interface PonAction {
  type: "pon";
  seat: Seat;
  tiles: [Tile, Tile];
}

/**
 * Call kan. Three flavours, distinguished by `kind`:
 *   - `daiminkan`: claim the most recent discard, contributing 3
 *     matching tiles from the hand.
 *   - `ankan`: declare a concealed kan from the hand (4 matching
 *     tiles already in hand). Only legal in `awaiting_discard`.
 *   - `shouminkan`: extend an existing pon by adding the matching
 *     tile from the hand. Resolved atomically by the engine for now;
 *     the chankan ron window lands with the multi-caller resolver.
 */
export interface KanAction {
  type: "kan";
  seat: Seat;
  kind: "daiminkan" | "ankan" | "shouminkan";
  tile: Tile;
}

/**
 * Player-initiated abortive draw declaration.
 *
 *   - `kyuushuu`: kyuushuu kyuuhai ("nine terminals abort"). Legal
 *     only on the seat's first turn (no discards yet by anyone, no
 *     calls have been made), in `awaiting_discard`, when the 14-tile
 *     hand contains ≥9 *distinct* terminal-or-honor tiles
 *     (1m, 9m, 1p, 9p, 1s, 9s, 1z–7z).
 *   - `sanchahou`: triple-ron abort. Synthesized by the orchestrator
 *     when three opponents declare ron on the same discard and the
 *     `aborts.sanchahou` rule is enabled. `seat` is informational
 *     only — the engine validates against `lastDiscard` instead of
 *     turn order. No scoring; riichi sticks carry over; dealer keeps
 *     and honba advances per standard abort bookkeeping.
 *
 * Auto-detected aborts (suufon renda, suucha riichi) are emitted by
 * the engine itself from inside the relevant action handler — no
 * action shape needed.
 */
export interface AbortAction {
  type: "abort";
  seat: Seat;
  kind: "kyuushuu" | "sanchahou";
}

/**
 * Transition out of `hand_ended` into the next hand (or into
 * `match_ended` when the round limit is reached). The orchestrator
 * issues this once it has surfaced the hand result to clients.
 */
export interface StartNextHandAction {
  type: "start_next_hand";
}

/**
 * Complete a pending shouminkan after the chankan window closes
 * with no robbing ron. Performs the rinshan draw, reveals the
 * post-kan dora indicator (if `ruleSet.kanDora`), clears
 * `pendingShouminkan`, and returns the declarer to
 * `awaiting_discard`. Engine-internal — orchestrator-driven, never
 * issued by clients.
 */
export interface CompleteShouminkanAction {
  type: "complete_shouminkan";
}

export type Action =
  | DiscardAction
  | DrawAction
  | TsumoAction
  | RonAction
  | RiichiAction
  | ChiAction
  | PonAction
  | KanAction
  | AbortAction
  | StartNextHandAction
  | CompleteShouminkanAction;
