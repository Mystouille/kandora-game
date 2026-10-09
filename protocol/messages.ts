import { seatValuesSchema } from "~/game/protocol/seat";
import { z } from "zod";
import { MatchModeConfigSchema } from "./matchMode";
import { SpectatorDelayMsSchema } from "./spectatorDelay";
import { GameVariantMetadata, SeatSchema } from "./seat";
import { SANMA_CAPABILITY, SanmaWallStateSchema } from "./sanma";
import { MCR_CAPABILITY } from "./rulesFamily";
import { isActiveSeat } from "../rules/seats";
import type { GameVariant } from "./seat";
import {
  ActionWindowViewSchema,
  ClockProbeSchema,
  ClockSampleSchema,
  ClockStampSchema,
  PresentationContextSchema,
  TIMING_CAPABILITY,
  LatencyProbeSchema,
  LatencyReplySchema,
  FIXED_PROMPT_VERSION,
} from "./timing";

/**
 * WebSocket protocol between game client and game-server.
 *
 * Shared by client (`app/game/client/ws.ts`) and server
 * (`game-server/src/`). Wire format: JSON. Validation: Zod at every
 * boundary so a malformed frame can never reach the rules engine.
 *
 * The slice (Phase 0.5) implements only the minimum needed for a
 * single-table solo match: `hello`, `snapshot`, `event`, `act`,
 * `resync`, `error`. `ping`/`pong` heartbeats land later.
 */

// ---------------------------------------------------------------------------
// Tile + state primitives
// ---------------------------------------------------------------------------

/**
 * Tile string: `${n}${suit}` for man/pin/sou with `0` for red five,
 * `${n}z` for honors (1z–4z winds, 5z–7z dragons).
 *
 * Kept as a string union of Zod-validated literals (so JSON parses
 * cleanly). Stricter typing lives in `app/game/rules/types.ts` once
 * the rules engine lands.
 */
export const TileSchema = z.string().regex(/^([0-9][mps]|[1-7]z|[1-8]f)$/);
export type Tile = z.infer<typeof TileSchema>;

export type { Seat } from "./seat";

function refineParticipantArrays(
  variant: Partial<GameVariant>,
  arrays: Record<string, readonly unknown[] | undefined>,
  context: z.RefinementCtx
) {
  const count = variant.playerCount ?? 4;
  if (count === 3 && variant.sanmaType === undefined) {
    context.addIssue({
      code: "custom",
      path: ["sanmaType"],
      message: "Sanma metadata requires its variant",
    });
  }
  for (const [field, values] of Object.entries(arrays)) {
    if (values !== undefined && values.length !== count) {
      context.addIssue({
        code: "custom",
        path: [field],
        message: `Expected ${count} active participants`,
      });
    }
  }
  return count;
}

const NonnegativeCountTupleSchema = seatValuesSchema(
  z.number().int().nonnegative()
);
const NullableBooleanTupleSchema = seatValuesSchema(z.boolean().nullable());
const NullableHandTupleSchema = seatValuesSchema(
  z.array(TileSchema).nullable()
);

export const DuplicateWallStateSchema = z
  .object({
    initial: NonnegativeCountTupleSchema,
    remaining: NonnegativeCountTupleSchema,
    limitingSeat: SeatSchema.nullable(),
    estimatedDrawsRemaining: z.number().int().nonnegative().nullable(),
  })
  .strict();
export type DuplicateWallState = z.infer<typeof DuplicateWallStateSchema>;

// ---------------------------------------------------------------------------
// Events (server → client, embedded in `snapshot` and `event` messages)
// ---------------------------------------------------------------------------

const MatchStartEvent = z
  .object({
    type: z.literal("match_start"),
    ...GameVariantMetadata,
    seats: z.array(
      z.object({
        seat: SeatSchema,
        userId: z.string(),
        displayName: z.string(),
      })
    ),
    ruleSet: z.string(),
    /**
     * Per-seat in-game chip totals at match start. Buu only —
     * non-Buu matches omit the field. Carries the session chip
     * ledger (starting chips for the first game; rolling totals
     * for subsequent games) so the pre-deal player-name boxes
     * already show the correct count instead of zeros.
     */
    chips: z.array(z.number().int()).min(3).max(4).optional(),
    /** Per-seat dabuken token state at match start (Buu only). */
    dabuken: z.array(z.boolean()).min(3).max(4).optional(),
    /**
     * Active score-cap tier from the rule set, if any. Mirrors
     * `RuleSet.scoreCap`. Drives the win-panel label so a hand
     * whose points have been clamped also reports the tier name
     * (e.g. "Mangan") instead of the raw "8 han" / "Yakuman" that
     * would misrepresent the actual payout.
     */
    scoreCap: z
      .enum(["mangan", "haneman", "baiman", "sanbaiman"])
      .nullable()
      .optional(),
    /**
     * Point value of a single riichi stick (`RuleSet.riichiBetValue`).
     * Drives the client-side optimistic score deduction when a seat
     * declares riichi (the authoritative score is re-synced at the
     * next `hand_start`). Optional for back-compat with replays
     * archived before the field was added; absent ⇒ assume 1000
     * (standard riichi).
     */
    riichiBetValue: z.number().int().positive().optional(),
    /** Whether ura dora is enabled by the active rule set. */
    uraDoraEnabled: z.boolean().optional(),
  })
  .superRefine((event, context) => {
    const count = refineParticipantArrays(
      event,
      {
        seats: event.seats,
        chips: event.chips,
        dabuken: event.dabuken,
      },
      context
    );
    if (
      new Set(event.seats.map((seat) => seat.seat)).size !== count ||
      event.seats.some(({ seat }) => !isActiveSeat(seat, count))
    ) {
      context.addIssue({
        code: "custom",
        path: ["seats"],
        message: "Roster must identify every active seat exactly once",
      });
    }
  });

