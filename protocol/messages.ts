import { z } from "zod";

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
export const TileSchema = z.string().regex(/^([0-9][mps]|[1-7]z)$/);
export type Tile = z.infer<typeof TileSchema>;

const SeatSchema = z.union([
  z.literal(0),
  z.literal(1),
  z.literal(2),
  z.literal(3),
]);
export type Seat = z.infer<typeof SeatSchema>;

// ---------------------------------------------------------------------------
// Events (server → client, embedded in `snapshot` and `event` messages)
// ---------------------------------------------------------------------------

const MatchStartEvent = z.object({
  type: z.literal("match_start"),
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
  chips: z.array(z.number().int()).length(4).optional(),
  /** Per-seat dabuken token state at match start (Buu only). */
  dabuken: z.array(z.boolean()).length(4).optional(),
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
});

const HandStartEvent = z.object({
  type: z.literal("hand_start"),
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
  scores: z.array(z.number().int()).length(4).optional(),
  /**
   * Per-seat "sinking" flag at hand start under the active rule
   * set. A sinking seat has `score <= rs.sinkThreshold`; the
   * renderer paints its centre-square score in red. Omitted
   * when the rule set has no notion of sinking (non-Buu); the
   * client treats absence as `[false, false, false, false]`.
   */
  sinking: z.array(z.boolean()).length(4).optional(),
  /**
   * Per-seat in-game chip totals at hand start. Buu only — non-Buu
   * matches omit the field and the client treats absence as
   * `[0, 0, 0, 0]`. Carries the session-level chip ledger into
   * each game so the live player-name boxes can display the
   * current chip count.
   */
  chips: z.array(z.number().int()).length(4).optional(),
  /**
   * Per-seat dabuken (double-chip token) state at hand start.
   * Buu only — non-Buu matches omit the field and the client
   * treats absence as `[false, false, false, false]`.
   */
  dabuken: z.array(z.boolean()).length(4).optional(),
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
  startingHands: z.array(z.array(TileSchema)).length(4).optional(),
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
  liveWall: z.array(TileSchema).length(70).optional(),
  /**
   * Omniscient dead wall snapshot in Tenhou yama-index order —
   * the 14 tiles never drawn during normal play (4 rinshan + dora
   * + ura-dora + 4 kan-dora + 4 ura-kan-dora). Index 5 is the
   * standard dora indicator, index 4 the standard ura-dora.
   * Physical mapping in the renderer is
   * `deadWall[idxFromBreak * 2 + row]` (row 1 = upper / public,
   * row 0 = lower / hidden). Optional on the wire — opponents
   * stay blind during live play — and only populated by replay
   * adapters that can regenerate it deterministically (currently
   * Tenhou XML logs via the SHUFFLE seed). Drives the
   * `showWalls` overlay's dead-wall reveal.
   */
  deadWall: z.array(TileSchema).length(14).optional(),
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
});

const DiscardEvent = z.object({
  type: z.literal("discard"),
  seat: SeatSchema,
  tile: TileSchema,
  tsumogiri: z.boolean(),
  /** True when this discard was the riichi declaration tile. */
  riichi: z.boolean().optional(),
  /** Authoritative post-discard waits for the discarder, sourced from
   * the platform replay log (Majsoul `RecordDiscardTile.tingpais`).
   * Absent when the platform does not expose per-discard wait info
   * (Tenhou, Riichi City) — callers fall back to a shanten compute.
   * Empty array means the platform reported "not tenpai". */
  waits: z.array(TileSchema).optional(),
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
  delta: z.array(z.number().int()).length(4).optional(),
  /** Han / fu / total points / yakuman count from the score lib. */
  han: z.number().int().optional(),
  fu: z.number().int().optional(),
  ten: z.number().int().optional(),
  yakumanCount: z.number().int().optional(),
  /** Yaku name → "X飜" / "役満" string from the score lib. */
  yaku: z.record(z.string(), z.string()).optional(),
  /** Optional human-readable summary line. */
  scoreText: z.string().optional(),
  /** Concealed hand at win time (for the result panel). */
  hand: z.array(TileSchema).optional(),
  /** Open / concealed melds at win time. */
  melds: z.array(MeldSchemaInline).optional(),
  /** Dora / ura indicators revealed at win time. */
  doraIndicators: z.array(TileSchema).optional(),
  uraDoraIndicators: z.array(TileSchema).optional(),
  /** Placeholder retained for backward compatibility. */
  points: z.number().int().optional(),
});

