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

const MatchEndEvent = z.object({
  type: z.literal("match_end"),
  finalScores: z.array(
    z.object({
      seat: SeatSchema,
      score: z.number().int(),
      place: z.number().int().min(1).max(4),
    })
  ),
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
  mySeat: SeatSchema,
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

export const ServerMessageSchema = z.discriminatedUnion("type", [
  SnapshotMsg,
  EventMsg,
  ErrorMsg,
  ReadyCheckMsg,
  ReadyCheckEndMsg,
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

export const ClientMessageSchema = z.discriminatedUnion("type", [
  HelloMsg,
  ActMsg,
  ResyncMsg,
  ReadyMsg,
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;
