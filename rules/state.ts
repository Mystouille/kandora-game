/**
 * Match state — the authoritative shape passed through `step()`.
 *
 * Phase 1 step 5a adds the scoring / round-progression surface:
 *   - per-seat `scores`
 *   - `dealer`, `roundWind`, `roundNumber`, `roundLimit`, `honba`,
 *     `riichiSticks`
 *   - `lastDiscard` (so ron can claim the most recent discard)
 *   - `lastHandResult` (set when a hand ends)
 *
 * Riichi declaration, ippatsu, ura-dora, calls (open melds), and
 * abortive draws ship in subsequent sub-steps (5b–5d) and extend
 * this shape additively.
 *
 * Invariants:
 *   - `hands[seat].length` is 13 between turns and 14 mid-turn (after
 *     the active seat has drawn, before they discard).
 *   - `lastDrawn[seat]` is the tile last drawn by `seat`, or `null`
 *     once they discard.
 *   - `liveWall[0]` is the next draw.
 *   - `turn` is the seat about to act (or who just drew).
 *   - When `phase === "hand_ended"`, the only legal action is
 *     `start_next_hand`. When `phase === "match_ended"` no further
 *     actions are accepted.
 */

import { dealMatch, type DealtMatch, type WallOptions } from "./wall";
import { type RuleSet, type RuleSetOverride, resolveRuleSet } from "./ruleSet";
import type { Seat, Tile, Wind } from "./types";

export type MatchPhase =
  | "awaiting_draw" // start-of-turn for `turn`; engine pulls from wall
  | "awaiting_discard" // active seat has drawn, must choose a discard
  | "awaiting_chankan" // shouminkan declared; opponents may rob the kan
  | "hand_ended" // hand finished (win or exhaustive draw)
  | "match_ended"; // match finished (round limit reached)

/**
 * Open or concealed meld owned by a seat. `claimedTile` records the
 * exact tile (and original holder) for chi/pon/daiminkan; `null`
 * for ankan.
 */
export interface Meld {
  type: "chi" | "pon" | "daiminkan" | "ankan" | "shouminkan";
  /** Tiles in the meld, sorted ascending. */
  tiles: Tile[];
  /** The tile that was called (chi/pon/daiminkan/shouminkan). */
  claimedTile: Tile | null;
  /** The seat the called tile came from (chi/pon/daiminkan). */
  from: Seat | null;
}

export interface HandResult {
  /** Reason the hand ended. */
  reason: "tsumo" | "ron" | "exhaustive_draw" | "abort";
  /** Winning seat for tsumo/ron; `null` for exhaustive draws and aborts. */
  winner: Seat | null;
  /** Seat that dealt the winning tile (ron only). */
  loser: Seat | null;
  /** Net points delta per seat for this hand. */
  delta: [number, number, number, number];
  /**
   * Per-seat tenpai status at exhaustive draw (used for tenpai
   * payments + dealer-keep-on-tenpai). `null` for tsumo/ron/abort
   * results.
   */
  tenpai: [boolean, boolean, boolean, boolean] | null;
  /**
   * Specific abortive-draw flavor when `reason === "abort"`.
   * `null` for any other reason.
   */
  abortKind: "kyuushuu" | "suufon_renda" | "suucha_riichi" | "sanchahou" | null;
  /**
   * Per-seat nagashi mangan flag at exhaustive draw. `null` for
   * tsumo/ron/abort or when no seat qualifies.
   */
  nagashi?: [boolean, boolean, boolean, boolean] | null;
  /**
   * Han count of the winning hand (max across winners on multi-ron).
   * `0` for yakuman wins — check `winYakuman` for that case.
   * `null` for any non-win result (exhaustive draw / abort).
   */
  winHan: number | null;
  /**
   * True iff the winning hand scored as a yakuman (any multiple).
   * `false` for non-yakuman wins; `null` for any non-win result.
   */
  winYakuman: boolean | null;
}

export interface MatchOptions {
  /**
   * Optional rule-set override. Any field not provided falls back to
   * `DEFAULT_RULE_SET` (Tenhou-default hanchan).
   */
  ruleSet?: RuleSetOverride;
  /** Wall options forwarded to `dealMatch`. */
  wall?: WallOptions;
}

