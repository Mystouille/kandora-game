import { seatValuesSchema, type SeatValues } from "~/game/protocol/seat";
import { SanmaWallStateSchema } from "../protocol/sanma";
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
 *   - `liveWall.length` is the number of future ordinary draws.
 *     Sanma reserve movement and replacement cursors are explicit in
 *     `sanmaWall`; four-player kans reserve one live-tail tile.
 *   - `turn` is the seat about to act (or who just drew).
 *   - When `phase === "hand_ended"`, the only legal action is
 *     `start_next_hand`. When `phase === "match_ended"` no further
 *     actions are accepted.
 */

import { z } from "zod";
import { dealMatch, type DealtMatch, type WallOptions } from "./wall";
import { getSanmaIndicatorPair, type SanmaWallState } from "./wallTransitions";
import {
  RuleSetSchema,
  type RuleSet,
  type RuleSetOverride,
  resolveRuleSet,
} from "./ruleSet";
import type { Seat, Tile, Wind } from "./types";
import { isActiveSeat, seatValues } from "./seats";
import { isNukiTile } from "./nuki";

export type MatchPhase =
  | "awaiting_draw" // start-of-turn for `turn`; engine pulls from wall
  | "awaiting_discard" // active seat has drawn, must choose a discard
  | "awaiting_chankan" // added kan or Online North declared; opponents may ron
  | "awaiting_nuki_replacement" // mandatory Kansai tile extracted; replacement owed
  | "awaiting_ryuukyoku_declarations" // exhaustive draw; seats declare in dealer order
  | "awaiting_ryuukyoku_settlement" // all declarations collected; awaiting settlement
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

export interface PendingRyuukyoku {
  /** Tenpai status computed from each seat's hand at exhaustive draw. */
  actualTenpai: SeatValues<boolean>;
  /** Public declarations collected in dealer order. */
  declarations: SeatValues<boolean | null>;
  /** Nagashi mangan qualification fixed at exhaustive draw. */
  nagashi: SeatValues<boolean>;
}

export interface PendingNuki {
  seat: Seat;
  tile: Tile;
  /** Resume awaiting_draw with a thirteen-tile hand, not a playable draw turn. */
  opening: boolean;
}

export interface HandResult {
  /** Reason the hand ended. */
  reason: "tsumo" | "ron" | "exhaustive_draw" | "abort";
  /** Winning seat for tsumo/ron; `null` for exhaustive draws and aborts. */
  winner: Seat | null;
  /** Seat that dealt the winning tile (ron only). */
  loser: Seat | null;
  /** Net points delta per seat for this hand. */
  delta: SeatValues<number>;
  /**
   * Per-seat tenpai status at exhaustive draw (used for tenpai
   * payments + dealer-keep-on-tenpai). `null` for tsumo/ron/abort
   * results.
   */
  tenpai: SeatValues<boolean> | null;
  /**
   * Specific abortive-draw flavor when `reason === "abort"`.
   * `null` for any other reason.
   */
  abortKind: "kyuushuu" | "suufon_renda" | "suucha_riichi" | "sanchahou" | null;
  /**
   * Per-seat nagashi mangan flag at exhaustive draw. `null` for
   * tsumo/ron/abort or when no seat qualifies.
   */
  nagashi?: SeatValues<boolean> | null;
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
  /** Trusted prebuilt deal supplied by an external match driver. */
  deal?: DealtMatch;
}