const HandStartEvent = z
  .object({
    type: z.literal("hand_start"),
    ...GameVariantMetadata,
    nukiTiles: z.array(z.array(TileSchema)).min(3).max(4).optional(),
    flowerTiles: z.array(z.array(TileSchema)).length(4).optional(),
    sanmaWall: SanmaWallStateSchema.optional(),
    round: z.number().int(),
    dealer: SeatSchema,
    /** Round wind (E/S/W/N). */
    roundWind: z.enum(["E", "S", "W", "N"]).optional(),
    /** 1-indexed hand within the round wind. */
    roundNumber: z.number().int().optional(),
    /** Honba counter (carries from prior repeats / abortive draws). */
    honba: z.number().int().nonnegative().optional(),
    /** Riichi sticks on the table at hand start. */
    riichiSticks: z.number().int().nonnegative().optional(),
    /** Per-seat scores at hand start. */
    scores: z.array(z.number().int()).min(3).max(4).optional(),
    /**
     * Per-seat "sinking" flag at hand start under the active rule
     * set. A sinking seat has `score <= rs.sinkThreshold`; the
     * renderer paints its centre-square score in red. Omitted
     * when the rule set has no notion of sinking (non-Buu); the
     * client treats absence as `[false, false, false, false]`.
     */
    sinking: z.array(z.boolean()).min(3).max(4).optional(),
    /**
     * Per-seat in-game chip totals at hand start. Buu only — non-Buu
     * matches omit the field and the client treats absence as
     * `[0, 0, 0, 0]`. Carries the session-level chip ledger into
     * each game so the live player-name boxes can display the
     * current chip count.
     */
    chips: z.array(z.number().int()).min(3).max(4).optional(),
    /**
     * Per-seat dabuken (double-chip token) state at hand start.
     * Buu only — non-Buu matches omit the field and the client
     * treats absence as `[false, false, false, false]`.
     */
    dabuken: z.array(z.boolean()).min(3).max(4).optional(),
    /** Initial hand tiles for the recipient seat only; redacted for others. */
    hand: z.array(TileSchema).optional(),
    /**
     * Omniscient per-seat starting hands (length 4, each 13 tiles).
     * Required in the **archived** replay log (every writer —
     * `archiveReplayLog` in game-server and every platform adapter —
     * must set it). Optional on the live wire because the projection
     * layer strips it before sending to each seat: opponents stay
     * redacted during the match. The reducer in
     * [app/game/replay/player.ts](../replay/player.ts) trusts the
     * archived value to render the omniscient post-game view.
     */
    startingHands: z.array(z.array(TileSchema)).min(3).max(4).optional(),
    doraIndicators: z.array(TileSchema),
    /**
     * The two dice rolled at hand start; together they determine the
     * wall break point. `null` when the source doesn't record dice
     * (older replays / synthetic logs). Values are in 1..6.
     */
    dice: z
      .tuple([z.number().int().min(1).max(6), z.number().int().min(1).max(6)])
      .nullable()
      .optional(),
    /**
     * Omniscient live wall in draw order — the 70 tiles remaining
     * after the initial 4×13 deal. `liveWall[0]` is the next tile
     * drawn; `liveWall[69]` is the last drawable tile before
     * exhaustive draw. Optional on the wire (the projection layer
     * strips it from live broadcasts so opponents stay blind);
     * required in the archived replay log so the `showWalls`
     * overlay can reveal tile faces. Older logs may omit it; the
     * renderer falls back to the back-of-tile texture when absent.
     */
    liveWall: z.array(TileSchema).optional(),
    /**
     * Omniscient dead wall snapshot in Tenhou yama-index order —
     * the 14 tiles never drawn during normal play (4 rinshan + dora
     * + ura-dora + 4 kan-dora + 4 ura-kan-dora). Index 5 is the
     * standard dora indicator, index 4 the standard ura-dora.
     * Physical mapping in the renderer is
     * `deadWall[idxFromBreak * 2 + row]` (row 1 = upper / public,
     * row 0 = lower / hidden). Optional on the player wire so
     * opponents stay blind during live play. Native archives snapshot
     * it directly; platform adapters populate it when their source can
     * reconstruct the wall deterministically. Older logs may omit it.
     * Drives the `showWalls` overlay's dead-wall reveal.
     */
    deadWall: z.array(TileSchema).optional(),
    /**
     * Live-wall draw schedule for the kyoku, in consumption order:
     * `liveDrawSchedule[i]` is the seat that draws `liveWall[i]`.
     * Computed post-parse by `annotateWallSchedule` from the kyoku's
     * recorded draw / kan events (rinshan draws are skipped). Used
     * by the `showWalls` overlay to highlight every wall tile the
     * focused seat will eventually draw. Optional — absent on live
     * broadcasts (the future is unknown) and on older archived logs
     * that pre-date the annotation pass.
     */
    liveDrawSchedule: z.array(SeatSchema).optional(),
    /** Fixed per-seat draw queues for an archived duplicate hand.
     * Never sent to live players or spectators. */
    duplicateDrawQueues: seatValuesSchema(z.array(TileSchema)).optional(),
    duplicateWallState: DuplicateWallStateSchema.optional(),
  })
  .superRefine((event, context) => {
    const count = event.playerCount ?? 4;
    const duplicate =
      event.duplicateWallState !== undefined ||
      event.sanmaWall?.mode === "duplicate";
    const expectedLive =
      count === 4
        ? 70
        : event.sanmaType === "kansai"
          ? duplicate
            ? 59
            : 63
          : 55;
    const expectedDead =
      count === 3 && event.sanmaType === "kansai" && !duplicate ? 10 : 14;
    if (event.rulesFamily !== "mcr") {
      for (const [field, expected] of [
        ["liveWall", expectedLive],
        ["deadWall", expectedDead],
      ] as const) {
        const values = event[field];
        if (values !== undefined && values.length !== expected) {
          context.addIssue({
            code: "custom",
            path: [field],
            message: `Expected ${expected} initial wall tiles`,
          });
        }
      }
    }
    for (const field of [
      "startingHands",
      "scores",
      "nukiTiles",
      "flowerTiles",
      "duplicateDrawQueues",
    ] as const) {
      const values = event[field];
      if (values !== undefined && values.length !== count) {
        context.addIssue({
          code: "custom",
          path: [field],
          message: `Expected ${count} participants`,
        });
      }
    }
    if (count === 3 && event.sanmaType === undefined) {
      context.addIssue({
        code: "custom",
        path: ["sanmaType"],
        message: "Sanma hand metadata requires its variant",
      });
    }
  });

const DrawEvent = z.object({
  type: z.literal("draw"),
  seat: SeatSchema,
  /** Tile is present only if recipient == drawer. */
  tile: TileSchema.optional(),
  wallRemaining: z.number().int().nonnegative(),
  /** True when this draw is a rinshan replacement (the tile comes
   * from the dead wall after a kan), false / absent for live-wall
   * draws. Attached post-parse by `annotateWallSchedule`. */
  fromDeadWall: z.boolean().optional(),
  replacementKind: z.enum(["kan", "nuki", "flower"]).optional(),
  opening: z.boolean().optional(),
  sanmaWall: SanmaWallStateSchema.optional(),
  duplicateWallState: DuplicateWallStateSchema.optional(),
});