const HandEndEvent = z.object({
  type: z.literal("hand_end"),
  reason: z.enum(["exhaustive_draw", "ron", "tsumo", "abort"]),
  abortKind: z
    .enum(["kyuushuu", "suufon_renda", "suucha_riichi", "sanchahou"])
    .optional(),
  /** Combined per-seat point delta for this hand. */
  delta: z.array(z.number().int()).length(4).optional(),
  /** Per-seat tenpai status at exhaustive draw. */
  tenpai: z.array(z.boolean()).length(4).optional(),
  /** Per-seat nagashi mangan flag at exhaustive draw. */
  nagashi: z.array(z.boolean()).length(4).optional(),
  /** Scores after this hand is settled. */
  scores: z.array(z.number().int()).length(4).optional(),
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
  waits: z.array(z.array(TileSchema).nullable()).length(4).optional(),
  /**
   * Per-seat full concealed hand at exhaustive draw (length 4).
   * Populated only when `reason === "exhaustive_draw"` and the
   * seat was tenpai; `null` for non-tenpai seats. Lets the
   * result panel reveal the winning structure each tenpai
   * player was waiting on.
   */
  tenpaiHands: z.array(z.array(TileSchema).nullable()).length(4).optional(),
  /**
   * Buu Mahjong chip delta for this hand (winner gain + sinker
   * losses). Sums to zero. Omitted when `ruleSet.buuMode` is off.
   */
  chipDelta: z.array(z.number().int()).length(4).optional(),
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
  chips: z.array(z.number().int()).length(4).optional(),
  /**
   * Buu Mahjong per-seat dabuken token state AFTER this hand's
   * award / clearing has been applied. Lets the client refresh
   * the dabuken token overlay immediately on hand_end. Omitted
   * for non-Buu.
   */
  dabuken: z.array(z.boolean()).length(4).optional(),
});

const BuuChomboEvent = z.object({
  type: z.literal("buu_chombo"),
  seat: SeatSchema,
  reason: z.enum([
    "sinking_win_not_floating",
    "game_ending_win_not_first",
    "game_ending_chinmai",
  ]),
  chipDelta: z.array(z.number().int()).length(4),
  /** In-game chip totals AFTER the penalty has been applied
   * (sums need not equal zero — these are running totals, not a
   * delta). Lets the result panel show each seat's chip stack
   * alongside the chombo penalty. */
  chips: z.array(z.number().int()).length(4),
});

const CallEvent = z.object({
  type: z.literal("call"),
  seat: SeatSchema,
  meld: MeldSchema,
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
  chips: z.array(z.number().int()).length(4).optional(),
  /** Session-level dabuken state after this game (Buu only). */
  dabuken: z.array(z.boolean()).length(4).optional(),
  /**
   * Per-seat chip delta for THIS game only (post-game chip total
   * minus the snapshot taken at game start). Buu-only — shown
   * next to each player's final score in the end-of-game panel.
   */
  chipsDelta: z.array(z.number().int()).length(4).optional(),
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
  votes: z.tuple([
    z.enum(["yes", "no"]).nullable(),
    z.enum(["yes", "no"]).nullable(),
    z.enum(["yes", "no"]).nullable(),
    z.enum(["yes", "no"]).nullable(),
  ]),
  /** Zero-based index of the just-finished game. */
  gameIndex: z.number().int().nonnegative(),
});

const SessionVoteUpdateEvent = z.object({
  type: z.literal("session_vote_update"),
  votes: z.tuple([
    z.enum(["yes", "no"]).nullable(),
    z.enum(["yes", "no"]).nullable(),
    z.enum(["yes", "no"]).nullable(),
    z.enum(["yes", "no"]).nullable(),
  ]),
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
  chips: z.array(z.number().int()).length(4),
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
  sinking: z.tuple([z.boolean(), z.boolean(), z.boolean(), z.boolean()]),
});