export interface MatchState {
  readonly seed: number;
  /** Active rule set (resolved from defaults + overrides at deal time). */
  readonly ruleSet: RuleSet;
  hands: Tile[][];
  discards: Tile[][];
  nukiTiles: Tile[][];
  liveWall: Tile[];
  deadWall: Tile[];
  /** Required for sanma; absent from legacy and current four-player states. */
  sanmaWall?: SanmaWallState;
  doraIndicators: Tile[];
  turn: Seat;
  lastDrawn: (Tile | null)[];
  /**
   * True when the most recent playable draw was a kan or nuki
   * replacement, including Duplicate's personal-queue replacements.
   * This is the legacy rinshan-eligibility flag, not physical source.
   * Used by the tsumo handler to distinguish rinshan kaihou
   * (replacement tsumo) from haitei (yaku from the last
   * live-wall tsumo) when the live wall is also empty — the two
   * cases collide on `liveWall.length === 0` and would otherwise
   * be indistinguishable. Reset on every draw and at hand start.
   */
  lastDrawFromDeadWall: boolean;
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
  /** Stake waiting for the next winner or end-of-match settlement. */
  riichiSticks: number;
  /** Current per-seat scores. */
  scores: SeatValues<number>;
  /** Per-seat riichi declaration flag (cleared at hand start). */
  riichiDeclared: SeatValues<boolean>;
  /**
   * Declarer whose latest riichi discard is still inside its ron window.
   * Cleared once the discard survives or the declaration is rejected by ron.
   */
  pendingRiichiSeat: Seat | null;
  /** Per-seat double-riichi flag (subset of riichiDeclared). */
  doubleRiichi: SeatValues<boolean>;
  /** Per-seat ippatsu eligibility. True from the riichi discard until
   * either the declarer's next discard or any call (calls clear all
   * four flags).
   */
  ippatsuEligible: SeatValues<boolean>;
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
  furitenLocked: SeatValues<boolean>;
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
  furitenTemp: SeatValues<boolean>;
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
   * Online: tile removed from the hand but not yet awarded as nuki.
   * Retained as physical custody after robbery until the next hand.
   * Kansai: tile already in nukiTiles, with only its replacement owed.
   * Never concurrent with pendingShouminkan or pendingRyuukyoku.
   */
  pendingNuki: PendingNuki | null;
  /**
   * Exhaustive-draw status fixed before declarations begin. Cleared
   * when `complete_ryuukyoku` settles the hand.
   */
  pendingRyuukyoku: PendingRyuukyoku | null;
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
  /**
   * Buu Mahjong chip ledger. Per-seat running chip totals
   * accumulated by sankoro / nikoro / chinmai payouts at
   * hand-end. Always present (zeros under non-Buu rule sets so
   * the wire shape never changes) but only mutated when
   * `ruleSet.buuMode` is on. Chips are a parallel currency to
   * `scores` — the engine never converts between the two.
   */
  chips: SeatValues<number>;
  /**
   * Buu Mahjong "dabuken" (double-chip) tokens. A seat holding a
   * dabuken doubles the chip income from its next sankoro payout
   * (token consumed on use). Earned by yakuman wins under
   * `ruleSet.immediateSankoroOnYakuman`. Always present; only
   * mutated when `ruleSet.buuMode` is on.
   */
  dabuken: SeatValues<boolean>;
}

const StateTileSchema = z.string().regex(/^([0-9][mps]|[1-7]z)$/);
const StateSeatSchema = z.union([
  z.literal(0),
  z.literal(1),
  z.literal(2),
  z.literal(3),
]);
const NumberTuple4Schema = seatValuesSchema(z.number().int());
const BooleanTuple4Schema = seatValuesSchema(z.boolean());
const NullableBooleanTuple4Schema = seatValuesSchema(z.boolean().nullable());

const StateMeldSchema: z.ZodType<Meld> = z
  .object({
    type: z.enum(["chi", "pon", "daiminkan", "ankan", "shouminkan"]),
    tiles: z.array(StateTileSchema),
    claimedTile: StateTileSchema.nullable(),
    from: StateSeatSchema.nullable(),
  })
  .strict();

const PendingRyuukyokuSchema: z.ZodType<PendingRyuukyoku> = z
  .object({
    actualTenpai: BooleanTuple4Schema,
    declarations: NullableBooleanTuple4Schema,
    nagashi: BooleanTuple4Schema,
  })
  .strict();

const HandResultSchema: z.ZodType<HandResult> = z
  .object({
    reason: z.enum(["tsumo", "ron", "exhaustive_draw", "abort"]),
    winner: StateSeatSchema.nullable(),
    loser: StateSeatSchema.nullable(),
    delta: NumberTuple4Schema,
    tenpai: BooleanTuple4Schema.nullable(),
    abortKind: z
      .enum(["kyuushuu", "suufon_renda", "suucha_riichi", "sanchahou"])
      .nullable(),
    nagashi: BooleanTuple4Schema.nullable().optional(),
    winHan: z.number().int().nullable(),
    winYakuman: z.boolean().nullable(),
  })
  .strict();