const NukiEvent = z.object({
  type: z.literal("nuki"),
  seat: SeatSchema,
  tile: TileSchema.refine(
    (tile) => ["4z", "5m", "0m"].includes(tile),
    "Invalid nuki tile"
  ),
  stage: z.enum(["declared", "completed"]),
  opening: z.boolean().optional(),
  sanmaWall: SanmaWallStateSchema.optional(),
  duplicateWallState: DuplicateWallStateSchema.optional(),
});

const FlowerEvent = z.object({
  type: z.literal("flower"),
  seat: SeatSchema,
  tile: TileSchema.refine((tile) => tile.endsWith("f"), "Expected a flower"),
});

const DiscardEvent = z.object({
  type: z.literal("discard"),
  seat: SeatSchema,
  tile: TileSchema,
  tsumogiri: z.boolean(),
  /** Authoritative physical source; absent on legacy/external logs. */
  discardSource: z.enum(["hand", "draw"]).optional(),
  /** True when this discard was the riichi declaration tile. */
  riichi: z.boolean().optional(),
  /** Authoritative post-discard waits for the discarder, sourced from
   * the platform replay log (Majsoul `RecordDiscardTile.tingpais`).
   * Absent when the platform does not expose per-discard wait info
   * (Tenhou, Riichi City) — callers fall back to a shanten compute.
   * Empty array means the platform reported "not tenpai". */
  waits: z.array(TileSchema).optional(),
  duplicateWallState: DuplicateWallStateSchema.optional(),
});

const RyuukyokuDeclarationEvent = z
  .object({
    type: z.literal("ryuukyoku_declaration"),
    seat: SeatSchema,
    tenpai: z.boolean(),
    /** Public only when the seat declared tenpai. */
    hand: z.array(TileSchema).optional(),
  })
  .superRefine((event, context) => {
    if (!event.tenpai && event.hand !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["hand"],
        message: "A Noten declaration cannot reveal a hand",
      });
    }
  });

const MeldSchema = z.object({
  type: z.enum(["chi", "pon", "daiminkan", "ankan", "shouminkan"]),
  tiles: z.array(TileSchema),
  claimedTile: TileSchema.nullable(),
  from: SeatSchema.nullable(),
});
export type Meld = z.infer<typeof MeldSchema>;
const MeldSchemaInline = MeldSchema;

const WinEvent = z.object({
  type: z.literal("win"),
  seat: SeatSchema,
  /** Loser (discarder) for ron; null for tsumo. */
  loser: SeatSchema.nullable().optional(),
  /** Winning tile. */
  winTile: TileSchema.optional(),
  /** Total point delta for this winner (riichi-stick + honba bonuses
   * are folded into the multi-ron `hand_end` summary, not here). */
  delta: z.array(z.number().int()).min(3).max(4).optional(),
  /** Han / fu / total points / yakuman count from the score lib. */
  scoringFamily: z.enum(["riichi", "mcr"]).optional(),
  han: z.number().int().optional(),
  fu: z.number().int().optional(),
  ten: z.number().int().optional(),
  yakumanCount: z.number().int().optional(),
  /** Yaku name → "X飜" / "役満" string from the score lib. */
  yaku: z.record(z.string(), z.string()).optional(),
  /** Ordered MCR fan breakdown. */
  fan: z
    .array(
      z
        .object({
          id: z.string(),
          name: z.string(),
          count: z.number().int().positive(),
          points: z.number().int().nonnegative(),
        })
        .strict()
    )
    .optional(),
  totalFan: z.number().int().nonnegative().optional(),
  nonFlowerFan: z.number().int().nonnegative().optional(),
  /** Optional human-readable summary line. */
  scoreText: z.string().optional(),
  /** Concealed hand at win time (for the result panel). */
  hand: z.array(TileSchema).optional(),
  /** Open / concealed melds at win time. */
  melds: z.array(MeldSchemaInline).optional(),
  /** Dora / ura indicators revealed at win time. */
  doraIndicators: z.array(TileSchema).optional(),
  uraDoraIndicators: z.array(TileSchema).optional(),
  /**
   * Structured han breakdown for statistics, sourced from the platform's fan
   * list. These are COUNTS (han contributed), not indicator tiles, and exist
   * so a stats projection doesn't have to recompute dora from `doraIndicators`
   * + `hand` (which Riichi City can't even provide). Optional for back-compat
   * with replay logs archived before they were added.
   */
  /** Regular dora han (excludes red fives and ura-dora). */
  doraCount: z.number().int().nonnegative().optional(),
  /** Red-five (akadora) han. */
  akaDoraCount: z.number().int().nonnegative().optional(),
  /** Ura-dora han (riichi wins only). */
  uraDoraCount: z.number().int().nonnegative().optional(),
  /**
   * Yaku as platform-neutral `Han` enum ids (the same ids the per-platform
   * stat parsers emit into `GameRecord.roundEvents[].yakus`). Kept alongside
   * the display-oriented `yaku` record so a stats projection doesn't have to
   * reverse romaji names back into ids.
   */
  yakuHan: z.array(z.number().int()).optional(),
  /** Placeholder retained for backward compatibility. */
  points: z.number().int().optional(),
});