export const GameEventSchema = z.discriminatedUnion("type", [
  MatchStartEvent,
  HandStartEvent,
  DrawEvent,
  DiscardEvent,
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
    "ron",
    "tsumo",
    "riichi",
  ]),
  tile: TileSchema.optional(),
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
export const SnapshotStateSchema = z.object({
  /** Recipient's own seat, or `null` for a spectator view (all
   * hands hidden, no own-hand re-attach on `hand_start`). */
  mySeat: SeatSchema.nullable(),
  hands: z.array(z.array(TileSchema.nullable())).length(4),
  discards: z.array(z.array(TileSchema)).length(4),
  melds: z.array(z.array(MeldSchema)).length(4),
  wallRemaining: z.number().int().nonnegative(),
  /** Number of tiles drawn from the live wall this hand (excluding
   * rinshan draws from the dead wall). Used by the renderer to
   * shrink the live wall and place the just-drawn tile near the
   * dora end. Optional for back-compat with older snapshots; the
   * renderer falls back to `70 - wallRemaining` when absent. */
  drawsTaken: z.number().int().nonnegative().optional(),
  doraIndicators: z.array(TileSchema),
  turn: SeatSchema,
  dealer: SeatSchema,
  roundWind: z.enum(["E", "S", "W", "N"]),
  roundNumber: z.number().int().positive(),
  honba: z.number().int().nonnegative(),
  riichiSticks: z.number().int().nonnegative(),
  scores: z.array(z.number().int()).length(4),
  /**
   * Per-seat "sinking" flag (same semantics as
   * `HandStartEvent.sinking`). Optional for back-compat with
   * snapshots captured before this field existed; absent ==
   * all-false on the client side.
   */
  sinking: z.array(z.boolean()).length(4).optional(),
  /**
   * Per-seat in-game chip totals (Buu only; absent / treated as
   * `[0, 0, 0, 0]` outside Buu).
   */
  chips: z.array(z.number().int()).length(4).optional(),
  /**
   * Per-seat dabuken (double-chip token) state (Buu only; absent
   * / treated as `[false, false, false, false]` outside Buu).
   */
  dabuken: z.array(z.boolean()).length(4).optional(),
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
  riichiDeclared: z.array(z.boolean()).length(4),
  /** Per-seat index into `discards[seat]` of the riichi declaration
   * tile (null when that seat has not declared riichi). */
  riichiTileIdx: z
    .array(z.number().int().nonnegative().nullable())
    .length(4)
    .optional(),
  lastDiscard: z.object({ seat: SeatSchema, tile: TileSchema }).nullable(),
  phase: z.string(),
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
  furiten: z.array(z.boolean()).length(4).optional(),
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
  seatNames: z.array(z.string()).length(4).optional(),
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
});

const EventMsg = z.object({
  type: z.literal("event"),
  seq: z.number().int().nonnegative(),
  events: z.array(GameEventSchema),
  legalActions: z.array(LegalActionSchema),
  deadline: z.number().int().optional(),
  /** See `SnapshotMsg.bufferMs`. */
  bufferMs: z.number().int().nonnegative().optional(),
});

const ErrorMsg = z.object({
  type: z.literal("error"),
  code: z.string(),
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
  acked: z.tuple([z.boolean(), z.boolean(), z.boolean(), z.boolean()]),
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
 * status until any seated human sends `start_match`, at which
 * point the server fills empty seats with bots and flips to
 * `playing`. The client uses `room_state` to render the waiting
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
    /** True when the human's socket is currently connected. False
     * after a disconnect; the seat is still reserved for them by
     * userId so they can reclaim it on reconnect. */
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
});

const RoomStateMsg = z.object({
  type: z.literal("room_state"),
  matchId: z.string(),
  /** Lifecycle: `waiting` = pre-start; `playing` = match running;
   * `finished` = match ended (post-game lobby). */
  status: z.enum(["waiting", "playing", "finished"]),
  /** Recipient's own seat assignment, or `null` for a spectator
   * (no available seat at attach time). */
  mySeat: SeatSchema.nullable(),
  /** All four seat slots, always present, ordered 0..3. */
  seats: z.array(RoomSeatSchema).length(4),
});
export type RoomState = z.infer<typeof RoomStateMsg>;

export const ServerMessageSchema = z.discriminatedUnion("type", [
  SnapshotMsg,
  EventMsg,
  ErrorMsg,
  ReadyCheckMsg,
  ReadyCheckEndMsg,
  RoomStateMsg,
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

const HelloMsg = z.object({
  type: z.literal("hello"),
  token: z.string(),
  matchId: z.string(),
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
});

/**
 * Request to start the match: any seated human may send this
 * while the room is in `waiting` status. The server fills any
 * empty seat with a bot, broadcasts a final `room_state` with
 * `status: "playing"`, and then begins the normal match flow
 * (ready check → first hand).
 *
 * Rejected with an `error` frame if the sender is not a seated
 * human or if the room is no longer in `waiting`.
 */
const StartMatchMsg = z.object({
  type: z.literal("start_match"),
  matchId: z.string(),
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
 * the server flags the seat as disconnected and auto-defaults its
 * actions until the user clicks the "Reconnect" overlay, which
 * sends `afk: false`. Mid-action arrival is fine: the server's
 * auto-default path is idempotent against an already-resolved
 * window.
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
});

export const ClientMessageSchema = z.discriminatedUnion("type", [
  HelloMsg,
  ActMsg,
  ResyncMsg,
  ReadyMsg,
  StartMatchMsg,
  LeaveSeatMsg,
  AfkMsg,
  VoteContinueMsg,
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;