export const MatchStateSchema: z.ZodType<MatchState> = z
  .object({
    seed: z.number().int(),
    ruleSet: RuleSetSchema,
    hands: z.array(z.array(StateTileSchema)).min(3).max(4),
    discards: z.array(z.array(StateTileSchema)).min(3).max(4),
    nukiTiles: seatValuesSchema(z.array(StateTileSchema)).optional(),
    liveWall: z.array(StateTileSchema),
    deadWall: z.array(StateTileSchema),
    sanmaWall: SanmaWallStateSchema.optional(),
    doraIndicators: z.array(StateTileSchema),
    turn: StateSeatSchema,
    lastDrawn: z.array(StateTileSchema.nullable()).min(3).max(4),
    lastDrawFromDeadWall: z.boolean(),
    lastDiscard: z
      .object({ seat: StateSeatSchema, tile: StateTileSchema })
      .strict()
      .nullable(),
    phase: z.enum([
      "awaiting_draw",
      "awaiting_discard",
      "awaiting_chankan",
      "awaiting_nuki_replacement",
      "awaiting_ryuukyoku_declarations",
      "awaiting_ryuukyoku_settlement",
      "hand_ended",
      "match_ended",
    ]),
    dealer: StateSeatSchema,
    roundWind: z.enum(["E", "S", "W", "N"]),
    roundNumber: z.number().int().positive(),
    roundLimit: z.number().int().positive(),
    honba: z.number().int().nonnegative(),
    riichiSticks: z.number().int().nonnegative(),
    scores: NumberTuple4Schema,
    riichiDeclared: BooleanTuple4Schema,
    pendingRiichiSeat: StateSeatSchema.nullable().default(null),
    doubleRiichi: BooleanTuple4Schema,
    ippatsuEligible: BooleanTuple4Schema,
    furitenLocked: BooleanTuple4Schema,
    furitenTemp: BooleanTuple4Schema,
    paoDaisangen: z.array(StateSeatSchema.nullable()).min(3).max(4),
    paoDaisuushii: z.array(StateSeatSchema.nullable()).min(3).max(4),
    melds: z.array(z.array(StateMeldSchema)).min(3).max(4),
    pendingShouminkan: z
      .object({
        seat: StateSeatSchema,
        tile: StateTileSchema,
        ponIdx: z.number().int().nonnegative(),
      })
      .strict()
      .nullable(),
    pendingNuki: z
      .object({
        seat: StateSeatSchema,
        tile: StateTileSchema,
        opening: z.boolean(),
      })
      .strict()
      .nullable()
      .default(null),
    pendingRyuukyoku: PendingRyuukyokuSchema.nullable().default(null),
    uraDoraIndicators: z.array(StateTileSchema),
    pendingKanDora: z.array(StateTileSchema),
    pendingKanUraDora: z.array(StateTileSchema),
    lastHandResult: HandResultSchema.nullable(),
    chips: NumberTuple4Schema,
    dabuken: BooleanTuple4Schema,
  })
  .strict()
  .superRefine((state, context) => {
    const count = state.ruleSet.playerCount;
    if (count === 3) {
      const openingPair = getSanmaIndicatorPair(state, 0);
      if (!state.sanmaWall || !openingPair) {
        context.addIssue({
          code: "custom",
          path: ["sanmaWall"],
          message:
            "Sanma requires valid replacement counters and reserve layout",
        });
      } else {
        if (state.doraIndicators[0] !== openingPair.dora) {
          context.addIssue({
            code: "custom",
            path: ["doraIndicators"],
            message: "Opening dora must match the sanma reserve layout",
          });
        }
        if (state.uraDoraIndicators[0] !== openingPair.ura) {
          context.addIssue({
            code: "custom",
            path: ["uraDoraIndicators"],
            message: "Opening ura must match the sanma reserve layout",
          });
        }
        if (
          state.doraIndicators.length !== state.uraDoraIndicators.length ||
          state.pendingKanDora.length !== state.pendingKanUraDora.length ||
          state.doraIndicators.length + state.pendingKanDora.length >
            state.sanmaWall.kanCount + 1
        ) {
          context.addIssue({
            code: "custom",
            path: ["sanmaWall", "kanCount"],
            message: "Indicator pairs must not exceed committed kans",
          });
        }
      }
      if (
        state.sanmaWall &&
        state.sanmaWall.sanmaType !== state.ruleSet.sanmaType
      ) {
        context.addIssue({
          code: "custom",
          path: ["sanmaWall", "sanmaType"],
          message: "Wall variant must match the active sanma rules",
        });
      }
    } else if (state.sanmaWall !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["sanmaWall"],
        message: "Four-player states cannot contain sanma wall metadata",
      });
    }
    if (
      (state.nukiTiles === undefined && count === 3) ||
      (state.nukiTiles !== undefined && state.nukiTiles.length !== count)
    ) {
      context.addIssue({
        code: "custom",
        path: ["nukiTiles"],
        message: `Expected ${count} nuki collections`,
      });
    }
    const pendingNuki = state.pendingNuki;
    const nukiTiles = state.nukiTiles ?? [];
    const nukiCount = nukiTiles.reduce(
      (total, tiles) => total + tiles.length,
      0
    );
    if (
      nukiCount +
        (pendingNuki && state.ruleSet.sanmaType === "online" ? 1 : 0) >
        4 ||
      nukiTiles.some((tiles) =>
        tiles.some((tile) => !isNukiTile(tile, state.ruleSet))
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["nukiTiles"],
        message: "Only the variant's four physical nuki tiles may be extracted",
      });
    }
    if (pendingNuki !== null) {
      const kansai = state.ruleSet.sanmaType === "kansai";
      const robbed =
        !kansai &&
        (state.phase === "hand_ended" || state.phase === "match_ended") &&
        state.lastHandResult?.reason === "ron" &&
        state.lastHandResult.loser === pendingNuki.seat;
      if (
        !isNukiTile(pendingNuki.tile, state.ruleSet) ||
        state.pendingShouminkan !== null ||
        state.pendingRyuukyoku !== null ||
        (kansai
          ? state.phase !== "awaiting_nuki_replacement"
          : pendingNuki.opening ||
            (state.phase !== "awaiting_chankan" && !robbed)) ||
        (kansai && !nukiTiles[pendingNuki.seat]?.includes(pendingNuki.tile)) ||
        state.hands[pendingNuki.seat]?.length !==
          (pendingNuki.opening ? 12 : 13) -
            3 * (state.melds[pendingNuki.seat]?.length ?? 0) ||
        state.lastDrawn[pendingNuki.seat] !== null ||
        (!pendingNuki.opening && state.turn !== pendingNuki.seat) ||
        (pendingNuki.opening &&
          (state.turn !== state.dealer ||
            state.discards.some((tiles) => tiles.length > 0) ||
            state.melds.some((melds) => melds.length > 0) ||
            state.lastDrawn.some((tile) => tile !== null) ||
            state.hands.some(
              (hand, seat) =>
                hand.length !== (seat === pendingNuki.seat ? 12 : 13)
            )))
      ) {
        context.addIssue({
          code: "custom",
          path: ["pendingNuki"],
          message: "Nuki custody and replacement phase must match the variant",
        });
      }
    }
    if (
      (state.phase === "awaiting_nuki_replacement" && pendingNuki === null) ||
      (state.phase === "awaiting_chankan" &&
        pendingNuki === null &&
        state.pendingShouminkan === null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["phase"],
        message:
          "A replacement or robbery phase requires its pending declaration",
      });
    }
    for (const key of [
      "hands",
      "discards",
      "lastDrawn",
      "scores",
      "riichiDeclared",
      "doubleRiichi",
      "ippatsuEligible",
      "furitenLocked",
      "furitenTemp",
      "paoDaisangen",
      "paoDaisuushii",
      "melds",
      "chips",
      "dabuken",
    ] as const) {
      if (state[key].length !== count) {
        context.addIssue({
          code: "custom",
          path: [key],
          message: `Expected ${count} active players`,
        });
      }
    }
    for (const [key, seat] of [
      ["turn", state.turn],
      ["dealer", state.dealer],
      ["pendingRiichiSeat", state.pendingRiichiSeat],
      ["lastDiscard", state.lastDiscard?.seat ?? null],
      ["pendingShouminkan", state.pendingShouminkan?.seat ?? null],
      ["pendingNuki", pendingNuki?.seat ?? null],
      ["winner", state.lastHandResult?.winner ?? null],
      ["loser", state.lastHandResult?.loser ?? null],
    ] as const) {
      if (seat !== null && !isActiveSeat(seat, count)) {
        context.addIssue({
          code: "custom",
          path: [key],
          message: "Seat is not an active participant",
        });
      }
    }
    if (state.pendingRyuukyoku !== null) {
      for (const [key, values] of Object.entries(state.pendingRyuukyoku)) {
        if (values.length !== count) {
          context.addIssue({
            code: "custom",
            path: ["pendingRyuukyoku", key],
            message: `Expected ${count} declarations`,
          });
        }
      }
    }
    if (state.lastHandResult !== null) {
      for (const key of ["delta", "tenpai", "nagashi"] as const) {
        const values = state.lastHandResult[key];
        if (values && values.length !== count) {
          context.addIssue({
            code: "custom",
            path: ["lastHandResult", key],
            message: `Expected ${count} results`,
          });
        }
      }
    }
    for (const [seat, melds] of state.melds.entries()) {
      for (const [index, meld] of melds.entries()) {
        if (meld.from !== null && !isActiveSeat(meld.from, count)) {
          context.addIssue({
            code: "custom",
            path: ["melds", seat, index, "from"],
            message: "Meld source is not active",
          });
        }
      }
    }
  })
  .transform((state) => ({
    ...state,
    nukiTiles:
      state.nukiTiles ??
      seatValues<Tile[]>(state.ruleSet.playerCount, () => []),
  }));

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
    playerCount: ruleSet.playerCount,
    sanmaType: ruleSet.sanmaType,
  };
  const dealt: DealtMatch = opts.deal ?? dealMatch(seed, wallOpts);
  if (dealt.hands.length !== ruleSet.playerCount) {
    throw new Error(`Expected a deal for ${ruleSet.playerCount} players`);
  }
  const count = ruleSet.playerCount;
  const openingPair = count === 3 ? getSanmaIndicatorPair(dealt, 0) : undefined;
  if (
    count === 3 &&
    (!openingPair ||
      dealt.doraIndicators.length !== 1 ||
      dealt.doraIndicators[0] !== openingPair.dora ||
      dealt.sanmaWall?.sanmaType !== ruleSet.sanmaType ||
      dealt.sanmaWall.replacementsTaken !== 0 ||
      dealt.sanmaWall.kanCount !== 0)
  ) {
    throw new Error(
      "Expected a fresh sanma deal with a valid matching wall reserve"
    );
  }
  return {
    seed,
    ruleSet,
    hands: dealt.hands.map((h) => [...h]),
    discards: seatValues<Tile[]>(count, () => []),
    nukiTiles: seatValues<Tile[]>(count, () => []),
    liveWall: [...dealt.liveWall],
    deadWall: [...dealt.deadWall],
    ...(count === 3 && dealt.sanmaWall
      ? { sanmaWall: { ...dealt.sanmaWall } }
      : {}),
    doraIndicators: [...dealt.doraIndicators],
    turn: 0,
    lastDrawn: seatValues<Tile | null>(count, () => null),
    lastDrawFromDeadWall: false,
    lastDiscard: null,
    phase: "awaiting_draw",
    dealer: 0,
    roundWind: "E",
    roundNumber: 1,
    roundLimit,
    honba: 0,
    riichiSticks: 0,
    scores: seatValues(count, () => startingScore),
    riichiDeclared: seatValues(count, () => false),
    pendingRiichiSeat: null,
    doubleRiichi: seatValues(count, () => false),
    ippatsuEligible: seatValues(count, () => false),
    melds: seatValues<Meld[]>(count, () => []),
    pendingShouminkan: null,
    pendingNuki: null,
    pendingRyuukyoku: null,
    uraDoraIndicators: count === 3 ? [openingPair!.ura] : [dealt.deadWall[5]],
    pendingKanDora: [],
    pendingKanUraDora: [],
    lastHandResult: null,
    furitenLocked: seatValues(count, () => false),
    furitenTemp: seatValues(count, () => false),
    paoDaisangen: seatValues<Seat | null>(count, () => null),
    paoDaisuushii: seatValues<Seat | null>(count, () => null),
    chips: seatValues(count, () => ruleSet.startingChips),
    dabuken: seatValues(count, () => false),
  };
}