const HandEndEvent = z
  .object({
    type: z.literal("hand_end"),
    reason: z.enum(["exhaustive_draw", "ron", "tsumo", "abort"]),
    abortKind: z
      .enum(["kyuushuu", "suufon_renda", "suucha_riichi", "sanchahou"])
      .optional(),
    /** Combined per-seat point delta for this hand. */
    delta: z.array(z.number().int()).min(3).max(4).optional(),
    /** Per-seat tenpai status at exhaustive draw. */
    tenpai: z.array(z.boolean()).min(3).max(4).optional(),
    /**
     * Native in-app declaration sequence, ordered East through North.
     * Archived replay logs merge the four transient live declaration
     * events into this field. Legacy and platform replays omit it.
     */
    declarations: z
      .array(
        z.object({
          seat: SeatSchema,
          tenpai: z.boolean(),
        })
      )
      .min(3)
      .max(4)
      .optional(),
    /** Per-seat nagashi mangan flag at exhaustive draw. */
    nagashi: z.array(z.boolean()).min(3).max(4).optional(),
    /** Scores after this hand is settled. */
    scores: z.array(z.number().int()).min(3).max(4).optional(),
    /** Honba on this hand (the value used in payments). */
    honba: z.number().int().nonnegative().optional(),
    /** Riichi sticks on the table when the hand ended (pre-collection). */
    riichiSticks: z.number().int().nonnegative().optional(),
    /**
     * Per-seat wait tiles at hand end (length 4). `null` for seats
     * not tenpai (or when the source doesn't record waits). Used
     * by the replay `showWaits` overlay to render each tenpai
     * seat's wait set without recomputing on the client — the
     * server-recorded value is authoritative (accounts for open
     * melds, furiten, kuikae, etc., as far as the rules engine
     * knows about them).
     */
    waits: z.array(z.array(TileSchema).nullable()).min(3).max(4).optional(),
    /**
     * Per-seat full concealed hand revealed at hand end (length 4).
     * Populated for every tenpai seat when
     * `reason === "exhaustive_draw"`, or for just the declaring seat
     * when `reason === "abort"` and `abortKind === "kyuushuu"`;
     * `null` for seats that don't reveal. Lets the renderer flip the
     * revealed hand(s) face-up at their seat band — the tenpai
     * player's wait shape at a draw, or the ≥9 terminals/honors that
     * justified a kyuushuu abort.
     */
    tenpaiHands: z
      .array(z.array(TileSchema).nullable())
      .min(3)
      .max(4)
      .optional(),
    /**
     * Buu Mahjong chip delta for this hand (winner gain + sinker
     * losses). Sums to zero. Omitted when `ruleSet.buuMode` is off.
     */
    chipDelta: z.array(z.number().int()).min(3).max(4).optional(),
    /** Number of sinking seats (winner excluded) at hand-end. */
    sinkingCount: z.number().int().min(0).max(3).optional(),
    /** True iff this hand consumed the winner's dabuken token. */
    dabukenConsumed: z.boolean().optional(),
    /** True iff this hand awarded a dabuken to the winner. */
    dabukenAwarded: z.boolean().optional(),
    /**
     * Buu Mahjong absolute chip totals AFTER this hand's
     * chipDelta has been applied. Lets the client refresh the
     * player-nameplate chip counters immediately on hand_end
     * without recomputing from chipDelta. Omitted for non-Buu.
     */
    chips: z.array(z.number().int()).min(3).max(4).optional(),
    /**
     * Buu Mahjong per-seat dabuken token state AFTER this hand's
     * award / clearing has been applied. Lets the client refresh
     * the dabuken token overlay immediately on hand_end. Omitted
     * for non-Buu.
     */
    dabuken: z.array(z.boolean()).min(3).max(4).optional(),
  })
  .superRefine((event, context) => {
    if (event.declarations === undefined) {
      return;
    }
    if (event.reason !== "exhaustive_draw") {
      context.addIssue({
        code: "custom",
        path: ["declarations"],
        message: "Declarations are valid only on an exhaustive draw",
      });
      return;
    }
    const seats = new Set(event.declarations.map(({ seat }) => seat));
    const count = event.tenpai?.length ?? event.scores?.length ?? 4;
    if (
      seats.size !== count ||
      event.declarations.length !== count ||
      event.declarations.some(({ seat }) => seat >= count)
    ) {
      context.addIssue({
        code: "custom",
        path: ["declarations"],
        message: "Declarations must contain every seat exactly once",
      });
    }
    if (
      event.tenpai !== undefined &&
      event.declarations.some(
        ({ seat, tenpai }) => event.tenpai?.[seat] !== tenpai
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["declarations"],
        message: "Declarations must match the settled tenpai tuple",
      });
    }
  });

const BuuChomboEvent = z.object({
  type: z.literal("buu_chombo"),
  seat: SeatSchema,
  reason: z.enum([
    "sinking_win_not_floating",
    "game_ending_win_not_first",
    "game_ending_chinmai",
  ]),
  chipDelta: z.array(z.number().int()).min(3).max(4),
  /** In-game chip totals AFTER the penalty has been applied
   * (sums need not equal zero — these are running totals, not a
   * delta). Lets the result panel show each seat's chip stack
   * alongside the chombo penalty. */
  chips: z.array(z.number().int()).min(3).max(4),
});

const CallEvent = z.object({
  type: z.literal("call"),
  seat: SeatSchema,
  meld: MeldSchema,
  duplicateWallState: DuplicateWallStateSchema.optional(),
});

const NewDoraEvent = z.object({
  type: z.literal("new_dora"),
  indicator: TileSchema,
});

/**
 * Per-seat furiten transition. Emitted by the game-server whenever
 * the engine's `isFuritenForRon(state, seat)` predicate flips
 * value (set or unset) for any seat. Drives the UI's "Furiten"
 * indicator without forcing the client to recompute waits /
 * scoreHand probes itself.
 */
const FuritenEvent = z.object({
  type: z.literal("furiten"),
  seat: SeatSchema,
  active: z.boolean(),
});

const MatchEndEvent = z.object({
  type: z.literal("match_end"),
  reason: z.enum([
    "round_limit",
    "busted",
    "agari_yame",
    "tenpai_yame",
    "winner_threshold",
  ]),
  finalScores: z.array(
    z.object({
      seat: SeatSchema,
      score: z.number().int(),
      place: z.number().int().min(1).max(4),
    })
  ),
  /** Session-level chip totals after this game (Buu only). */
  chips: z.array(z.number().int()).min(3).max(4).optional(),
  /** Session-level dabuken state after this game (Buu only). */
  dabuken: z.array(z.boolean()).min(3).max(4).optional(),
  /**
   * Per-seat chip delta for THIS game only (post-game chip total
   * minus the snapshot taken at game start). Buu-only — shown
   * next to each player's final score in the end-of-game panel.
   */
  chipsDelta: z.array(z.number().int()).min(3).max(4).optional(),
  /** Zero-based index of this game within its session (Buu only). */
  gameIndex: z.number().int().nonnegative().optional(),
});

/**
 * Buu session: continue-vote window opened after a game ends.
 * Sent once, followed by zero or more `session_vote_update` frames
 * as seats cast their vote, and ultimately followed by either a
 * fresh `match_start` (unanimous yes → next game) or a
 * `session_end` (any no / timeout). Bots are pre-voted server-side.
 */
const SessionVoteOpenEvent = z.object({
  type: z.literal("session_vote_open"),
  /** Unix ms; auto-resolves as "no" for any seat still unset at this time. */
  deadline: z.number().int(),
  /** Per-seat vote state. `null` means undecided. */
  votes: seatValuesSchema(z.enum(["yes", "no"]).nullable()),
  /** Zero-based index of the just-finished game. */
  gameIndex: z.number().int().nonnegative(),
});

const SessionVoteUpdateEvent = z.object({
  type: z.literal("session_vote_update"),
  votes: seatValuesSchema(z.enum(["yes", "no"]).nullable()),
});

/**
 * Buu session: terminal frame emitted when the session is fully
 * over (any "no" vote, vote timeout, or non-Buu single-game match).
 * For non-Buu matches this is emitted immediately after
 * `match_end` with `gamesPlayed: 1`. Carries the final session-
 * level summary (cumulative chip totals + per-game final scores).
 */