export interface MatchState {
  readonly seed: number;
  /** Active rule set (resolved from defaults + overrides at deal time). */
  readonly ruleSet: RuleSet;
  hands: Tile[][];
  discards: Tile[][];
  liveWall: Tile[];
  deadWall: Tile[];
  doraIndicators: Tile[];
  turn: Seat;
  lastDrawn: (Tile | null)[];
  /**
   * Most recent discard, available for ron until the next seat draws.
   * Cleared when a draw completes.
   */
  lastDiscard: { seat: Seat; tile: Tile } | null;
  phase: MatchPhase;
  /** Current dealer seat. */
  dealer: Seat;
  /** Round wind (E / S / W / N). 5a only progresses through E. */
  roundWind: Wind;
  /**
   * 1-indexed hand within the round wind (E1 = 1, E2 = 2, …).
   * Match ends when this exceeds `roundLimit` after a hand transition
   * that rotates the dealer.
   */
  roundNumber: number;
  /** Hands per round wind. */
  roundLimit: number;
  /** Honba counter (repeat / draw repeats). */
  honba: number;
  /** Stake (riichi sticks × 1000) waiting to be claimed by next winner. */
  riichiSticks: number;
  /** Current per-seat scores. */
  scores: [number, number, number, number];
  /** Per-seat riichi declaration flag (cleared at hand start). */
  riichiDeclared: [boolean, boolean, boolean, boolean];
  /** Per-seat double-riichi flag (subset of riichiDeclared). */
  doubleRiichi: [boolean, boolean, boolean, boolean];
  /** Per-seat ippatsu eligibility. True from the riichi discard until
   * either the declarer's next discard or any call (calls clear all
   * four flags).
   */
  ippatsuEligible: [boolean, boolean, boolean, boolean];
  /**
   * Per-seat permanent furiten flag — set when a seat passes a ron
   * opportunity while in riichi (or any time `lastDiscard` is
   * consumed without ron and at least one of the seat's waits sat
   * on the table). Cleared at hand start.
   *
   * The complete furiten predicate also includes the "any wait is
   * in your own discard pile" check, computed on demand at ron
   * time; this flag captures only the permanent / missed-ron
   * portion that can't be derived from a snapshot of the state.
   */
  furitenLocked: [boolean, boolean, boolean, boolean];
  /**
   * Per-seat temporary furiten flag — set when a non-riichi seat
   * passes a ron opportunity, and cleared at that seat's next
   * discard. Riichi seats use `furitenLocked` instead (permanent
   * for the rest of the hand). Cleared at hand start.
   *
   * Enforced alongside `furitenLocked` and the on-demand self-
   * discard check by `isFuritenForRon` (step.ts) and `pushRon`
   * (calls.ts).
   */
  furitenTemp: [boolean, boolean, boolean, boolean];
  /**
   * Pao (sekinin barai) responsibility for daisangen. Indexed by
   * the eventual winning seat: `paoDaisangen[winner] = payer` means
   * `payer` fed the completing third-dragon meld and is therefore
   * liable for the daisangen yakuman portion if `winner` agaris
   * with daisangen. `null` for no liability. Cleared at hand start.
   */
  paoDaisangen: (Seat | null)[];
  /**
   * Pao for daisuushii (big four winds). Same shape as
   * `paoDaisangen`. Set when a caller completes a fourth distinct
   * wind pon/kan via a chi/pon/daiminkan call.
   */
  paoDaisuushii: (Seat | null)[];
  /** Per-seat open / concealed melds (chi, pon, kan). */
  melds: Meld[][];
  /**
   * Pending shouminkan declaration awaiting chankan resolution.
   * Set when a seat declares shouminkan; cleared when the chankan
   * window closes (either by a chankan ron, which ends the hand, or
   * by `complete_shouminkan`, which performs the rinshan draw and
   * returns the seat to `awaiting_discard`).
   *   - `seat`: the declarer.
   *   - `tile`: the upgrade tile (the would-be "chankan win tile").
   *   - `ponIdx`: index into `melds[seat]` of the pon being upgraded
   *     (already swapped to `shouminkan` at declaration).
   */
  pendingShouminkan: { seat: Seat; tile: Tile; ponIdx: number } | null;
  /**
   * Ura-dora indicators (derived from the dead wall at deal time).
   * Revealed to scoring only when a riichi seat wins.
   */
  uraDoraIndicators: Tile[];
  /**
   * Kan-dora indicators captured at kan time but not yet revealed,
   * because `ruleSet.instantlyRevealDoraForMinkan` or
   * `instantlyRevealDoraForAnkan` is `false` for the kan that
   * produced them. Drained on the declarer's next discard (which
   * pushes them into `doraIndicators` and emits a `new_dora`
   * event per entry). Always empty when both instant-reveal flags
   * are on. Tiles are captured at kan time so the dora identity
   * is fixed even if further kans shift the dead wall before the
   * pending reveals are drained.
   */
  pendingKanDora: Tile[];
  /** Ura-dora indicators paired with `pendingKanDora`, drained together. */
  pendingKanUraDora: Tile[];
  /**
   * Outcome of the most recently finished hand. Set when phase
   * transitions to `hand_ended`; cleared on the next hand start.
   */
  lastHandResult: HandResult | null;
}

export function createInitialState(
  seed: number,
  opts: MatchOptions = {}
): MatchState {
  const ruleSet = resolveRuleSet(opts.ruleSet);
  const startingScore = ruleSet.startingScore;
  const roundLimit = ruleSet.roundLimit;
  const wallOpts: WallOptions = {
    redFives: {
      m: ruleSet.nbRedFiveManzu,
      p: ruleSet.nbRedFivePinzu,
      s: ruleSet.nbRedFiveSouzu,
    },
    ...(opts.wall ?? {}),
  };
  const dealt: DealtMatch = dealMatch(seed, wallOpts);
  return {
    seed,
    ruleSet,
    hands: dealt.hands.map((h) => [...h]),
    discards: [[], [], [], []],
    liveWall: [...dealt.liveWall],
    deadWall: [...dealt.deadWall],
    doraIndicators: [...dealt.doraIndicators],
    turn: 0,
    lastDrawn: [null, null, null, null],
    lastDiscard: null,
    phase: "awaiting_draw",
    dealer: 0,
    roundWind: "E",
    roundNumber: 1,
    roundLimit,
    honba: 0,
    riichiSticks: 0,
    scores: [startingScore, startingScore, startingScore, startingScore] as [
      number,
      number,
      number,
      number,
    ],
    riichiDeclared: [false, false, false, false],
    doubleRiichi: [false, false, false, false],
    ippatsuEligible: [false, false, false, false],
    melds: [[], [], [], []],
    pendingShouminkan: null,
    uraDoraIndicators: [dealt.deadWall[5]],
    pendingKanDora: [],
    pendingKanUraDora: [],
    lastHandResult: null,
    furitenLocked: [false, false, false, false],
    furitenTemp: [false, false, false, false],
    paoDaisangen: [null, null, null, null],
    paoDaisuushii: [null, null, null, null],
  };
}