const SessionEndEvent = z.object({
  type: z.literal("session_end"),
  reason: z.enum(["vote_no", "vote_timeout", "single_game", "server_abort"]),
  gamesPlayed: z.number().int().positive(),
  /** Cumulative chip totals per seat (Buu only; all zero for non-Buu). */
  chips: z.array(z.number().int()).min(3).max(4),
});

/**
 * Mid-hand refresh of the per-seat sinking flag. Currently the
 * server only emits this after a riichi declaration (the one
 * in-hand event whose 1000-point deduction can push a seat
 * across `rs.sinkThreshold`). The `hand_start` event carries
 * the post-payout view at every round boundary, so this event
 * is sufficient to keep the client view in sync. Buu only.
 */
const SinkingUpdateEvent = z.object({
  type: z.literal("sinking_update"),
  sinking: seatValuesSchema(z.boolean()),
});

export const GameEventSchema = z.discriminatedUnion("type", [
  MatchStartEvent,
  HandStartEvent,
  DrawEvent,
  NukiEvent,
  FlowerEvent,
  DiscardEvent,
  RyuukyokuDeclarationEvent,
  CallEvent,
  WinEvent,
  HandEndEvent,
  NewDoraEvent,
  MatchEndEvent,
  FuritenEvent,
  BuuChomboEvent,
  SessionVoteOpenEvent,
  SessionVoteUpdateEvent,
  SessionEndEvent,
  SinkingUpdateEvent,
]);
export type GameEvent = z.infer<typeof GameEventSchema>;

// ---------------------------------------------------------------------------
// Actions (client → server, echoed by id)
// ---------------------------------------------------------------------------

/**
 * Server-supplied legal action descriptor. Client echoes `id`; cannot
 * fabricate actions, so illegal moves are impossible by construction.
 *
 * Call legal actions (`chi`/`pon`/`kan`/`ron`) are surfaced after a
 * discard when the recipient seat can call on it. The companion
 * `pass` action declines the call window. For `kan`, `kanKind`
 * distinguishes `daiminkan` (after a discard) from `ankan`/
 * `shouminkan` (self-call on own turn).
 */
export const LegalActionSchema = z.object({
  id: z.string(),
  type: z.enum([
    "draw",
    "discard",
    "pass",
    "win",
    "chi",
    "pon",
    "kan",
    "nuki",
    "ron",
    "tsumo",
    "riichi",
    "declare_tenpai",
    "declare_noten",
  ]),
  tile: TileSchema.optional(),
  /** Physical copy selected for discard when tile values are identical. */
  discardSource: z.enum(["hand", "draw"]).optional(),
  /** Caller's contributed tiles for chi/pon/daiminkan. */
  tiles: z.array(TileSchema).optional(),
  /** Disambiguates kan flavor when `type === "kan"`. */
  kanKind: z.enum(["daiminkan", "ankan", "shouminkan"]).optional(),
});
export type LegalAction = z.infer<typeof LegalActionSchema>;

// ---------------------------------------------------------------------------
// Server → client messages
// ---------------------------------------------------------------------------

/**
 * Recipient-projected match state attached to `snapshot` messages.
 *
 * Mirrors the public-facing slice of `MatchState` exposed by
 * `MatchProcess.buildSnapshotForHuman`. Opponent hand tiles are
 * redacted to `null`; everything else is per-recipient public.
 */
export const SnapshotStateSchema = z
  .object({
    ...GameVariantMetadata,
    nukiTiles: z.array(z.array(TileSchema)).min(3).max(4).optional(),
    flowerTiles: z.array(z.array(TileSchema)).length(4).optional(),
    sanmaWall: SanmaWallStateSchema.optional(),
    deadWall: z.array(TileSchema).optional(),
    pendingNuki: z
      .object({
        seat: SeatSchema,
        tile: TileSchema,
        opening: z.boolean(),
      })
      .nullable()
      .optional(),
    pendingFlower: z
      .object({
        seat: SeatSchema,
        tile: TileSchema,
      })
      .nullable()
      .optional(),
    /** Recipient's own seat, or `null` for a spectator view (all
     * hands hidden, no own-hand re-attach on `hand_start`). */
    mySeat: SeatSchema.nullable(),
    hands: z.array(z.array(TileSchema.nullable())).min(3).max(4),
    discards: z.array(z.array(TileSchema)).min(3).max(4),
    /** Per-discard tsumogiri flags, parallel to `discards`. Optional for
     * compatibility with snapshots produced by older game servers. */
    discardTsumogiri: z.array(z.array(z.boolean())).min(3).max(4).optional(),
    melds: z.array(z.array(MeldSchema)).min(3).max(4),
    wallRemaining: z.number().int().nonnegative(),
    duplicateWallState: DuplicateWallStateSchema.optional(),
    /** Number of post-deal draws this hand, including rinshan draws.
     * Each kan transfers one live-wall tile into the dead wall, so this
     * equals `70 - wallRemaining`. Used by the renderer to shrink the
     * wall and infer how many rinshan tiles were consumed alongside
     * `liveDrawsTaken`. Optional for back-compat with older snapshots. */
    drawsTaken: z.number().int().nonnegative().optional(),
    doraIndicators: z.array(TileSchema),
    turn: SeatSchema,
    /** Seat whose rightmost concealed tile is a fresh draw. Null after
     * chi/pon, even though that caller is also awaiting a discard.
     * Optional for compatibility with older game servers. */
    freshlyDrawnSeat: SeatSchema.nullable().optional(),
    dealer: SeatSchema,
    roundWind: z.enum(["E", "S", "W", "N"]),
    roundNumber: z.number().int().positive(),
    honba: z.number().int().nonnegative(),
    riichiSticks: z.number().int().nonnegative(),
    scores: z.array(z.number().int()).min(3).max(4),
    /**
     * Per-seat "sinking" flag (same semantics as
     * `HandStartEvent.sinking`). Optional for back-compat with
     * snapshots captured before this field existed; absent ==
     * all-false on the client side.
     */
    sinking: z.array(z.boolean()).min(3).max(4).optional(),
    /**
     * Per-seat in-game chip totals (Buu only; absent / treated as
     * `[0, 0, 0, 0]` outside Buu).
     */
    chips: z.array(z.number().int()).min(3).max(4).optional(),
    /**
     * Per-seat dabuken (double-chip token) state (Buu only; absent
     * / treated as `[false, false, false, false]` outside Buu).
     */
    dabuken: z.array(z.boolean()).min(3).max(4).optional(),
    /**
     * Active score-cap tier from the rule set, if any. Mirrors
     * `RuleSet.scoreCap`. Needed on snapshots so a spectator
     * (or a player reconnecting mid-match) can render capped han
     * labels without having received the original `match_start`.
     */
    scoreCap: z
      .enum(["mangan", "haneman", "baiman", "sanbaiman"])
      .nullable()
      .optional(),
    /**
     * Point value of a single riichi stick (`RuleSet.riichiBetValue`).
     * Needed on snapshots so a reconnecting client or spectator can
     * apply the optimistic riichi-bet deduction with the correct
     * amount without having received the original `match_start`.
     * Optional for back-compat — absent ⇒ assume 1000 (standard
     * riichi).
     */
    riichiBetValue: z.number().int().positive().optional(),
    /** Whether ura dora is enabled by the active rule set. */
    uraDoraEnabled: z.boolean().optional(),
    riichiDeclared: z.array(z.boolean()).min(3).max(4),
    /** Per-seat index into `discards[seat]` of the riichi declaration
     * tile (null when that seat has not declared riichi). */
    riichiTileIdx: z
      .array(z.number().int().nonnegative().nullable())
      .min(3)
      .max(4)
      .optional(),
    lastDiscard: z.object({ seat: SeatSchema, tile: TileSchema }).nullable(),
    phase: z.string(),
    /**
     * Public declarations already completed in the current exhaustive-draw
     * sequence. Optional outside that sequence and for older snapshots.
     */
    ryuukyokuDeclarations: NullableBooleanTupleSchema.optional(),
    /**
     * Per-seat concealed hands made public by a Tenpai declaration. A Noten or
     * not-yet-declared seat remains null. Optional for older snapshots.
     */
    ryuukyokuTenpaiHands: NullableHandTupleSchema.optional(),
    /**
     * Settled exhaustive-draw result for a player reconnecting during the
     * post-hand ready window. Native declaration matches populate this so the
     * draw panel and public hand reveals survive snapshot hydration.
     */
    lastHandResult: HandEndEvent.optional(),
    sessionVote: z
      .object({
        deadline: z.number().int(),
        votes: seatValuesSchema(z.enum(["yes", "no"]).nullable()),
        gameIndex: z.number().int().nonnegative(),
      })
      .nullable()
      .optional(),
    /** Dice rolled at the start of the current hand; `null` when
     * unknown (synthetic snapshots / older replays). */
    dice: z
      .tuple([z.number().int().min(1).max(6), z.number().int().min(1).max(6)])
      .nullable()
      .optional(),
    /** Per-seat furiten state at snapshot time. Only the recipient's
     * own slot is truthful; opponent slots are always `false`
     * because furiten is private (it leaks that an opponent passed
     * on a ron-wait). Optional for back-compat with snapshots
     * captured before this field existed. */
    furiten: z.array(z.boolean()).min(3).max(4).optional(),
    /** Omniscient starting live wall (70 tiles in draw order) for
     * the current hand. Only present on spectator snapshots, and
     * only after the first `hand_start` of the match has been
     * emitted. Powers the renderer's `showWalls` overlay when a
     * spectator joins mid-hand — without this the wall reveal only
     * works after the next round starts (because it's normally
     * threaded in via `hand_start`'s archival fields). */
    liveWall: z.array(TileSchema).optional(),
    /** Number of tiles drawn from `liveWall` since the current
     * hand began (excludes rinshan replacement draws when the
     * server tracks them separately; in this build the engine
     * doesn't distinguish, so this is `handStartLiveWall.length −
     * state.liveWall.length`). Mirrors `MatchView.liveDrawsTaken`;
     * the renderer uses it to hide positions already taken off
     * the wall. Optional — only present alongside `liveWall`. */
    liveDrawsTaken: z.number().int().nonnegative().optional(),
    /** Display names for each seat in absolute-seat order. Optional
     * for back-compat with older snapshots / replays — the renderer
     * falls back to `Player N` placeholders when absent. Populated
     * by the server so a reconnecting human (or a spectator joining
     * mid-match) sees the correct player names + HUD chips without
     * having to wait for a fresh `match_start` event. */
    seatNames: z.array(z.string()).min(3).max(4).optional(),
  })
  .superRefine((state, context) => {
    const count = refineParticipantArrays(
      state,
      {
        hands: state.hands,
        discards: state.discards,
        discardTsumogiri: state.discardTsumogiri,
        melds: state.melds,
        scores: state.scores,
        riichiDeclared: state.riichiDeclared,
        nukiTiles: state.nukiTiles,
        seatNames: state.seatNames,
        furiten: state.furiten,
        chips: state.chips,
        dabuken: state.dabuken,
        sinking: state.sinking,
        riichiTileIdx: state.riichiTileIdx,
        ryuukyokuDeclarations: state.ryuukyokuDeclarations,
        ryuukyokuTenpaiHands: state.ryuukyokuTenpaiHands,
      },
      context
    );
    for (const [field, seat] of [
      ["mySeat", state.mySeat],
      ["turn", state.turn],
      ["dealer", state.dealer],
      ["pendingNuki", state.pendingNuki?.seat ?? null],
    ] as const) {
      if (seat !== null && !isActiveSeat(seat, count)) {
        context.addIssue({
          code: "custom",
          path: [field],
          message: "Seat is not an active participant",
        });
      }
    }
  });
export type SnapshotState = z.infer<typeof SnapshotStateSchema>;

const SnapshotMsg = z.object({
  type: z.literal("snapshot"),
  seq: z.number().int().nonnegative(),
  state: SnapshotStateSchema,
  legalActions: z.array(LegalActionSchema),
  /** Unix ms; client uses this for the action timer. Optional in slice. */
  deadline: z.number().int().optional(),
  /**
   * Milliseconds of "think buffer" the human has left for the
   * current hand, on top of the base per-action budget encoded
   * in `deadline`. Driven by the server; renders as the
   * second component of the bottom-left timer ("X + Y"). Refills
   * to the per-hand allowance at every `hand_start`.
   */
  bufferMs: z.number().int().nonnegative().optional(),
  clock: ClockStampSchema.optional(),
  actionWindow: ActionWindowViewSchema.nullable().optional(),
  presentation: PresentationContextSchema.optional(),
  promptWindow: ActionWindowViewSchema.nullable().optional(),
});

const EventMsg = z.object({
  type: z.literal("event"),
  seq: z.number().int().nonnegative(),
  events: z.array(GameEventSchema),
  legalActions: z.array(LegalActionSchema),
  deadline: z.number().int().optional(),
  /** See `SnapshotMsg.bufferMs`. */
  bufferMs: z.number().int().nonnegative().optional(),
  clock: ClockStampSchema.optional(),
  actionWindow: ActionWindowViewSchema.nullable().optional(),
  presentation: PresentationContextSchema.optional(),
  promptWindow: ActionWindowViewSchema.nullable().optional(),
});

const ErrorMsg = z.object({
  type: z.literal("error"),
  code: z.string(),
  message: z.string(),
});

const SessionReplacedMsg = z.object({
  type: z.literal("session_replaced"),
  matchId: z.string(),
  message: z.string(),
});

/**
 * Pre-match ready check. Sent once after `match_start` and re-
 * sent every time a seat acks. The match's first hand only
 * begins once all seats are acked or the deadline elapses
 * (whichever first). Bots are pre-acked server-side so the
 * panel only blocks on the human.
 */
const ReadyCheckMsg = z.object({
  type: z.literal("ready_check"),
  /** Unix ms; mirrors `SnapshotMsg.deadline`. */
  deadline: z.number().int(),
  /** Per-seat ack state, indexed 0..3 absolute seat order. */
  acked: seatValuesSchema(z.boolean()),
  clock: ClockStampSchema.optional(),
  window: ActionWindowViewSchema.nullable().optional(),
});

/**
 * Sent once when the ready check is over (everyone acked or
 * the deadline elapsed). Clears the client overlay.
 */
const ReadyCheckEndMsg = z.object({
  type: z.literal("ready_check_end"),
});

/**
 * Room membership snapshot for a multi-human match.
 *
 * Phase 5 unifies "room" and "match": a match lives in `waiting`
 * status until the first seated human sends `start_match` after
 * every connected human has readied, at which point the server
 * fills empty seats with bots and flips to `playing`. The client
 * uses `room_state` to render the waiting
 * room (seat list, "Start" button) and to receive the post-start
 * confirmation (status → `playing`) just before the first
 * `snapshot` arrives.
 *
 * Re-sent every time membership changes (join, leave, bot-fill,
 * disconnect/reconnect) and once on every fresh attach so the
 * client never has to guess seat layout.
 */
export const RoomSeatOccupantSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("empty") }),
  z.object({
    kind: z.literal("human"),
    userId: z.string(),
    displayName: z.string(),
    /** True when the human's socket is currently connected. A
     * playing seat remains reserved after disconnect; waiting-room
     * disconnects remove the occupant instead. */
    connected: z.boolean(),
  }),
  z.object({
    kind: z.literal("bot"),
    userId: z.string(),
    displayName: z.string(),
  }),
]);
export type RoomSeatOccupant = z.infer<typeof RoomSeatOccupantSchema>;

const RoomSeatSchema = z.object({
  seat: SeatSchema,
  occupant: RoomSeatOccupantSchema,
  /** Bots are always ready. Human readiness is false while disconnected. */
  ready: z.boolean(),
});

/**
 * Application-level keepalive. Emitted by the server on the
 * heartbeat tick (in addition to the WS protocol PING) so the
 * browser client's stall watchdog — which can only see
 * application frames, never protocol pongs — knows the link
 * is still alive during quiet periods (e.g., a player thinking
 * for minutes between turns). Carries the server timestamp for
 * diagnostics.
 */
const KeepaliveMsg = z.object({
  type: z.literal("keepalive"),
  t: z.number(),
});
export type Keepalive = z.infer<typeof KeepaliveMsg>;

const RoomStateMsg = z
  .object({
    ...GameVariantMetadata,
    type: z.literal("room_state"),
    matchId: z.string(),
    /** Match-driving mode. Absent legacy frames are normal mode. */
    mode: MatchModeConfigSchema.optional(),
    spectatorDelayMs: SpectatorDelayMsSchema.optional(),
    clock: ClockStampSchema.optional(),
    /** Lifecycle: `waiting` = pre-start; `playing` = match running;
     * `finished` = match ended (post-game lobby). */
    status: z.enum(["waiting", "playing", "finished"]),
    /** Recipient's own seat assignment, or `null` for a spectator
     * (no available seat at attach time). */
    mySeat: SeatSchema.nullable(),
    /** First seated human. Only this seat may manage or start the room. */
    hostSeat: SeatSchema.nullable(),
    /** True when every seated human is connected and ready. */
    canStart: z.boolean(),
    /** All four seat slots, always present, ordered 0..3. */
    seats: z.array(RoomSeatSchema).min(3).max(4),
  })
  .superRefine((room, context) => {
    const count = refineParticipantArrays(room, { seats: room.seats }, context);
    if (
      new Set(room.seats.map((seat) => seat.seat)).size !== count ||
      room.seats.some(({ seat }) => !isActiveSeat(seat, count))
    ) {
      context.addIssue({
        code: "custom",
        path: ["seats"],
        message: "Room must identify every active seat exactly once",
      });
    }
    for (const [field, seat] of [
      ["mySeat", room.mySeat],
      ["hostSeat", room.hostSeat],
    ] as const) {
      if (seat !== null && !isActiveSeat(seat, count)) {
        context.addIssue({
          code: "custom",
          path: [field],
          message: "Seat is not an active participant",
        });
      }
    }
  });
export type RoomState = z.infer<typeof RoomStateMsg>;

/** Tells a removed human client to leave the match route immediately. */
const RoomKickedMsg = z.object({
  type: z.literal("room_kicked"),
  matchId: z.string(),
});

/** Directs a non-seated joiner from the match route to live spectating. */
const SpectateRedirectMsg = z.object({
  type: z.literal("spectate_redirect"),
  matchId: z.string(),
});

/** Confirms the enforced delay without exposing current game state. */
const SpectatorConfigMsg = z.object({
  type: z.literal("spectator_config"),
  matchId: z.string(),
  delayMs: z.number().int().nonnegative(),
  presentationOffsetMs: z.number().int().nonnegative().optional(),
  clock: ClockStampSchema.optional(),
});

export const ViewerPresenceSchema = z.object({
  userId: z.string(),
  displayName: z.string(),
  role: z.enum(["player", "spectator"]),
  /** Spectator stream delay. Zero/absent means live watching. */
  delayMs: z.number().int().nonnegative().optional(),
});
export type ViewerPresence = z.infer<typeof ViewerPresenceSchema>;

/**
 * Ephemeral connected-viewer presence. This is deliberately a server
 * message rather than a `GameEvent`: clients display it live, but it is
 * never appended to match history or persisted in replay logs.
 */
const ViewerStateMsg = z.object({
  type: z.literal("viewer_state"),
  viewers: z.array(ViewerPresenceSchema),
});

export const ServerMessageSchema = z.discriminatedUnion("type", [
  SnapshotMsg,
  EventMsg,
  ErrorMsg,
  ReadyCheckMsg,
  ReadyCheckEndMsg,
  RoomStateMsg,
  RoomKickedMsg,
  SpectateRedirectMsg,
  SpectatorConfigMsg,
  SessionReplacedMsg,
  ViewerStateMsg,
  KeepaliveMsg,
  ClockSampleSchema,
  LatencyProbeSchema,
]);
export type ServerMessage = z.infer<typeof ServerMessageSchema>;

// ---------------------------------------------------------------------------
// Client → server messages
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Debug seeding (optional, included in `hello`)
// ---------------------------------------------------------------------------

/**
 * Match-debug seed sent in the `hello` frame on first attach. Lets the
 * tester force seat 0's starting hand, the next tiles seat 0 will draw,
 * and the next tiles the left-side bot (seat 3) will discard.
 *
 * The debug seed is intentionally lax — duplicate tiles beyond 4 of a
 * kind, hand sizes other than 13, etc. are all accepted; the server
 * applies them as-is. This is a developer surface, not a player one.
 */
export const MatchDebugSchema = z
  .object({
    humanHand: z.array(TileSchema).optional(),
    humanDraws: z.array(TileSchema).optional(),
    leftDiscards: z.array(TileSchema).optional(),
  })
  .optional();
export type MatchDebug = z.infer<typeof MatchDebugSchema>;

export const ClientSessionIdSchema = z
  .string()
  .min(16)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);

const HelloMsg = z.object({
  type: z.literal("hello"),
  token: z.string(),
  matchId: z.string(),
  /** Opaque transport-owner identifier. Required by the server for
   * player connections and ignored for spectators. */
  clientSessionId: ClientSessionIdSchema.optional(),
  timingCapabilities: z.array(z.literal(TIMING_CAPABILITY)).max(1).optional(),
  fixedPromptVersion: z.literal(FIXED_PROMPT_VERSION).optional(),
  gameCapabilities: z.array(z.literal(SANMA_CAPABILITY)).max(1).optional(),
  /** Separate field keeps the legacy SANMA capability array backward-compatible. */
  mcrCapability: z.literal(MCR_CAPABILITY).optional(),
  /** One-shot permission to replace a different client session
   * currently owning this user's seat. */
  takeover: z.boolean().optional(),
  debug: MatchDebugSchema,
  /** When true, the client wants to spectate (read-only public
   * view) instead of claiming a seat. The server refuses spectate
   * for matches not in `playing` status. */
  spectate: z.boolean().optional(),
  /** Optional dispatch delay (ms) for spectators. When > 0 the
   * server holds each public event until `emittedAt + delayMs`
   * elapses (~5 min in production) so a delayed watcher can't
   * relay live info to a player. Ignored unless `spectate` is
   * true. */
  delayMs: z.number().int().nonnegative().optional(),
});

const ActMsg = z.object({
  type: z.literal("act"),
  matchId: z.string(),
  actionId: z.string(),
  windowId: z.string().min(1).max(256).optional(),
  clockEpoch: z.string().min(1).max(128).optional(),
  stateSeq: z.number().int().nonnegative().optional(),
});

const ResyncMsg = z.object({
  type: z.literal("resync"),
  matchId: z.string(),
  lastSeq: z.number().int().nonnegative(),
});

/**
 * Human ack for the pre-match ready check. Bots are pre-acked
 * server-side; this is the only way the human signals "go".
 */
const ReadyMsg = z.object({
  type: z.literal("ready"),
  matchId: z.string(),
  windowId: z.string().min(1).max(256).optional(),
  clockEpoch: z.string().min(1).max(128).optional(),
});

/**
 * Request to start the match. Only the first seated human may send
 * this while every connected human is ready. The server fills any
 * empty seat with a bot, broadcasts a final `room_state` with
 * `status: "playing"`, and then begins the normal match flow.
 *
 * Rejected with an `error` frame if the sender is not a seated
 * human or if the room is no longer in `waiting`.
 */
const StartMatchMsg = z.object({
  type: z.literal("start_match"),
  matchId: z.string(),
});

/** Toggle the sender's pre-match waiting-room readiness. */
const SetRoomReadyMsg = z.object({
  type: z.literal("set_room_ready"),
  matchId: z.string(),
  ready: z.boolean(),
});

/** Host-only request to fill one empty waiting-room slot with a bot. */
const AddBotMsg = z.object({
  type: z.literal("add_bot"),
  matchId: z.string(),
});

/** Host-only request to remove a human or bot from a waiting-room slot. */
const KickSeatMsg = z.object({
  type: z.literal("kick_seat"),
  matchId: z.string(),
  seat: SeatSchema,
});

/**
 * Release the sender's seat. Only valid while the room is in
 * `waiting` status — once the match starts, a human can
 * disconnect (their seat is held for reconnection) but cannot
 * permanently leave mid-match. The server broadcasts the
 * resulting `room_state`.
 */
const LeaveSeatMsg = z.object({
  type: z.literal("leave_seat"),
  matchId: z.string(),
});

/**
 * Self-reported AFK status. The client sends `afk: true` after a
 * 25s idle window on its own call/discard prompt (no click input);
 * the server durably records the sticky flag together with that
 * window's safe default before applying either. Future unavailable
 * windows retain short resumable auto-default deadlines until the
 * user clicks the "Reconnect" overlay, which sends `afk: false`.
 */
const AfkMsg = z.object({
  type: z.literal("afk"),
  matchId: z.string(),
  afk: z.boolean(),
});

/**
 * Cast a Buu session continue-vote. Sent in response to a
 * `session_vote_open` event. The server ignores the message
 * outside an open vote window. Any seat may change its vote
 * (yes ↔ no) until the window closes; once unanimous yes is
 * reached the next game starts and further messages are
 * ignored until the next `session_vote_open`.
 */
const VoteContinueMsg = z.object({
  type: z.literal("vote_continue"),
  matchId: z.string(),
  vote: z.enum(["yes", "no"]),
  windowId: z.string().min(1).max(256).optional(),
  clockEpoch: z.string().min(1).max(128).optional(),
});

export const ClientMessageSchema = z.discriminatedUnion("type", [
  HelloMsg,
  ActMsg,
  ResyncMsg,
  ReadyMsg,
  SetRoomReadyMsg,
  StartMatchMsg,
  AddBotMsg,
  KickSeatMsg,
  LeaveSeatMsg,
  AfkMsg,
  VoteContinueMsg,
  ClockProbeSchema,
  LatencyReplySchema,
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;
