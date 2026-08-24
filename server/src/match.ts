/**
 * `MatchProcess` — authoritative state for a single match.
 *
 * Phase 1 step 2 wires the turn loop through the pure rules engine
 * (`app/game/rules/step`). Match orchestration responsibilities that
 * the engine deliberately doesn't own stay here:
 *
 *   - Player roster + persistence (Mongo `Match` doc).
 *   - The match-level lifecycle events the engine doesn't emit
 *     (`match_start`, `hand_start`, `match_end`).
 *   - Legal-action surfacing for the UI (engine treats illegal acts
 *     as no-ops; the UI wants explicit `LegalAction` IDs).
 *   - The two debug-seed overrides from the lobby panel:
 *       · seat-0 "human draws" queue (forces the next live-wall tile)
 *       · seat-3 "left discards" queue (forces the bot's discard,
 *         injecting the tile into seat 3's hand if needed)
 *   - Random bot picks for seats 1-3.
 *   - Per-recipient projection + WS fanout.
 *   - In-memory event log for resync (also archived to Mongo at end).
 *
 * The slice still ships the placeholder "declare win" path: a `win`
 * legal action ends the match immediately. Real win detection lands
 * in Phase 1 step 5.
 */
import type {
  GameEvent,
  LegalAction,
  MatchDebug,
  RoomSeatOccupant,
  Seat,
  ServerMessage,
  ViewerPresence,
} from "~/game/protocol/messages";
import {
  createInitialState,
  enumerateCalls,
  isAkaDisabled,
  isFuritenForRon,
  resolveRuleSet,
  scoreHand,
  seatWind,
  step,
  waits,
  applyChipDelta,
  evaluateBuuEndOfGameChips,
  riichiLibYakuToRomaji,
  type CallOption,
  type DiscardSource,
  type EngineEvent,
  type FuritenChange,
  type MatchEndReason,
  type MatchState,
  type RuleSetOverride,
  type Tile,
} from "~/game/rules";
import { randomBotDiscard } from "./bots/random";
import { chooseBotCall, chooseBotSelfKan } from "./bots/calls";
import {
  MATCH_CHECKPOINT_SCHEMA_VERSION,
  PlayingActionCheckpointSchema,
  PlayingCallCheckpointSchema,
  PlayingContinueVoteCheckpointSchema,
  PlayingReadyCheckpointSchema,
  PlayingResultTransitionCheckpointSchema,
  WaitingRoomCheckpointSchema,
  parseMatchCheckpoint,
  type MatchCheckpoint,
  type PlayingActionCheckpoint,
  type PlayingCallCheckpoint,
  type PlayingContinueVoteCheckpoint,
  type PlayingReadyCheckpoint,
  type PlayingResultTransitionCheckpoint,
  type WaitingRoomCheckpoint,
} from "./checkpoint";
import { projectEvent, projectPublicEvent } from "./projection";
import {
  type MatchRepository,
  type PendingMatchCommand,
  type PersistedMatchPlayer,
} from "./repository";
import {
  type MatchRuntime,
  type MatchTimer,
} from "./runtime";
import { createSystemMatchRuntime } from "./runtime";

export interface MatchPlayerInit {
  userId: string;
  displayName: string;
  isBot: boolean;
}

type FinalScore = {
  seat: Seat;
  score: number;
  place: 1 | 2 | 3 | 4;
};

export interface MatchProcessDependencies {
  repository: MatchRepository;
  runtime?: MatchRuntime;
}

type Send = (msg: ServerMessage) => void;

/**
 * Per-connection state for a delayed-spectator session. Tracks
 * the next omniscient log index to consider, the running
 * spectator-seq counter (advances only on non-null projections),
 * and the pending dispatch timer.
 *
 * Exposed as an opaque handle from `attachDelayedSpectator`; the
 * caller passes it back to `detachDelayedSpectator` on close.
 */
interface DelayedSpectatorSession {
  send: Send;
  delayMs: number;
  /** Index into `eventLog` of the next entry to consider for
   * dispatch. Walked forward only — never rewinds. */
  nextCursor: number;
  /** Next spectator-seq to assign. Tracks the running count of
   * non-null public projections this session has dispatched. */
  seq: number;
  /** Pending `setTimeout` ref; non-null only when a future
   * unripe event is waiting for its `emittedAt + delayMs`. */
  timer: MatchTimer | null;
  closed: boolean;
}

/**
 * Post-hand ready-check deadline (ms). After every `hand_end`
 * the server runs a ready check with this window: clients show
 * an OK button + countdown over the win / draw panel; the next
 * hand starts as soon as all humans ack or the deadline fires.
 * Tests override via `setNextHandDelayMs(0)` to skip the wait.
 */
// eslint-disable-next-line prefer-const
let NEXT_HAND_DELAY_MS = 5000;

export function setNextHandDelayMs(ms: number): void {
  NEXT_HAND_DELAY_MS = ms;
}

/**
 * Buu multi-game session: how long the continue-vote window
 * stays open after a `match_end`. A seat that hasn't voted by
 * the deadline is treated as a "no" (and the whole session
 * ends with `vote_timeout`). Tests override via
 * `setContinueVoteMs(0)` to resolve the vote synchronously on
 * the bots' pre-vote.
 */
// eslint-disable-next-line prefer-const
let CONTINUE_VOTE_MS = 30_000;

export function setContinueVoteMs(ms: number): void {
  CONTINUE_VOTE_MS = ms;
}

/**
 * Buu multi-game session: how long the post-`match_end` "match
 * ended" screen stays visible before the continue-vote overlay
 * opens. Gives players a moment to read the final scores /
 * place ranking before the next-game prompt covers it. Tests
 * override via `setMatchEndDisplayMs(0)` to skip the wait.
 */
// eslint-disable-next-line prefer-const
let MATCH_END_DISPLAY_MS = 3000;

export function setMatchEndDisplayMs(ms: number): void {
  MATCH_END_DISPLAY_MS = ms;
}

/**
 * Tiny deterministic shuffle (mulberry32 + Fisher–Yates) used
 * for initial waiting-room seating and Buu next-game seating.
 * Pure function of `seed` so test setups can predict the
 * resulting permutation without monkey-patching `Math.random`.
 */
function deterministicShuffle<T>(items: readonly T[], seed: number): T[] {
  let s = seed >>> 0;
  const next = (): number => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Map each final seat to the waiting-room seat whose occupant moves there.
 * The match seed is chosen when the room is created but the permutation is
 * not applied or revealed until the game actually starts.
 */
export function waitingRoomSeatPermutation(
  seed: number
): [Seat, Seat, Seat, Seat] {
  const shuffled = deterministicShuffle<Seat>([0, 1, 2, 3], seed);
  return [shuffled[0], shuffled[1], shuffled[2], shuffled[3]];
}

/**
 * Pause inserted before each draw step so the client can render
 * the previous action (and play its SFX) before the next draw
 * arrives. Applies to every seat — bot and human alike — so the
 * cadence after any discard (when no call window opens) feels
 * consistent.
 *
 * Tests override via `setDelayAfterDiscardMs(0)`.
 */
// eslint-disable-next-line prefer-const
let DELAY_AFTER_DISCARD_MS = 500;

/**
 * Additional pause inserted between a seat's `draw` event and
 * its subsequent discard / self-kan (for bots, riichi'd seats,
 * and disconnected auto-defaults), so the draw SFX has room to
 * play and the eye can register the drawn tile before it leaves.
 *
 * Tests override via `setDelayAfterDiscardMs(0)` (zeros this too).
 */
// eslint-disable-next-line prefer-const
let DRAW_TO_DISCARD_DELAY_MS = 700;

/**
 * Maximum client animation time before a win-triggering tile has
 * visibly landed (discard phase A is 350ms; draw/meld slides are
 * 300-350ms), followed by the requested 700ms viewing beat.
 * `waitForWinReaction` measures from the triggering event's actual
 * emission time, so a human who takes longer to declare does not
 * incur an unnecessary fixed delay after clicking.
 *
 * Tests override via `setDelayAfterDiscardMs(0)` (zeros this too).
 */
// eslint-disable-next-line prefer-const
let WIN_REACTION_DELAY_MS = 350 + 700;

export function remainingWinReactionDelayMs(
  triggerEmittedAt: number,
  now: number,
  minimumAgeMs: number = WIN_REACTION_DELAY_MS
): number {
  return Math.max(0, minimumAgeMs - Math.max(0, now - triggerEmittedAt));
}

/**
 * Pause inserted between the `win` event and the subsequent
 * `hand_end` event for that win. The `win` event triggers the
 * client to flip the winner's concealed hand face-up at the
 * seat band; `hand_end` is what causes the central win-info
 * panel to appear. This gap lets the audience register what was
 * declared and on what tile before the panel takes over the
 * screen.
 *
 * Tests override via `setDelayAfterDiscardMs(0)` (zeros this too).
 */
// eslint-disable-next-line prefer-const
let WIN_TO_PANEL_DELAY_MS = 500;

/**
 * Per-yaku reveal interval used by the client's staged win-info
 * panel. The server uses this to size the post-`hand_end` pause
 * before the OK-ready-check countdown starts, so the auto-advance
 * timer doesn't kick in mid-reveal.
 */
const WIN_YAKU_REVEAL_INTERVAL_MS = 750;

/**
 * Extra delay after the last yaku reveal before the ura-dora
 * indicators flip face-up, used when the winner declared riichi
 * but the ura tiles didn't score any uradora yaku. Mirrors the
 * client-side animation timing.
 */
const WIN_URA_REVEAL_AFTER_LAST_YAKU_MS = 1000;

/** Final beat between the last yaku/ura detail and the han/fu + value row. */
const WIN_SCORE_REVEAL_AFTER_FINAL_DETAIL_MS = 750;

export function winResultRevealDurationMs(args: {
  visibleYakuCount: number;
  hasUraIndicators: boolean;
  hasUraYaku: boolean;
}): number {
  const lastYakuRevealAtMs =
    args.visibleYakuCount * WIN_YAKU_REVEAL_INTERVAL_MS;
  const finalDetailRevealAtMs =
    args.hasUraIndicators && !args.hasUraYaku
      ? lastYakuRevealAtMs + WIN_URA_REVEAL_AFTER_LAST_YAKU_MS
      : lastYakuRevealAtMs;
  return finalDetailRevealAtMs + WIN_SCORE_REVEAL_AFTER_FINAL_DETAIL_MS;
}

export function setDelayAfterDiscardMs(ms: number): void {
  DELAY_AFTER_DISCARD_MS = ms;
  DRAW_TO_DISCARD_DELAY_MS = ms;
  WIN_REACTION_DELAY_MS = ms;
  WIN_TO_PANEL_DELAY_MS = ms;
}

/**
 * Per-action base think time the client renders as the leading
 * countdown ("X + Y" in the bottom-left HUD). Default 5s, chosen
 * to mirror Tenhou's per-action budget.
 */
// eslint-disable-next-line prefer-const
let BASE_ACTION_MS = 5_000;

/**
 * Server-side slack added to the visible deadline before the
 * auto-default fires, so an `act` frame that left the client just
 * before the visible "0" still wins the race against the timeout
 * callback. Not deducted from the buffer (any elapsed time within
 * `BASE_ACTION_MS + ACTION_GRACE_MS` is "free").
 */
// eslint-disable-next-line prefer-const
let ACTION_GRACE_MS = 200;

/**
 * Per-hand buffer pool granted to each seat at `hand_start`.
 * Burns down only when an action takes longer than `BASE_ACTION_MS
 * + ACTION_GRACE_MS`; refills (does not stack) at the next
 * `hand_start`. Mirrors Tenhou's per-hand think-pool.
 */
// eslint-disable-next-line prefer-const
let INITIAL_BUFFER_MS = 20_000;

/**
 * Number of consecutive failed liveness probes a seat must rack
 * up before the orchestrator flags it as disconnected. 2 strikes
 * tolerates a single dropped pong (mobile carrier RTT spike,
 * browser GC pause, packet loss) without auto-defaulting the
 * player. Any successful action or pong resets the counter.
 */
const LIVENESS_PROBE_STRIKE_COUNT = 2;

/**
 * Pre-match ready-check duration. After `match_start` the server
 * waits up to this many ms for the human to ack before dealing
 * the first hand. Bots are pre-acked. Set to 0 to skip the
 * ready check entirely — the default, which keeps the tests
 * deterministic; production wiring (`game-server/src/index.ts`)
 * overrides via `setReadyCheckMs`.
 */
// eslint-disable-next-line prefer-const
let READY_CHECK_MS = 0;

export function setReadyCheckMs(ms: number): void {
  READY_CHECK_MS = ms;
}

export function setActionTimeoutMs(ms: number): void {
  // Test back-compat: legacy spec helper. Treats the supplied
  // value as the total budget (base + buffer + grace) by zeroing
  // the buffer and grace and using `ms` as the base. `ms === 0`
  // disables expiry scheduling entirely.
  BASE_ACTION_MS = ms;
  ACTION_GRACE_MS = 0;
  INITIAL_BUFFER_MS = 0;
}

export function setActionTimingMs(opts: {
  base?: number;
  grace?: number;
  buffer?: number;
}): void {
  if (opts.base !== undefined) {
    BASE_ACTION_MS = opts.base;
  }
  if (opts.grace !== undefined) {
    ACTION_GRACE_MS = opts.grace;
  }
  if (opts.buffer !== undefined) {
    INITIAL_BUFFER_MS = opts.buffer;
  }
}

/**
 * Call-window priority. Higher beats lower; ties resolve via
 * atamahane (closest seat counter-clockwise from the discarder).
 * `pass` is 0 so the short-circuit in `resolveCallWindow` only
 * fires on real call submissions.
 */
function callActionPriority(action: LegalAction): number {
  if (action.type === "ron") {
    return 4;
  }
  if (action.type === "kan") {
    return 3;
  }
  if (action.type === "pon") {
    return 2;
  }
  if (action.type === "chi") {
    return 1;
  }
  return 0;
}

/**
 * Max call-window priority across a seat's option set. Used by
 * `resolveCallWindow` to decide whether a still-open window can
 * possibly beat the action a peer just submitted.
 */
function callOptionsMaxPriority(options: CallOption[]): number {
  let best = 0;
  for (const o of options) {
    let p = 0;
    if (o.kind === "ron") {
      p = 4;
    } else if (o.kind === "daiminkan") {
      p = 3;
    } else if (o.kind === "pon") {
      p = 2;
    } else if (o.kind === "chi") {
      p = 1;
    }
    if (p > best) {
      best = p;
    }
  }
  return best;
}

export class MatchProcess {
  readonly matchId: string;
  readonly seed: number;
  /**
   * Per-seat player record. `null` represents an empty slot in a
   * waiting-room match (no one has claimed that seat yet). Once
   * `start()` runs, every slot is non-null (asserted in `start`)
   * and stays non-null for the rest of the match's lifetime.
   */
  private readonly players: Map<Seat, MatchPlayerInit | null>;

  /**
   * Match lifecycle:
   *   - `waiting`  — pre-game waiting room (humans may join /
   *                  leave, bots may be filled in by `fillBots`).
   *                  `start()` flips the status to `playing`.
   *   - `playing`  — the engine is live; seats are frozen. A
   *                  human may disconnect and reconnect to their
   *                  seat, but no one may leave or join.
   *   - `finished` — the match ended (`endMatch` ran).
   * Transitions are uni-directional: waiting → playing → finished.
   */
  private statusValue: "waiting" | "playing" | "finished" = "waiting";
  get status(): "waiting" | "playing" | "finished" {
    return this.statusValue;
  }

  /** True for a relay/virtual match fed by an external decoder (e.g. Tenhou
   * live spectating) rather than the local rules engine. */
  private relayMode = false;
  get isRelay(): boolean {
    return this.relayMode;
  }
  /** Relay archive metadata, set by `createRelayMatch` / `injectRelayEvent`. */
  private relaySourceGameId: string | null = null;
  private relayRuleSet = "tenhou-default";
  private relaySeats: Array<{ seat: Seat; displayName: string }> | null = null;
  private relayFinalScores: Array<{
    seat: Seat;
    score: number;
    place: 1 | 2 | 3 | 4;
  }> | null = null;

  /** Authenticated spectator identities keyed by their connection sender. */
  private readonly spectatorViewers = new Map<Send, ViewerPresence>();

  /**
   * Lightweight projection of this match for the lobby's live-
   * rooms list. Safe to call in any status:
   *   - In `waiting`, empty slots are reported as `null`.
   *   - `buuMode` falls back to the pre-start `ruleSetOverride`
   *     before `start()` has populated `this.state`.
   * No engine internals are exposed — just public seating + the
   * preset flavor the lobby needs to label the row.
   */
  summary(): {
    matchId: string;
    status: "waiting" | "playing" | "finished";
    presetId: string;
    buuMode: boolean;
    seats: Array<{ name: string | null; isBot: boolean } | null>;
  } {
    const seats: Array<{ name: string | null; isBot: boolean } | null> = [
      null,
      null,
      null,
      null,
    ];
    for (let s = 0; s < 4; s++) {
      const p = this.players.get(s as Seat) ?? null;
      if (p === null) {
        seats[s] = null;
      } else {
        seats[s] = { name: p.displayName, isBot: p.isBot };
      }
    }
    const buuMode =
      this.statusValue === "waiting"
        ? (this.ruleSetOverride?.buuMode ?? false)
        : (this.state?.ruleSet.buuMode ?? false);
    return {
      matchId: this.matchId,
      status: this.statusValue,
      presetId: this.relayMode ? this.relayRuleSet : this.presetId,
      buuMode,
      seats,
    };
  }

  // Engine state — created in `start()`, advanced only by `step()`
  // (apart from the narrow debug-seed overrides documented at each
  // callsite below).
  private state!: MatchState;

  /**
   * Per-seat legal-action set. Indexed by `Seat`. Empty array
   * means "no pending actions for that seat". Mutated exclusively
   * by `setSeatLegals(seat, …)` so the matching per-seat deadline
   * timer and start-time fields move in lockstep.
   *
   * Multiple seats may have non-empty legals concurrently — e.g.
   * a discard that two humans could pon/chi/ron. Slice 2b adds
   * the resolver that waits for every open window to close
   * before applying the head-bumpered winning action.
   */
  private legalActions: LegalAction[][] = [[], [], [], []];
  /**
   * Per-seat wall-clock deadline (Unix ms) for the currently-
   * offered `legalActions[seat]`, or `null` when that seat has
   * no pending window. Set/cleared exclusively by
   * `setSeatLegals` so all assignment sites stay in lockstep
   * with the per-seat timer.
   */
  private currentDeadline: (number | null)[] = [null, null, null, null];
  /**
   * Per-seat pending `setTimeout` handle that fires when that
   * seat's action window expires. Cleared on every
   * `setSeatLegals` call for that seat so stale callbacks can
   * never apply a default after the state has moved on.
   */
  private currentDeadlineTimer: (MatchTimer | null)[] = [
    null,
    null,
    null,
    null,
  ];
  /**
   * Per-seat epoch counter. Bumps on every `setSeatLegals(seat,
   * …)`. The deadline-expiry callback captures the value at
   * schedule time and bails if it no longer matches, so a
   * callback already in flight when the timer is cleared (e.g.
   * node fires it the same tick we clear) is still a no-op.
   */
  private deadlineEpoch: [number, number, number, number] = [0, 0, 0, 0];
  /**
   * Per-seat wall-clock at which that seat's current legal-action
   * window started. Used by `consumeActionBuffer(seat)` to
   * compute how much of the per-action budget the seat consumed
   * and deduct any overage from `bufferMs[seat]`. Null when no
   * window is open for that seat.
   */
  private currentActionStartMs: (number | null)[] = [null, null, null, null];
  /**
   * Per-seat "think buffer". Refilled to `INITIAL_BUFFER_MS` at
   * every `hand_start`; decremented in `handleAct` whenever the
   * seat's elapsed action time exceeds `BASE_ACTION_MS +
   * ACTION_GRACE_MS`. Exposed to each human as the trailing
   * `bufferMs` field on their own `snapshot` / `event` frames so
   * the bottom-left HUD can render "X + Y".
   */
  private bufferMs: [number, number, number, number] = [
    INITIAL_BUFFER_MS,
    INITIAL_BUFFER_MS,
    INITIAL_BUFFER_MS,
    INITIAL_BUFFER_MS,
  ];
  /**
   * Omniscient seq counter. Drives the in-memory `eventLog` and
   * the Mongo archive — i.e. every consumer that sees the
   * unredacted form (replay viewer, archival writes, future
   * omniscient spectator paths).
   */
  private nextSeq = 0;
  /**
   * Per-recipient seq lines, one per seat. A seat's counter only
   * advances when the projection layer emits a non-null frame for
   * that recipient, so each seat's wire stream is strictly
   * contiguous from their own perspective. Gaps in the omniscient
   * stream caused by per-seat redactions (e.g. opponent furiten
   * transitions) never reach the recipient's `lastSeq`.
   *
   * The seq sent on a recipient's wire frame is always its own
   * counter value, never the omniscient seq. Snapshots, event
   * frames, and legals-piggyback frames all use the recipient's
   * value.
   */
  private seatSeq: [number, number, number, number] = [0, 0, 0, 0];
  private finalized = false;

  /**
   * Pre-match ready-check state. `readyAcked` is the per-seat ack
   * bitmap (bots pre-acked in `start`). `readyDeadline` is the
   * wall-clock at which the auto-advance fires. `readyResolve`
   * is the promise resolver awaited by `start` so the first
   * hand only deals once all seats are acked or the deadline
   * has elapsed.
   */
  private readyAcked: [boolean, boolean, boolean, boolean] = [
    false,
    false,
    false,
    false,
  ];
  private readyDeadline: number | null = null;
  private readyTimer: MatchTimer | null = null;
  private readyResolve: (() => void) | null = null;
  private readyContinuationKind:
    | PlayingReadyCheckpoint["readyContinuation"]
    | null = null;

  /**
   * Type of the most recently emitted engine event. Used to
   * detect the `win` → `buu_chombo` sequence emitted by the
   * engine on a Buu illegal-victory chombo, so the server can
   * pause between the win-info panel and the chombo panel for
   * the same duration as the post-hand ready check.
   */
  private lastEngineEventType: EngineEvent["type"] | null = null;

  /**
   * Accumulated client-side reveal animation duration for the
   * just-resolved hand's win events. Populated as each `win`
   * event is emitted (max across winners, so the OK auto-advance
   * timer waits long enough for any single page of a multi-ron
   * panel to fully reveal). Consumed and reset to 0 by
   * `afterHandEnd` right before the post-hand ready check starts,
   * so the visible OK countdown only begins after the staged
   * reveal has had time to play out client-side. Stays 0 on
   * non-win hand endings (exhaustive draw, abort).
   */
  private pendingWinRevealMs = 0;
  private resultTransitionKind:
    | PlayingResultTransitionCheckpoint["transitionKind"]
    | null = null;
  private resultTransitionDeadline: number | null = null;
  private resultTransitionNextReadyMs = 0;
  private resultTransitionTimer: MatchTimer | null = null;
  private resultTransitionResolve: (() => void) | null = null;
  private uncheckpointableTransition:
    | "win_reaction"
    | "turn_pacing"
    | "bot_discard_pacing"
    | "auto_riichi_pacing"
    | "match_end_display"
    | "win_to_panel"
    | null = null;

  /**
   * Wall-clock match start time, captured in `start()`. Used by
   * `archiveReplayLog` so the `ReplayLog` row has both ends of
   * the match's wall-clock span (Phase 4.5).
   */
  private startedAt: Date | null = null;

  /**
   * Per-seat index into `state.discards[seat]` of the riichi
   * declaration tile (null when the seat has not declared riichi
   * yet). Populated when an engine `discard` event carries the
   * `riichi: true` flag; reset to nulls on every `hand_start`.
   */
  private riichiTileIdx: [
    number | null,
    number | null,
    number | null,
    number | null,
  ] = [null, null, null, null];

  /**
   * Two d6 rolled at the start of the current hand. Determines the
   * wall break point. Re-rolled on every `hand_start`.
   */
  private dice: [number, number] = [1, 1];

  private rollDice(): [number, number] {
    const a = 1 + Math.floor(this.runtime.random() * 6);
    const b = 1 + Math.floor(this.runtime.random() * 6);
    this.dice = [a, b];
    return [a, b];
  }

  /**
   * Post-discard call window state. `callWindow[seat]` is the
   * pending option set for seat `seat`, or `null` when that seat
   * has no open window. Multiple humans may have concurrent
   * windows on the same discard (e.g. seat 1 can chi while seat
   * 2 can pon or ron); each runs its own per-seat timer via
   * `setSeatLegals`. Bots auto-resolve synchronously in
   * `afterDiscard` into `pendingBotRons` / `pendingBotCalls`.
   * Once every open human window has been answered (or timed
   * out), `finalizeCallWindow` picks the winning action.
   */
  private callWindow: (CallOption[] | null)[] = [null, null, null, null];
  /**
   * Per-seat human response captured during the current call
   * window. Populated as each seat acts (`ron`, `chi`, `pon`,
   * `kan`, `pass`); consumed and reset by `finalizeCallWindow`.
   */
  private pendingHumanCallActions: (LegalAction | null)[] = [
    null,
    null,
    null,
    null,
  ];

  /**
   * Bot seats that have a legal ron on the current discard. Captured
   * by `afterDiscard` and resolved either immediately (if no human
   * window opens) or together with the human's response in
   * `resolveCallWindow`. Atamahane: closest seat counter-clockwise
   * from the discarder wins on ties.
   */
  private pendingBotRons: Seat[] = [];

  /**
   * Bot seats that have a legal yakuhai pon / daiminkan on the
   * current discard. Same window-deferral semantics as
   * `pendingBotRons`, but lower priority — a human ron always
   * wins; otherwise the first bot in turn-order wins (impossible
   * to have two valid pons on the same tile).
   */
  private pendingBotCalls: Array<{ seat: Seat; option: CallOption }> = [];

  /**
   * In-memory event log retained for the lifetime of the match.
   * Doubles as (a) the source for in-process resync replay (no
   * separate ring buffer needed — a full match is ~400 KB worst
   * case, scanning is microseconds) and (b) the payload archived
   * to Mongo in one shot from `finalizeMatch` via `archiveMatch`.
    * Durable recovery stores this log inside quiescent checkpoints
    * and write-ahead action records; the standalone Match archive
    * still receives the complete log only at game completion.
   */
  private readonly eventLog: Array<{
    seq: number;
    event: GameEvent;
    /** Runtime wall-clock time at which this event was
     * appended to the log. Used by the delayed-spectator scheduler
     * to gate dispatch (`emittedAt + delayMs <= now`). */
    emittedAt: number;
  }> = [];
  /**
   * Per-seat live WS send hooks. Slot `s` is non-null iff a human
   * client is currently attached at seat `s`. Bots never have an
   * entry (they don't read events; the orchestrator drives them
   * directly). Multiple seats can be attached simultaneously —
   * this is the multi-human entry point.
   *
   * Use `attachHuman(seat, send)` / `detachHuman(seat)` to mutate;
   * never assign directly so reconnect-mid-ready-check stays
   * synced.
   */
  private humanSockets: [Send | null, Send | null, Send | null, Send | null] = [
    null,
    null,
    null,
    null,
  ];
  private humanConnectionGeneration: [number, number, number, number] = [
    0, 0, 0, 0,
  ];
  /**
   * Per-seat liveness probe. Invoked by the orchestrator the first
   * time a seat exhausts its think buffer (i.e. the deadline-expiry
   * callback fires with `bufferMs[seat] === 0`); if the probe
   * resolves false (no WS pong within the timeout), the seat is
   * flagged disconnected and the orchestrator stops waiting on it
   * for future windows. Set by `attachHuman`; cleared by
   * `detachHuman`. Defaults to "always alive" if absent (used in
   * tests that don't wire a real WS).
   */
  private livenessProbes: [
    (() => Promise<boolean>) | null,
    (() => Promise<boolean>) | null,
    (() => Promise<boolean>) | null,
    (() => Promise<boolean>) | null,
  ] = [null, null, null, null];
  /**
   * Per-seat disconnect flag. True when the seat is either
   * physically disconnected (socket closed) or self-reported AFK
   * via the `afk` client frame. While true, the orchestrator
   * skips call windows for that seat (auto-passes) and auto-
   * discards instead of waiting on the full per-action deadline.
   * Independent of `humanSockets[seat]`: an AFK seat keeps a
   * live socket so the disconnect overlay / reconnect button
   * stay in band; a network-disconnected seat has both `null`
   * socket AND `disconnected=true`.
   */
  private disconnected: [boolean, boolean, boolean, boolean] = [
    false,
    false,
    false,
    false,
  ];
  /**
   * True iff `disconnected[seat]` was set by an explicit
   * `handleAfk(true)` from the client (the user clicked the
   * "Pause / I'm AFK" UI, or the AFK overlay flipped). False
   * when the flag came from a network-only detach (the socket
   * dropped without the user choosing to opt out). Used by
   * `attachHuman` to decide whether a successful reconnect
   * should auto-clear the flag — yes for network reconnects,
   * no for self-reported AFK (the user must explicitly opt
   * back in via the overlay button).
   */
  private afkSelfReported: [boolean, boolean, boolean, boolean] = [
    false,
    false,
    false,
    false,
  ];
  /**
   * Consecutive failed liveness probes per seat. Reset to 0 by
   * any successful pong, by a successful `handleAct`, or by a
   * fresh `attachHuman`. A seat is only flagged as disconnected
   * once this counter reaches `LIVENESS_PROBE_STRIKE_COUNT` —
   * tolerating a single missed pong (mobile RTT spike, browser
   * GC pause) without auto-defaulting the player's turn.
   */
  private livenessProbeMisses: [number, number, number, number] = [0, 0, 0, 0];
  /**
   * True while the orchestrator is mid-WS-pong wait for that
   * seat — keeps `handleDeadlineExpiry` from launching multiple
   * concurrent probes on the same buffer-exhausted window.
   */
  private livenessProbeInflight: [boolean, boolean, boolean, boolean] = [
    false,
    false,
    false,
    false,
  ];
  /**
   * Attached spectator send hooks. Spectators receive the
   * `projectPublicEvent` redaction (no per-seat hand re-attach,
   * no `draw` tile, no `furiten` events). Their wire stream uses
   * a single shared `spectatorSeq` counter — the projection is
   * pure, so every spectator sees the same numbering regardless
   * of when they attached.
   *
   * Use `attachSpectator(send)` / `detachSpectator(send)` to
   * mutate. Attaching is allowed only via the WS layer's
   * spectator handshake (status === "playing" gate).
   */
  private spectatorSockets: Set<Send> = new Set();
  /**
   * Per-stream sequence number for spectator events. Increments
   * only when `projectPublicEvent` emits a non-null projection,
   * keeping the spectator wire stream strictly contiguous in
   * spectator-seq space (mirrors how `seatSeq` works for seats).
   */
  private spectatorSeq = 0;

  /**
   * Snapshot of the live wall at the most recent `hand_start`, in
   * draw order (70 tiles). Captured by `enrichForArchive` when
   * the `hand_start` event is enriched and exposed verbatim to
   * mid-hand spectator snapshots so the wall-reveal overlay can
   * render the full starting wall (the renderer hides positions
   * that have already been drawn via `liveDrawsTaken`). `null`
   * before the first `hand_start` of the match.
   */
  private handStartLiveWall: Tile[] | null = null;

  /**
   * Active delayed-spectator sessions. Each session has its own
   * cursor into `eventLog` (the next entry to consider) plus a
   * pending timer; the scheduler dispatches an event only once
   * `emittedAt + delayMs` has elapsed. The session's spectator-
   * seq is recomputed deterministically by walking the same
   * `projectPublicEvent` reduction the live stream uses, so
   * live and delayed watchers see identical numbering for the
   * same event — they just see them at different wall times.
   */
  private delayedSpectators: Set<DelayedSpectatorSession> = new Set();

  // Debug seed (lobby panel). Applied once at `start()`:
  //   - `humanHand`     replaces seat 0's initial 13 tiles
  //   - `humanDraws`    is a FIFO queue prepended to the live wall on
  //                     seat 0's turn (until exhausted)
  //   - `leftDiscards`  is a FIFO queue used to override seat 3's
  //                     bot discards (the tile is force-injected
  //                     into seat 3's hand if not present)
  private debug: MatchDebug = undefined;
  private humanDrawQueue: Tile[] = [];
  private leftDiscardQueue: Tile[] = [];

  /**
   * Optional rule-set override applied to every game in this
   * session. Threaded through to `createInitialState` for both
   * the initial game and every subsequent game in a Buu multi-
   * game session. `undefined` keeps the engine default
   * (tenhou-hanchan).
   */
  private readonly ruleSetOverride?: RuleSetOverride;
  private readonly presetId: string;

  // --- Buu multi-game session state ------------------------------------
  /**
   * Zero-based index of the currently-running game within this
   * session. Starts at 0 for the first game; incremented on every
   * `startNextGame`. Non-Buu sessions stay at 0 forever (one game).
   */
  private gameIndex = 0;
  /**
   * Index into `eventLog` where the currently-running game's
   * `match_start` event was appended. Used by `archiveCurrentGame`
   * to slice the per-game event window for the Mongo archive
   * write. Advances to `eventLog.length` at the start of each new
   * game in a session.
   */
  private gameStartLogIdx = 0;
  /**
   * Session-level chip totals carried across games (Buu only).
   * Snapshotted from `state.chips` at each `match_end` and
   * re-installed into the next game's fresh `MatchState`. All
   * zero for non-Buu sessions.
   */
  private sessionChips: [number, number, number, number] = [0, 0, 0, 0];
  /**
   * Per-seat chip totals captured at the start of the current
   * game (Buu only). Snapshotted from `state.chips` right after
   * the new game's `MatchState` is initialized. Used at
   * `match_end` to compute the per-seat chip delta for THIS
   * game (so the end-of-game panel can show "+5 / −3" alongside
   * each player's final score).
   */
  private gameStartChips: [number, number, number, number] = [0, 0, 0, 0];
  /**
   * Session-level dabuken state carried across games (Buu only).
   * Mirrors `sessionChips` for the double-chip token ledger.
   */
  private sessionDabuken: [boolean, boolean, boolean, boolean] = [
    false,
    false,
    false,
    false,
  ];
  /**
   * True once the entire session (all games + final
   * `session_end`) has finalized. Distinct from `finalized`,
   * which is the per-game flag flipped in `archiveCurrentGame`
   * and cleared on `startNextGame`.
   */
  private sessionFinalized = false;
  private pendingSessionEndReason:
    | "vote_no"
    | "vote_timeout"
    | "single_game"
    | "server_abort"
    | null = null;
  private sessionFinalizePromise: Promise<void> | null = null;

  get hasPendingFinalization(): boolean {
    return this.pendingSessionEndReason !== null && !this.sessionFinalized;
  }
  /**
   * Per-seat continue-vote state during an open Buu vote window.
   * `null` means the seat has not voted yet. Reset to all-null
   * on every `openContinueVote`; updated by
   * `handleVoteContinue`.
   */
  private continueVote: [
    "yes" | "no" | null,
    "yes" | "no" | null,
    "yes" | "no" | null,
    "yes" | "no" | null,
  ] = [null, null, null, null];
  private continueVoteDeadline: number | null = null;
  private continueVoteTimer: MatchTimer | null = null;
  private continueVoteResolve: ((cont: boolean) => void) | null = null;
  private continueVoteFinalScores: FinalScore[] | null = null;
  /**
   * Reason recorded for the most recent vote resolution. Drives
   * the eventual `session_end.reason`. Reset on every
   * `openContinueVote`.
   */
  private lastVoteReason: "vote_no" | "vote_timeout" | null = null;
  private readonly runtime: MatchRuntime;
  private readonly repository: MatchRepository;
  private pausedCheckpoint: MatchCheckpoint | null = null;
  private checkpointSavePromise: Promise<MatchCheckpoint> | null = null;
  private commandTransactionPromise: Promise<void> | null = null;
  private pendingCommandCommitCheckpoint: MatchCheckpoint | null = null;
  private commandRecoveryRequired = false;

  get isPaused(): boolean {
    return this.pausedCheckpoint !== null || this.commandRecoveryRequired;
  }

  get hasPendingCommandCommit(): boolean {
    return this.pendingCommandCommitCheckpoint !== null;
  }

  private assertNotPaused(operation: string): void {
    if (this.isPaused) {
      throw new Error(`MatchProcess.${operation}: match is paused`);
    }
  }

  constructor(
    matchId: string,
    seed: number,
    players: MatchPlayerInit[],
    dependencies: MatchProcessDependencies,
    debug?: MatchDebug,
    ruleSetOverride?: RuleSetOverride,
    presetId = "tenhou-hanchan"
  ) {
    if (players.length !== 4) {
      throw new Error("MatchProcess requires exactly 4 players");
    }
    this.matchId = matchId;
    this.seed = seed;
    this.players = new Map(
      players.map((p, i) => [i as Seat, p as MatchPlayerInit | null])
    );
    this.debug = debug;
    this.ruleSetOverride = ruleSetOverride;
    this.presetId = presetId;
    this.runtime = dependencies.runtime ?? createSystemMatchRuntime(seed);
    this.repository = dependencies.repository;
  }

  /**
   * Factory for a waiting-room match: all four seats start empty.
   * Humans claim seats via `claimSeat`; the room transitions to
   * `playing` once `fillBotsAndStart` is called by any seated
   * human (the orchestrator never starts the match automatically).
   */
  static createWaitingRoom(
    matchId: string,
    seed: number,
    dependencies: MatchProcessDependencies,
    debug?: MatchDebug,
    ruleSetOverride?: RuleSetOverride,
    presetId = "tenhou-hanchan"
  ): MatchProcess {
    // Build with four placeholder bots so every field initializer
    // and downstream invariant (players.size === 4) holds, then
    // immediately null the slots out. The placeholders never
    // leave the constructor — they're replaced before any
    // `start()` call.
    const placeholders: MatchPlayerInit[] = [
      { userId: "__empty__:0", displayName: "", isBot: true },
      { userId: "__empty__:1", displayName: "", isBot: true },
      { userId: "__empty__:2", displayName: "", isBot: true },
      { userId: "__empty__:3", displayName: "", isBot: true },
    ];
    const m = new MatchProcess(
      matchId,
      seed,
      placeholders,
      dependencies,
      debug,
      ruleSetOverride,
      presetId
    );
    for (let s = 0; s < 4; s++) {
      m.players.set(s as Seat, null);
    }
    return m;
  }

  /**
   * Factory for a relay/virtual match: no human seats, no rules engine.
   * Events arrive from an external decoder via `injectRelayEvent` and fan out
   * to spectators through the normal omniscient public projection. Starts in
   * `playing` so the spectator handshake accepts it immediately.
   */
  static createRelayMatch(
    matchId: string,
    sourceGameId: string,
    dependencies: MatchProcessDependencies,
    ruleSet = "tenhou-default"
  ): MatchProcess {
    const placeholders: MatchPlayerInit[] = [
      { userId: "__relay__:0", displayName: "", isBot: true },
      { userId: "__relay__:1", displayName: "", isBot: true },
      { userId: "__relay__:2", displayName: "", isBot: true },
      { userId: "__relay__:3", displayName: "", isBot: true },
    ];
    const m = new MatchProcess(
      matchId,
      0,
      placeholders,
      dependencies,
      undefined,
      undefined,
      "tenhou-hanchan"
    );
    m.relayMode = true;
    m.statusValue = "playing";
    m.startedAt = new Date(m.runtime.now());
    m.relaySourceGameId = sourceGameId;
    m.relayRuleSet = ruleSet;
    return m;
  }

  /** Serialize durable state at a supported quiescent boundary. */
  createCheckpoint(): MatchCheckpoint {
    if (this.pausedCheckpoint !== null) {
      return parseMatchCheckpoint(
        JSON.parse(JSON.stringify(this.pausedCheckpoint))
      );
    }
    if (this.commandRecoveryRequired) {
      throw new Error(
        "MatchProcess.createCheckpoint: pending command must be recovered from durable pre-state"
      );
    }
    if (this.statusValue === "waiting") {
      return this.createWaitingRoomCheckpoint();
    }
    if (this.statusValue === "playing") {
      if (this.uncheckpointableTransition !== null) {
        this.checkpointUnsupported(
          `transition ${this.uncheckpointableTransition}`
        );
      }
      if (this.resultTransitionResolve !== null) {
        return this.createPlayingResultTransitionCheckpoint();
      }
      if (this.continueVoteResolve !== null) {
        return this.createPlayingContinueVoteCheckpoint();
      }
      if (this.readyResolve !== null) {
        return this.createPlayingReadyCheckpoint();
      }
      if (this.callWindow.some((window) => window !== null)) {
        return this.createPlayingCallCheckpoint();
      }
      return this.createPlayingActionCheckpoint();
    }
    throw new Error(
      `MatchProcess.createCheckpoint: status "${this.statusValue}" is not supported`
    );
  }

  /**
   * Freeze authoritative mutation before awaiting an atomic repository write.
   * A successful save leaves this process paused; callers may discard it and
   * restore through {@link restoreSavedCheckpoint}. A failed write rolls the
   * same process back to its pre-save action window with clocks still frozen
   * across the failed I/O interval.
   */
  pauseAndSaveCheckpoint(): Promise<MatchCheckpoint> {
    if (this.checkpointSavePromise !== null) {
      return this.checkpointSavePromise;
    }
    if (this.pausedCheckpoint !== null) {
      return Promise.resolve(this.createCheckpoint());
    }
    const checkpoint = this.createCheckpoint();
    this.freezeCheckpoint(checkpoint);
    const saving = this.persistPausedCheckpoint(checkpoint);
    this.checkpointSavePromise = saving;
    return saving;
  }

  private freezeCheckpoint(checkpoint: MatchCheckpoint): void {
    this.pausedCheckpoint = checkpoint;
    this.cancelCheckpointTimers(checkpoint);
  }

  private cancelCheckpointTimers(checkpoint: MatchCheckpoint): void {
    if (checkpoint.status === "playing") {
      if (checkpoint.checkpointKind === "result_transition") {
        this.resultTransitionTimer?.cancel();
        this.resultTransitionTimer = null;
      } else if (checkpoint.checkpointKind === "continue_vote") {
        this.continueVoteTimer?.cancel();
        this.continueVoteTimer = null;
      } else if (checkpoint.checkpointKind === "ready_check") {
        this.readyTimer?.cancel();
        this.readyTimer = null;
      } else {
        const seats =
          checkpoint.checkpointKind === "action_window"
            ? [checkpoint.actionWindow.seat]
            : checkpoint.callWindows.flatMap((window, seat) =>
                window === null ? [] : [seat as Seat]
              );
        for (const seat of seats) {
          this.currentDeadlineTimer[seat]?.cancel();
          this.currentDeadlineTimer[seat] = null;
          this.deadlineEpoch[seat] += 1;
        }
      }
    }
  }

  private resumeCheckpoint(
    checkpoint: MatchCheckpoint,
    armTimers = true
  ): void {
    this.pausedCheckpoint = null;
    if (checkpoint.status === "playing") {
      if (checkpoint.checkpointKind === "action_window") {
        this.installCheckpointActionWindow(checkpoint);
      } else if (checkpoint.checkpointKind === "call_window") {
        this.installCheckpointCallWindows(checkpoint);
      } else if (checkpoint.checkpointKind === "ready_check") {
        this.installCheckpointReadyCheck(checkpoint, false);
      } else if (checkpoint.checkpointKind === "continue_vote") {
        this.installCheckpointContinueVote(checkpoint, false);
      } else {
        this.installCheckpointResultTransition(checkpoint, false);
      }
      if (!armTimers) {
        this.cancelCheckpointTimers(checkpoint);
      }
    }
  }

  private async persistPausedCheckpoint(
    checkpoint: MatchCheckpoint
  ): Promise<MatchCheckpoint> {
    try {
      await this.repository.saveCheckpoint({
        matchId: this.matchId,
        checkpoint,
      });
      return this.createCheckpoint();
    } catch (error) {
      this.resumeCheckpoint(checkpoint);
      throw error;
    } finally {
      this.checkpointSavePromise = null;
    }
  }

  static async restoreSavedCheckpoint(
    matchId: string,
    dependencies: MatchProcessDependencies
  ): Promise<MatchProcess | null> {
    const recovery = await dependencies.repository.loadRecoveryRecord(matchId);
    if (recovery === null) {
      return null;
    }
    const checkpoint = recovery.checkpoint;
    if (checkpoint.matchId !== matchId) {
      throw new Error(
        `MatchProcess.restoreSavedCheckpoint: expected ${matchId}, got ${checkpoint.matchId}`
      );
    }
    const match = MatchProcess.restoreCheckpoint(checkpoint, dependencies);
    if (recovery.pendingCommand !== null) {
      await match.replayPendingCommand(recovery.pendingCommand);
    }
    return match;
  }

  async retryPendingCommandCommit(): Promise<boolean> {
    const checkpoint = this.pendingCommandCommitCheckpoint;
    if (checkpoint === null) {
      return false;
    }
    await this.repository.saveCheckpoint({
      matchId: this.matchId,
      checkpoint,
    });
    this.pendingCommandCommitCheckpoint = null;
    this.resumeCheckpoint(checkpoint);
    return true;
  }

  async deleteSavedCheckpoint(): Promise<void> {
    await this.repository.deleteCheckpoint(this.matchId);
  }

  private checkpointPlayers(
    requireFull: true
  ): PlayingActionCheckpoint["seats"];
  private checkpointPlayers(
    requireFull: false
  ): WaitingRoomCheckpoint["seats"];
  private checkpointPlayers(
    requireFull: boolean
  ):
    | PlayingActionCheckpoint["seats"]
    | WaitingRoomCheckpoint["seats"] {
    const seats = [0, 1, 2, 3].map((seat) => {
      const player = this.players.get(seat as Seat) ?? null;
      return player === null ? null : { ...player };
    });
    if (requireFull && seats.some((player) => player === null)) {
      throw new Error(
        "MatchProcess.createCheckpoint: playing match has an empty seat"
      );
    }
    return seats as
      | PlayingActionCheckpoint["seats"]
      | WaitingRoomCheckpoint["seats"];
  }

  private createWaitingRoomCheckpoint(): WaitingRoomCheckpoint {
    return WaitingRoomCheckpointSchema.parse({
      schemaVersion: MATCH_CHECKPOINT_SCHEMA_VERSION,
      status: "waiting",
      savedAt: this.runtime.now(),
      matchId: this.matchId,
      seed: this.seed,
      presetId: this.presetId,
      ruleSet: resolveRuleSet(this.ruleSetOverride),
      debug: this.debug
        ? {
            ...(this.debug.humanHand
              ? { humanHand: [...this.debug.humanHand] }
              : {}),
            ...(this.debug.humanDraws
              ? { humanDraws: [...this.debug.humanDraws] }
              : {}),
            ...(this.debug.leftDiscards
              ? { leftDiscards: [...this.debug.leftDiscards] }
              : {}),
          }
        : undefined,
      seats: this.checkpointPlayers(false),
    });
  }

  private checkpointUnsupported(reason: string): never {
    throw new Error(
      `MatchProcess.createCheckpoint: playing state is not quiescent (${reason})`
    );
  }

  private async runUncheckpointableTransition(
    transition: NonNullable<MatchProcess["uncheckpointableTransition"]>,
    delayMs: number
  ): Promise<void> {
    if (this.uncheckpointableTransition !== null) {
      throw new Error(
        `MatchProcess: nested transition ${transition} during ${this.uncheckpointableTransition}`
      );
    }
    this.uncheckpointableTransition = transition;
    try {
      await this.runtime.sleep(delayMs);
    } finally {
      if (this.uncheckpointableTransition === transition) {
        this.uncheckpointableTransition = null;
      }
    }
  }

  private assertCommonPlayingCheckpointState(
    allowReady = false,
    allowVote = false
  ): void {
    if (this.relayMode) {
      this.checkpointUnsupported("relay match");
    }
    if (
      !allowVote &&
      (this.continueVoteResolve !== null || this.continueVoteTimer !== null)
    ) {
      this.checkpointUnsupported("vote continuation");
    }
    if (
      !allowReady &&
      (this.readyResolve !== null || this.readyTimer !== null)
    ) {
      this.checkpointUnsupported("ready continuation");
    }
    if (
      this.delayedSpectators.size > 0 ||
      this.livenessProbeInflight.some(Boolean)
    ) {
      this.checkpointUnsupported("delayed spectator or liveness work");
    }
    if (
      this.pendingWinRevealMs !== 0 ||
      (!allowVote && this.finalized) ||
      this.sessionFinalized
    ) {
      this.checkpointUnsupported("result or finalization work");
    }
  }

  private playingCheckpointBase(savedAt: number) {
    return {
      schemaVersion: MATCH_CHECKPOINT_SCHEMA_VERSION,
      status: "playing" as const,
      savedAt,
      matchId: this.matchId,
      seed: this.seed,
      presetId: this.presetId,
      seats: this.checkpointPlayers(true),
      state: this.state,
      startedAgoMs: Math.max(
        0,
        savedAt - (this.startedAt?.getTime() ?? savedAt)
      ),
      randomState: this.runtime.captureRandomState(),
      eventLog: this.eventLog.map((entry) => ({
        seq: entry.seq,
        event: entry.event,
        emittedAgoMs: Math.max(0, savedAt - entry.emittedAt),
      })),
      nextSeq: this.nextSeq,
      seatSeq: [...this.seatSeq],
      spectatorSeq: this.spectatorSeq,
      handStartLiveWall: this.handStartLiveWall
        ? [...this.handStartLiveWall]
        : null,
      gameStartLogIdx: this.gameStartLogIdx,
      gameIndex: this.gameIndex,
      sessionChips: [...this.sessionChips],
      gameStartChips: [...this.gameStartChips],
      sessionDabuken: [...this.sessionDabuken],
      dice: [...this.dice],
      riichiTileIdx: [...this.riichiTileIdx],
      humanDrawQueue: [...this.humanDrawQueue],
      leftDiscardQueue: [...this.leftDiscardQueue],
      bufferMs: [...this.bufferMs],
      connectionPolicy: {
        disconnected: [...this.disconnected],
        afkSelfReported: [...this.afkSelfReported],
        livenessProbeMisses: [...this.livenessProbeMisses],
      },
      lastEngineEventType: this.lastEngineEventType,
    };
  }

  private createPlayingActionCheckpoint(): PlayingActionCheckpoint {
    this.assertCommonPlayingCheckpointState();
    if (this.state.phase !== "awaiting_discard") {
      this.checkpointUnsupported(`engine phase ${this.state.phase}`);
    }
    if (
      this.callWindow.some((window) => window !== null) ||
      this.pendingHumanCallActions.some((action) => action !== null) ||
      this.pendingBotRons.length > 0 ||
      this.pendingBotCalls.length > 0 ||
      this.pendingChankanBotRons.length > 0
    ) {
      this.checkpointUnsupported("call resolution");
    }

    const seat = this.state.turn;
    const player = this.players.get(seat);
    if (!player || player.isBot) {
      this.checkpointUnsupported("active seat is not human");
    }
    if (this.disconnected[seat] || this.afkSelfReported[seat]) {
      this.checkpointUnsupported("active seat is disconnected or AFK");
    }
    const legalActions = this.legalActions[seat];
    if (
      legalActions.length === 0 ||
      this.legalActions.some(
        (actions, candidate) => candidate !== seat && actions.length > 0
      )
    ) {
      this.checkpointUnsupported("expected exactly one legal-action window");
    }
    const actionStartedAt = this.currentActionStartMs[seat];
    const visibleDeadline = this.currentDeadline[seat];
    if (
      actionStartedAt === null ||
      visibleDeadline === null ||
      this.currentDeadlineTimer[seat] === null
    ) {
      this.checkpointUnsupported("action timer is not active");
    }

    const savedAt = this.runtime.now();
    const elapsedMs = Math.max(0, savedAt - actionStartedAt);
    const expiryRemainingMs = Math.max(
      0,
      BASE_ACTION_MS +
        this.bufferMs[seat] +
        ACTION_GRACE_MS -
        elapsedMs
    );
    return PlayingActionCheckpointSchema.parse({
      ...this.playingCheckpointBase(savedAt),
      checkpointKind: "action_window",
      actionWindow: {
        seat,
        legalActions,
        elapsedMs,
        visibleRemainingMs: Math.max(0, visibleDeadline - savedAt),
        expiryRemainingMs,
      },
    });
  }

  private createPlayingCallCheckpoint(): PlayingCallCheckpoint {
    this.assertCommonPlayingCheckpointState();
    if (
      this.state.phase !== "awaiting_draw" &&
      this.state.phase !== "awaiting_chankan"
    ) {
      this.checkpointUnsupported(`engine phase ${this.state.phase}`);
    }
    const savedAt = this.runtime.now();
    const callTimers = this.callWindow.map((options, seatIndex) => {
      if (options === null) {
        if (
          this.currentDeadlineTimer[seatIndex] !== null ||
          this.currentActionStartMs[seatIndex] !== null ||
          this.currentDeadline[seatIndex] !== null ||
          this.legalActions[seatIndex].length > 0
        ) {
          this.checkpointUnsupported(
            "closed call window retains action state"
          );
        }
        return null;
      }
      const seat = seatIndex as Seat;
      if (this.disconnected[seat] || this.afkSelfReported[seat]) {
        this.checkpointUnsupported("open call seat is disconnected or AFK");
      }
      const startedAt = this.currentActionStartMs[seat];
      const deadline = this.currentDeadline[seat];
      if (
        startedAt === null ||
        deadline === null ||
        this.currentDeadlineTimer[seat] === null ||
        this.legalActions[seat].length === 0
      ) {
        this.checkpointUnsupported("open call window timer is incomplete");
      }
      const elapsedMs = Math.max(0, savedAt - startedAt);
      return {
        legalActions: this.legalActions[seat],
        elapsedMs,
        visibleRemainingMs: Math.max(0, deadline - savedAt),
        expiryRemainingMs: Math.max(
          0,
          BASE_ACTION_MS +
            this.bufferMs[seat] +
            ACTION_GRACE_MS -
            elapsedMs
        ),
      };
    });
    return PlayingCallCheckpointSchema.parse({
      ...this.playingCheckpointBase(savedAt),
      checkpointKind: "call_window",
      callWindows: this.callWindow,
      pendingHumanCallActions: this.pendingHumanCallActions,
      pendingBotRons: [...this.pendingBotRons],
      pendingBotCalls: this.pendingBotCalls,
      pendingChankanBotRons: [...this.pendingChankanBotRons],
      callTimers,
    });
  }

  private createPlayingReadyCheckpoint(): PlayingReadyCheckpoint {
    this.assertCommonPlayingCheckpointState(true);
    if (
      this.readyResolve === null ||
      this.readyTimer === null ||
      this.readyDeadline === null
    ) {
      this.checkpointUnsupported("ready timer is incomplete");
    }
    if (this.readyContinuationKind === null) {
      this.checkpointUnsupported("unsupported ready continuation");
    }
    if (
      this.callWindow.some((window) => window !== null) ||
      this.pendingHumanCallActions.some((action) => action !== null) ||
      this.pendingBotRons.length > 0 ||
      this.pendingBotCalls.length > 0 ||
      this.pendingChankanBotRons.length > 0 ||
      this.legalActions.some((actions) => actions.length > 0) ||
      this.currentDeadlineTimer.some((timer) => timer !== null)
    ) {
      this.checkpointUnsupported("ready check retains action state");
    }
    const savedAt = this.runtime.now();
    return PlayingReadyCheckpointSchema.parse({
      ...this.playingCheckpointBase(savedAt),
      checkpointKind: "ready_check",
      readyContinuation: this.readyContinuationKind,
      readyAcked: [...this.readyAcked],
      readyRemainingMs: Math.max(0, this.readyDeadline - savedAt),
    });
  }

  private createPlayingContinueVoteCheckpoint(): PlayingContinueVoteCheckpoint {
    this.assertCommonPlayingCheckpointState(false, true);
    if (
      this.continueVoteResolve === null ||
      this.continueVoteDeadline === null ||
      this.continueVoteFinalScores === null
    ) {
      this.checkpointUnsupported("continue vote is incomplete");
    }
    if (
      this.readyResolve !== null ||
      this.readyTimer !== null ||
      this.callWindow.some((window) => window !== null) ||
      this.legalActions.some((actions) => actions.length > 0) ||
      this.currentDeadlineTimer.some((timer) => timer !== null)
    ) {
      this.checkpointUnsupported("continue vote retains action state");
    }
    const savedAt = this.runtime.now();
    return PlayingContinueVoteCheckpointSchema.parse({
      ...this.playingCheckpointBase(savedAt),
      checkpointKind: "continue_vote",
      votes: [...this.continueVote],
      voteRemainingMs: Math.max(0, this.continueVoteDeadline - savedAt),
      timeoutArmed: this.continueVoteTimer !== null,
      finalScores: this.continueVoteFinalScores,
    });
  }

  private createPlayingResultTransitionCheckpoint(): PlayingResultTransitionCheckpoint {
    this.assertCommonPlayingCheckpointState();
    if (
      this.resultTransitionResolve === null ||
      this.resultTransitionTimer === null ||
      this.resultTransitionDeadline === null ||
      this.resultTransitionKind === null
    ) {
      this.checkpointUnsupported("result transition is incomplete");
    }
    if (
      this.readyResolve !== null ||
      this.continueVoteResolve !== null ||
      this.callWindow.some((window) => window !== null) ||
      this.legalActions.some((actions) => actions.length > 0) ||
      this.currentDeadlineTimer.some((timer) => timer !== null)
    ) {
      this.checkpointUnsupported("result transition retains input state");
    }
    const savedAt = this.runtime.now();
    return PlayingResultTransitionCheckpointSchema.parse({
      ...this.playingCheckpointBase(savedAt),
      checkpointKind: "result_transition",
      transitionKind: this.resultTransitionKind,
      transitionRemainingMs: Math.max(
        0,
        this.resultTransitionDeadline - savedAt
      ),
      nextReadyMs: this.resultTransitionNextReadyMs,
    });
  }

  /** Restore validated state with every network attachment detached. */
  static restoreCheckpoint(
    input: unknown,
    dependencies: MatchProcessDependencies
  ): MatchProcess {
    const checkpoint = parseMatchCheckpoint(input);
    if (checkpoint.status === "waiting") {
      const match = MatchProcess.createWaitingRoom(
        checkpoint.matchId,
        checkpoint.seed,
        dependencies,
        checkpoint.debug,
        checkpoint.ruleSet,
        checkpoint.presetId
      );
      for (let seat = 0; seat < 4; seat++) {
        const player = checkpoint.seats[seat];
        match.players.set(seat as Seat, player === null ? null : { ...player });
      }
      return match;
    }

    const match = new MatchProcess(
      checkpoint.matchId,
      checkpoint.seed,
      checkpoint.seats.map((player) => ({ ...player })),
      dependencies,
      undefined,
      checkpoint.state.ruleSet,
      checkpoint.presetId
    );
    const restoredAt = match.runtime.now();
    match.statusValue = "playing";
    match.state = checkpoint.state;
    match.startedAt = new Date(restoredAt - checkpoint.startedAgoMs);
    match.runtime.restoreRandomState(checkpoint.randomState);
    for (const entry of checkpoint.eventLog) {
      match.eventLog.push({
        seq: entry.seq,
        event: entry.event,
        emittedAt: restoredAt - entry.emittedAgoMs,
      });
    }
    match.nextSeq = checkpoint.nextSeq;
    match.seatSeq = [...checkpoint.seatSeq];
    match.spectatorSeq = checkpoint.spectatorSeq;
    match.handStartLiveWall = checkpoint.handStartLiveWall
      ? [...checkpoint.handStartLiveWall]
      : null;
    match.gameStartLogIdx = checkpoint.gameStartLogIdx;
    match.gameIndex = checkpoint.gameIndex;
    match.sessionChips = [...checkpoint.sessionChips];
    match.gameStartChips = [...checkpoint.gameStartChips];
    match.sessionDabuken = [...checkpoint.sessionDabuken];
    match.dice = [...checkpoint.dice];
    match.riichiTileIdx = [...checkpoint.riichiTileIdx];
    match.humanDrawQueue = [...checkpoint.humanDrawQueue];
    match.leftDiscardQueue = [...checkpoint.leftDiscardQueue];
    match.bufferMs = [...checkpoint.bufferMs];
    match.lastEngineEventType = checkpoint.lastEngineEventType;
    match.disconnected = [...checkpoint.connectionPolicy.disconnected];
    match.afkSelfReported = [...checkpoint.connectionPolicy.afkSelfReported];
    match.livenessProbeMisses = [
      ...checkpoint.connectionPolicy.livenessProbeMisses,
    ];

    if (checkpoint.checkpointKind === "action_window") {
      match.installCheckpointActionWindow(checkpoint);
    } else if (checkpoint.checkpointKind === "call_window") {
      match.installCheckpointCallWindows(checkpoint);
    } else if (checkpoint.checkpointKind === "ready_check") {
      match.installCheckpointReadyCheck(checkpoint, true);
    } else if (checkpoint.checkpointKind === "continue_vote") {
      match.installCheckpointContinueVote(checkpoint, true);
    } else {
      match.installCheckpointResultTransition(checkpoint, true);
    }
    return match;
  }

  private installCheckpointActionWindow(
    checkpoint: PlayingActionCheckpoint
  ): void {
    const restoredAt = this.runtime.now();
    const { actionWindow } = checkpoint;
    const seat = actionWindow.seat;
    this.currentDeadlineTimer[seat]?.cancel();
    this.legalActions = [[], [], [], []];
    this.legalActions[seat] = actionWindow.legalActions.map((action) => ({
      ...action,
      ...(action.tiles ? { tiles: [...action.tiles] } : {}),
    }));
    this.bufferMs = [...checkpoint.bufferMs];
    this.currentActionStartMs = [null, null, null, null];
    this.currentDeadline = [null, null, null, null];
    this.currentDeadlineTimer = [null, null, null, null];
    this.currentActionStartMs[seat] = restoredAt - actionWindow.elapsedMs;
    this.currentDeadline[seat] =
      restoredAt + actionWindow.visibleRemainingMs;
    this.deadlineEpoch[seat] += 1;
    const epoch = this.deadlineEpoch[seat];
    this.currentDeadlineTimer[seat] = this.runtime.schedule(
      () => {
        if (this.deadlineEpoch[seat] !== epoch || this.isPaused) {
          return;
        }
        void this.handleDeadlineExpiry(seat);
      },
      actionWindow.expiryRemainingMs,
      { unref: true }
    );
  }

  private installCheckpointCallWindows(
    checkpoint: PlayingCallCheckpoint
  ): void {
    const restoredAt = this.runtime.now();
    this.callWindow = checkpoint.callWindows.map((options) =>
      options === null
        ? null
        : options.map((option) =>
            option.kind === "ron"
              ? { kind: "ron" as const }
              : { kind: option.kind, tiles: [...option.tiles] } as CallOption
          )
    );
    this.pendingHumanCallActions = checkpoint.pendingHumanCallActions.map(
      (action) =>
        action === null
          ? null
          : {
              ...action,
              ...(action.tiles ? { tiles: [...action.tiles] } : {}),
            }
    );
    this.pendingBotRons = [...checkpoint.pendingBotRons];
    this.pendingBotCalls = checkpoint.pendingBotCalls.map(({ seat, option }) => ({
      seat,
      option:
        option.kind === "ron"
          ? { kind: "ron" }
          : { kind: option.kind, tiles: [...option.tiles] } as CallOption,
    }));
    this.pendingChankanBotRons = [...checkpoint.pendingChankanBotRons];
    this.bufferMs = [...checkpoint.bufferMs];
    this.legalActions = [[], [], [], []];
    this.currentActionStartMs = [null, null, null, null];
    this.currentDeadline = [null, null, null, null];
    this.currentDeadlineTimer = [null, null, null, null];
    for (let seatIndex = 0; seatIndex < 4; seatIndex++) {
      const timer = checkpoint.callTimers[seatIndex];
      if (timer === null) {
        continue;
      }
      const seat = seatIndex as Seat;
      this.legalActions[seat] = timer.legalActions.map((action) => ({
        ...action,
        ...(action.tiles ? { tiles: [...action.tiles] } : {}),
      }));
      this.currentActionStartMs[seat] = restoredAt - timer.elapsedMs;
      this.currentDeadline[seat] = restoredAt + timer.visibleRemainingMs;
      this.deadlineEpoch[seat] += 1;
      const epoch = this.deadlineEpoch[seat];
      this.currentDeadlineTimer[seat] = this.runtime.schedule(
        () => {
          if (this.deadlineEpoch[seat] !== epoch || this.isPaused) {
            return;
          }
          void this.handleDeadlineExpiry(seat);
        },
        timer.expiryRemainingMs,
        { unref: true }
      );
    }
  }

  private installCheckpointReadyCheck(
    checkpoint: PlayingReadyCheckpoint,
    restored: boolean
  ): void {
    const continuation = checkpoint.readyContinuation;
    this.readyAcked = [...checkpoint.readyAcked];
    this.readyDeadline = this.runtime.now() + checkpoint.readyRemainingMs;
    this.readyContinuationKind = continuation;
    if (restored) {
      this.readyResolve = () => {
        void this.resumeReadyContinuation(continuation);
      };
    } else if (this.readyResolve === null) {
      throw new Error(
        "MatchProcess.installCheckpointReadyCheck: missing live continuation"
      );
    }
    this.readyTimer?.cancel();
    this.readyTimer = this.runtime.schedule(
      () => {
        if (!this.isPaused) {
          this.finishReadyCheck();
        }
      },
      checkpoint.readyRemainingMs,
      { unref: true }
    );
  }

  private async resumeReadyContinuation(
    continuation: PlayingReadyCheckpoint["readyContinuation"]
  ): Promise<void> {
    if (continuation === "initial_hand") {
      await this.beginInitialHandAfterReady();
    } else {
      await this.beginNextHandAfterReady();
    }
  }

  private installCheckpointContinueVote(
    checkpoint: PlayingContinueVoteCheckpoint,
    restored: boolean
  ): void {
    const finalScores = checkpoint.finalScores.map((score) => ({ ...score }));
    this.continueVote = [...checkpoint.votes];
    this.continueVoteDeadline =
      this.runtime.now() + checkpoint.voteRemainingMs;
    this.continueVoteFinalScores = finalScores;
    this.lastVoteReason = null;
    this.finalized = true;
    if (restored) {
      this.continueVoteResolve = (cont) => {
        void this.continueAfterVote(cont, finalScores);
      };
    } else if (this.continueVoteResolve === null) {
      throw new Error(
        "MatchProcess.installCheckpointContinueVote: missing live continuation"
      );
    }
    this.continueVoteTimer?.cancel();
    this.continueVoteTimer = checkpoint.timeoutArmed
      ? this.runtime.schedule(
          () => {
            if (this.isPaused) {
              return;
            }
            this.lastVoteReason = "vote_timeout";
            this.finishContinueVote(false);
          },
          checkpoint.voteRemainingMs,
          { unref: true }
        )
      : null;
  }

  private installCheckpointResultTransition(
    checkpoint: PlayingResultTransitionCheckpoint,
    restored: boolean
  ): void {
    const transitionKind = checkpoint.transitionKind;
    const nextReadyMs = checkpoint.nextReadyMs;
    this.resultTransitionKind = transitionKind;
    this.resultTransitionDeadline =
      this.runtime.now() + checkpoint.transitionRemainingMs;
    this.resultTransitionNextReadyMs = nextReadyMs;
    if (restored) {
      this.resultTransitionResolve = () => {
        void this.resumeResultTransition(transitionKind, nextReadyMs);
      };
    } else if (this.resultTransitionResolve === null) {
      throw new Error(
        "MatchProcess.installCheckpointResultTransition: missing live continuation"
      );
    }
    this.resultTransitionTimer?.cancel();
    this.resultTransitionTimer = this.runtime.schedule(
      () => {
        this.finishResultTransition();
      },
      checkpoint.transitionRemainingMs,
      { unref: true }
    );
  }

  private runResultTransition(
    transitionKind: PlayingResultTransitionCheckpoint["transitionKind"],
    delayMs: number,
    nextReadyMs: number
  ): Promise<void> {
    this.resultTransitionKind = transitionKind;
    this.resultTransitionDeadline = this.runtime.now() + delayMs;
    this.resultTransitionNextReadyMs = nextReadyMs;
    return new Promise<void>((resolve) => {
      this.resultTransitionResolve = resolve;
      this.resultTransitionTimer = this.runtime.schedule(
        () => {
          this.finishResultTransition();
        },
        delayMs,
        { unref: true }
      );
    });
  }

  private finishResultTransition(): void {
    if (this.isPaused) {
      return;
    }
    this.resultTransitionTimer?.cancel();
    this.resultTransitionTimer = null;
    const resolve = this.resultTransitionResolve;
    this.resultTransitionResolve = null;
    this.resultTransitionDeadline = null;
    this.resultTransitionKind = null;
    this.resultTransitionNextReadyMs = 0;
    resolve?.();
  }

  private async resumeResultTransition(
    transitionKind: PlayingResultTransitionCheckpoint["transitionKind"],
    nextReadyMs: number
  ): Promise<void> {
    if (transitionKind === "post_hand_reveal" && nextReadyMs > 0) {
      await this.runReadyCheck(nextReadyMs, "next_hand");
    }
    await this.beginNextHandAfterReady();
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async start(): Promise<void> {
    this.assertNotPaused("start");
    if (this.statusValue !== "waiting") {
      throw new Error(
        `MatchProcess.start: cannot start from status "${this.statusValue}"`
      );
    }
    for (const [seat, p] of this.players) {
      if (p === null) {
        throw new Error(
          `MatchProcess.start: seat ${seat} is empty; fill bots or claim it first`
        );
      }
    }
    this.statusValue = "playing";
    this.startedAt = new Date(this.runtime.now());
    this.state = createInitialState(this.seed, {
      ruleSet: this.ruleSetOverride,
    });
    // Snapshot starting chips for this game so `match_end` can
    // emit the per-game chip delta (Buu-only display in the
    // end-of-game panel). For non-Buu rule sets the starting
    // chips are zero, so the delta stays zero too.
    this.gameStartChips = [...this.state.chips] as [
      number,
      number,
      number,
      number,
    ];
    // Push a fresh `room_state` so clients can dismiss the
    // waiting-room overlay as soon as the match flips to
    // `playing` — otherwise the previously-sent waiting frame
    // keeps the overlay mounted over the live table.
    this.broadcastRoomState();

    // Apply debug seed (no validation — dev surface only).
    if (this.debug) {
      if (this.debug.humanHand && this.debug.humanHand.length === 13) {
        this.state.hands[0] = [...this.debug.humanHand];
      }
      this.humanDrawQueue = this.debug.humanDraws
        ? [...this.debug.humanDraws]
        : [];
      this.leftDiscardQueue = this.debug.leftDiscards
        ? [...this.debug.leftDiscards]
        : [];
    }

    const matchPlayers: PersistedMatchPlayer[] = [];
    for (const [seat, p] of this.players) {
      if (p === null) {
        // Already asserted above; satisfies the type narrower.
        continue;
      }
      matchPlayers.push({
        userId: p.userId,
        seat,
        displayName: p.displayName,
        isBot: p.isBot,
      });
    }
    const isBuu = this.state.ruleSet.buuMode;
    await this.repository.createMatch({
      matchId: this.currentGameMongoId(),
      seed: this.seed,
      players: matchPlayers,
      ...(isBuu ? { sessionId: this.matchId, gameIndex: this.gameIndex } : {}),
    });

    // Track where this game starts in the omniscient log so
    // `archiveCurrentGame` can slice precisely on match_end.
    this.gameStartLogIdx = this.eventLog.length;

    await this.emitEvent({
      type: "match_start",
      seats: matchPlayers.map((p) => ({
        seat: p.seat,
        userId: p.userId,
        displayName: p.displayName,
      })),
      ruleSet: this.state.ruleSet.buuMode ? "buu-east" : "tenhou-default",
      riichiBetValue: this.state.ruleSet.riichiBetValue,
      ...(this.state.ruleSet.scoreCap
        ? { scoreCap: this.state.ruleSet.scoreCap }
        : {}),
      ...(this.state.ruleSet.buuMode
        ? {
            chips: [...this.state.chips] as [number, number, number, number],
            dabuken: [...this.state.dabuken] as [
              boolean,
              boolean,
              boolean,
              boolean,
            ],
          }
        : {}),
    });

    // Pre-match ready check. Bots are pre-acked; if the human
    // is the only seat that hasn't acked we wait up to
    // `READY_CHECK_MS` for their ack before dealing.
    await this.runReadyCheck(READY_CHECK_MS, "initial_hand");

    await this.beginInitialHandAfterReady();
  }

  private async beginInitialHandAfterReady(): Promise<void> {
    // Per-seat hand redaction is handled in `sendToSeat`; the
    // recipient's hand is attached there. The omniscient
    // `startingHands` snapshot needed for replay archival is added
    // by `emitEvent` when it appends to `eventLog` — the wire
    // event itself never carries it.
    await this.emitEvent({
      type: "hand_start",
      round: 0,
      dealer: this.state.dealer,
      roundWind: this.state.roundWind,
      roundNumber: this.state.roundNumber,
      honba: this.state.honba,
      riichiSticks: this.state.riichiSticks,
      scores: [...this.state.scores] as [number, number, number, number],
      sinking: this.computeSinking(),
      hand: undefined,
      doraIndicators: this.state.doraIndicators,
      dice: this.rollDice(),
    });

    await this.advanceTurn();
  }

  /**
   * Wait for the human to ack a ready check (pre-match or
   * between hands) — whichever comes first: every seat acked,
   * or `ms` milliseconds elapsed. Bots are pre-acked.
   * No-ops when `ms <= 0` (test path).
   */
  private async runReadyCheck(
    ms: number = READY_CHECK_MS,
    continuation: PlayingReadyCheckpoint["readyContinuation"] | null = null
  ): Promise<void> {
    this.readyContinuationKind = null;
    for (const [seat, p] of this.players) {
      // `start()` guarantees no null slots reach here.
      this.readyAcked[seat] = p?.isBot ?? true;
    }
    if (ms <= 0 || this.readyAcked.every((a) => a)) {
      this.readyDeadline = null;
      return;
    }
    this.readyContinuationKind = continuation;
    this.readyDeadline = this.runtime.now() + ms;
    this.broadcastReadyCheck();
    await new Promise<void>((resolve) => {
      this.readyResolve = resolve;
      this.readyTimer = this.runtime.schedule(
        () => {
          this.finishReadyCheck();
        },
        ms,
        { unref: true }
      );
    });
  }

  /**
   * Mark the given seat as acked. Resolves the pending ready
   * check immediately when all seats are acked. No-op when the
   * ready check has already finished.
   */
  handleReady(seat: Seat): void {
    if (this.isPaused) {
      return;
    }
    if (this.readyResolve === null) {
      return;
    }
    if (this.readyAcked[seat]) {
      return;
    }
    this.readyAcked[seat] = true;
    if (this.readyAcked.every((a) => a)) {
      this.finishReadyCheck();
    } else {
      this.broadcastReadyCheck();
    }
  }

  private finishReadyCheck(): void {
    if (this.isPaused) {
      return;
    }
    if (this.readyTimer) {
      this.readyTimer.cancel();
      this.readyTimer = null;
    }
    const resolve = this.readyResolve;
    this.readyResolve = null;
    this.readyDeadline = null;
    this.readyContinuationKind = null;
    // Notify every attached human (any seat) that the ready check
    // is over so they all clear their overlays in lockstep.
    for (const seat of this.humanSeats()) {
      const send = this.humanSockets[seat];
      if (send) {
        send({ type: "ready_check_end" });
      }
    }
    if (resolve) {
      resolve();
    }
  }

  private broadcastReadyCheck(): void {
    if (this.readyDeadline === null) {
      return;
    }
    const frame: ServerMessage = {
      type: "ready_check",
      deadline: this.readyDeadline,
      acked: [...this.readyAcked] as [boolean, boolean, boolean, boolean],
    };
    for (const seat of this.humanSeats()) {
      const send = this.humanSockets[seat];
      if (send) {
        send(frame);
      }
    }
  }

  /**
   * Hook `send` as the WS sender for a specific seat. Any prior
    * attachment at that seat is superseded. Late frames and closes
    * from that attachment are rejected by sender identity. Throws if
    * the seat is a bot — the orchestrator drives bots directly.
   *
   * Optional `livenessProbe`: invoked by the orchestrator the
   * first time a seat exhausts its think buffer to ask the WS
   * layer to ping the client and report whether a pong came back.
   * A false result flags the seat as `disconnected` and switches
   * future action windows to immediate auto-default (no waiting).
   */
  attachHuman(
    seat: Seat,
    send: Send,
    livenessProbe?: () => Promise<boolean>
  ): void {
    const player = this.players.get(seat);
    if (player === null || player === undefined) {
      throw new Error(
        `attachHuman: seat ${seat} is unclaimed; call claimSeat() first`
      );
    }
    if (player.isBot) {
      throw new Error(
        `attachHuman: seat ${seat} is a bot; cannot attach a human socket`
      );
    }
    this.humanConnectionGeneration[seat] += 1;
    this.humanSockets[seat] = send;
    this.livenessProbes[seat] = livenessProbe ?? null;
    this.livenessProbeMisses[seat] = 0;
    this.livenessProbeInflight[seat] = false;
    // A network-only reconnect auto-clears the disconnect flag
    // so the orchestrator stops auto-defaulting the player's
    // turns the instant their socket is back. Self-reported AFK
    // (handleAfk(true) from the client) still requires an
    // explicit `afk: false` from the user — the player chose to
    // step away, they should choose to step back.
    if (this.disconnected[seat] && !this.afkSelfReported[seat]) {
      this.disconnected[seat] = false;
    }
    // If a ready check is currently in flight (e.g. the human
    // reconnected mid-countdown), re-send the latest state so
    // their overlay can pick up the deadline. Re-broadcasting to
    // every attached human is harmless — the ack bitmap is global.
    if (this.readyDeadline !== null) {
      this.broadcastReadyCheck();
    }
    // Connection state for this seat just flipped to
    // `connected: true` (or stayed disconnected if the AFK flag
    // is set). Either way, surface to everyone — humans AND
    // spectators — so badges update in lockstep.
    this.broadcastRoomState();
    this.broadcastViewerState();
  }

  /**
   * Compute the per-seat "sinking" flag tuple for the current
   * engine state. Always `[false, false, false, false]` when the
   * rule set is not Buu (`sinkThreshold` is technically a real
   * number then too but no UI consumes it). Called at every
   * `hand_start` emission and after each riichi declaration
   * (the only mid-hand event whose score deduction can push a
   * seat under the threshold).
   */
  private computeSinking(): [boolean, boolean, boolean, boolean] {
    if (!this.state.ruleSet.buuMode) {
      return [false, false, false, false];
    }
    const t = this.state.ruleSet.sinkThreshold;
    return [
      this.state.scores[0] <= t,
      this.state.scores[1] <= t,
      this.state.scores[2] <= t,
      this.state.scores[3] <= t,
    ];
  }

  isHumanAttached(seat: Seat, send: Send): boolean {
    return this.humanSockets[seat] === send;
  }

  humanSeatFor(send: Send): Seat | null {
    for (let seat = 0; seat < 4; seat++) {
      if (this.humanSockets[seat] === send) {
        return seat as Seat;
      }
    }
    return null;
  }

  detachHuman(seat: Seat, expectedSend?: Send): boolean {
    if (
      this.humanSockets[seat] === null ||
      (expectedSend !== undefined && !this.isHumanAttached(seat, expectedSend))
    ) {
      return false;
    }
    this.humanConnectionGeneration[seat] += 1;
    this.humanSockets[seat] = null;
    this.livenessProbes[seat] = null;
    this.livenessProbeInflight[seat] = false;
    if (this.isPaused) {
      this.broadcastRoomState();
      this.broadcastViewerState();
      return true;
    }
    // Network-disconnected seats are treated as AFK for the
    // skip/auto-discard machinery. A future re-attach with a
    // working socket auto-clears the flag (see `attachHuman`).
    // `afkSelfReported` is intentionally NOT set here — the
    // user did not choose to opt out, the network did.
    if (this.statusValue === "playing") {
      this.disconnected[seat] = true;
      // Trigger an immediate auto-default if the seat had an
      // open window — bots and other humans shouldn't have to
      // wait the full deadline for someone who just unplugged.
      if (this.legalActions[seat].length > 0) {
        void this.handleDeadlineExpiry(seat);
      }
    }
    this.broadcastRoomState();
    this.broadcastViewerState();
    return true;
  }

  /**
   * True if any seat is occupied by a non-bot player whose
   * WebSocket is currently attached. Used by the orchestrator
   * to detect when the last human leaves an in-progress match so
   * it can abort + drop the room from memory. Bots and empty
   * seats do not count; a seat held by a disconnected human
   * (socket null) does not count either.
   */
  hasConnectedHumanPlayers(): boolean {
    for (let s = 0; s < 4; s++) {
      const seat = s as Seat;
      const p = this.players.get(seat);
      if (p && !p.isBot && this.humanSockets[seat] !== null) {
        return true;
      }
    }
    return false;
  }

  /**
   * True if any seat is currently held by a non-bot player,
   * regardless of socket attachment. Used by the orchestrator
   * to decide whether to evict an abandoned waiting room: a
   * waiting room with no seated humans (and no live sockets)
   * has nobody who could possibly reconnect to it, so it can
   * be dropped from memory.
   */
  hasSeatedHumans(): boolean {
    for (let s = 0; s < 4; s++) {
      const seat = s as Seat;
      const p = this.players.get(seat);
      if (p && !p.isBot) {
        return true;
      }
    }
    return false;
  }

  /**
   * Abort an in-progress match because every seated human has
   * disconnected. Idempotent. Cancels any in-flight ready-check
   * timer, per-seat deadline timers, and continue-vote window;
   * then finalizes the session with `reason: "server_abort"` so
   * any attached spectator sees a clean shutdown frame. No-op if
   * the match is already finished.
   *
   * The orchestrator is expected to drop the entry from its
   * in-memory registry and close any spectator sockets it still
   * holds AFTER this call returns.
   */
  async abortAbandoned(): Promise<void> {
    if (this.isPaused) {
      return;
    }
    if (this.statusValue === "finished" || this.sessionFinalized) {
      return;
    }
    // Cancel any pending ready-check timer.
    if (this.readyTimer) {
      this.readyTimer.cancel();
      this.readyTimer = null;
    }
    // Cancel any per-seat action deadline timers.
    for (let s = 0; s < 4; s++) {
      const t = this.currentDeadlineTimer[s];
      if (t) {
        t.cancel();
        this.currentDeadlineTimer[s] = null;
      }
    }
    // If a continue-vote is open, resolve it as "no" so the
    // awaiting `endMatch` flow unwinds cleanly. Our subsequent
    // `finalizeSession` call is idempotent so the second
    // finalize from that path is a no-op.
    if (this.continueVoteResolve) {
      this.finishContinueVote(false);
    }
    await this.finalizeSession("server_abort");
  }

  /**
   * Apply the client's self-reported AFK status for `seat`.
   * `afk=true` flips the disconnect flag and immediately auto-
   * defaults any open window. `afk=false` clears the flag and
   * leaves the existing deadline timer in place (the player
   * just rejoined; their remaining buffer is whatever the timer
   * was already scheduled against).
   */
  handleAfk(seat: Seat, afk: boolean): void {
    if (this.isPaused) {
      return;
    }
    if (this.disconnected[seat] === afk) {
      // Even when the disconnect flag itself doesn't move, an
      // explicit `afk: false` from the client should clear the
      // self-reported sticky bit so a subsequent network blip
      // can be auto-recovered by `attachHuman`.
      if (!afk) {
        this.afkSelfReported[seat] = false;
      }
      return;
    }
    this.disconnected[seat] = afk;
    this.afkSelfReported[seat] = afk;
    if (!afk) {
      this.livenessProbeMisses[seat] = 0;
    }
    this.broadcastRoomState();
    if (afk && this.legalActions[seat].length > 0) {
      void this.handleDeadlineExpiry(seat);
    }
  }

  /**
   * Register a spectator send hook. The same `send` may be
   * attached multiple times safely (deduplicated by `Set`). The
   * caller is responsible for calling `detachSpectator(send)` on
   * disconnect.
   *
   * Spectators receive the public projection of every subsequent
   * `emitEvent` plus, on attach, a fresh public snapshot from
   * `buildSpectatorSnapshot()` (sent by the caller). They have no
   * seat, no legal actions, and no deadline.
   */
  attachSpectator(send: Send, viewer?: ViewerPresence): void {
    this.spectatorSockets.add(send);
    if (viewer) {
      this.spectatorViewers.set(send, viewer);
    }
    // Hydrate the spectator with the latest room composition so
    // disconnect badges paint correctly before the next public
    // event arrives.
    send(this.buildRoomState(null));
    this.broadcastViewerState();
  }

  detachSpectator(send: Send): void {
    this.spectatorSockets.delete(send);
    this.spectatorViewers.delete(send);
    this.broadcastViewerState();
  }

  /**
   * Register a delayed-spectator session. The session dispatches
   * each public-projected event only once `emittedAt + delayMs`
   * has elapsed; the spectator-seq numbering matches the live
   * stream (so live and delayed clients see identical seqs for
   * the same event, only at different wall times).
   *
   * Returns an opaque handle to pass back to
   * `detachDelayedSpectator` on disconnect. On attach, the
   * scheduler immediately dispatches any events whose ripeness
   * window already elapsed (batched into a single `event`
   * frame), then arms a timer for the next unripe event.
   *
   * `delayMs` must be >= 0; the WS layer is responsible for
   * gating the maximum allowable delay.
   */
  attachDelayedSpectator(
    send: Send,
    delayMs: number,
    viewer?: ViewerPresence
  ): DelayedSpectatorSession {
    if (delayMs < 0) {
      throw new Error("attachDelayedSpectator: delayMs must be >= 0");
    }
    const session: DelayedSpectatorSession = {
      send,
      delayMs,
      nextCursor: 0,
      seq: 0,
      timer: null,
      closed: false,
    };
    this.delayedSpectators.add(session);
    if (viewer) {
      this.spectatorViewers.set(send, viewer);
    }
    // Immediate catch-up: drain all currently-ripe events as a
    // single batched `event` frame, then arm a timer for the
    // next unripe one (if any).
    this.dispatchDelayedSpectator(session, /* batched */ true);
    this.broadcastViewerState();
    return session;
  }

  detachDelayedSpectator(session: DelayedSpectatorSession): void {
    session.closed = true;
    if (session.timer !== null) {
      session.timer.cancel();
      session.timer = null;
    }
    this.delayedSpectators.delete(session);
    this.spectatorViewers.delete(session.send);
    this.broadcastViewerState();
  }

  /**
   * Dispatch every ripe event for a delayed session. When
   * `batched` is true, all ripe events are emitted in one
   * `event` message (used on attach for the initial catch-up);
   * otherwise each is sent as its own one-event frame (used by
   * the timer-driven tail). In both cases the session's
   * `nextCursor` and `seq` advance through the omniscient log,
   * `projectPublicEvent` is the redaction boundary, and the
   * next unripe event arms a fresh timer.
   */
  private dispatchDelayedSpectator(
    session: DelayedSpectatorSession,
    batched: boolean
  ): void {
    if (session.closed) {
      return;
    }
    if (session.timer !== null) {
      session.timer.cancel();
      session.timer = null;
    }
    const now = this.runtime.now();
    const batch: GameEvent[] = [];
    let lastSeq = -1;
    while (session.nextCursor < this.eventLog.length) {
      const entry = this.eventLog[session.nextCursor];
      const readyAt = entry.emittedAt + session.delayMs;
      if (readyAt > now) {
        break;
      }
      session.nextCursor++;
      const projected = projectPublicEvent(entry.event);
      if (projected === null) {
        // Dropped by the projection (private to a seat); seq
        // does NOT advance — keep the spectator stream
        // contiguous in spectator-seq space.
        continue;
      }
      const seq = session.seq++;
      if (batched) {
        batch.push(projected);
        lastSeq = seq;
      } else {
        session.send({
          type: "event",
          seq,
          events: [projected],
          legalActions: [],
        });
      }
    }
    if (batched && batch.length > 0) {
      session.send({
        type: "event",
        seq: lastSeq,
        events: batch,
        legalActions: [],
      });
    }
    // Arm the next timer (if any unripe events remain).
    if (session.nextCursor < this.eventLog.length) {
      const nextEntry = this.eventLog[session.nextCursor];
      const waitMs = Math.max(
        0,
        nextEntry.emittedAt + session.delayMs - this.runtime.now()
      );
      session.timer = this.runtime.schedule(() => {
        session.timer = null;
        this.dispatchDelayedSpectator(session, /* batched */ false);
      }, waitMs);
    }
  }

  /**
   * Called by `emitEvent` after a fresh entry is appended to
   * the log. Wakes any delayed session that was idle (no pending
   * timer because the log was previously drained); sessions
   * currently waiting on an earlier event's ripeness keep their
   * existing timer — it will re-evaluate on fire.
   */
  private notifyDelayedSpectators(): void {
    if (this.delayedSpectators.size === 0) {
      return;
    }
    for (const session of this.delayedSpectators) {
      if (session.timer === null && !session.closed) {
        this.dispatchDelayedSpectator(session, /* batched */ false);
      }
    }
  }

  /**
   * Resync slice for a delayed spectator. Returns the
   * contiguous spectator-seq slice starting at `fromSeq`,
   * including only events whose ripeness window
   * (`emittedAt + delayMs <= now`) has elapsed. Mirrors
   * `replaySpectatorBuffer` but with the delayed-dispatch gate.
   */
  replayDelayedSpectatorBuffer(
    fromSeq: number,
    delayMs: number,
    now: number = this.runtime.now()
  ): Array<{ seq: number; event: GameEvent }> {
    const out: Array<{ seq: number; event: GameEvent }> = [];
    let seq = 0;
    for (const entry of this.eventLog) {
      if (entry.emittedAt + delayMs > now) {
        break;
      }
      const projected = projectPublicEvent(entry.event);
      if (projected === null) {
        continue;
      }
      const s = seq++;
      if (s >= fromSeq) {
        out.push({ seq: s, event: projected });
      }
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Waiting-room API
  // -------------------------------------------------------------------------

  /**
   * Reclaim an existing human seat (matches by `userId`) or claim
    * the first empty placeholder. Returns the assigned `Seat`, or `null`
   * when the room is `playing`/`finished` and the user has no
   * prior claim (a spectator situation we currently refuse).
   *
   * Only valid in `waiting` for new claims. Reconnect-by-userId
   * works in any status so a human can rejoin a `playing` match
   * after a transient disconnect.
   */
  claimSeat(userId: string, displayName: string): Seat | null {
    this.assertNotPaused("claimSeat");
    // Reconnect path: same userId already has a seat.
    for (const [seat, p] of this.players) {
      if (p !== null && !p.isBot && p.userId === userId) {
        return seat;
      }
    }
    if (this.statusValue !== "waiting") {
      return null;
    }
    // Waiting-room positions are stable placeholders only. Final
    // winds are randomized atomically in `fillBotsAndStart`, so a
    // player cannot recreate or rejoin rooms to fish for East.
    const empties: Seat[] = [];
    for (const [seat, p] of this.players) {
      if (p === null) {
        empties.push(seat);
      }
    }
    if (empties.length === 0) {
      return null;
    }
    const pick = empties[0];
    this.players.set(pick, { userId, displayName, isBot: false });
    this.broadcastRoomState();
    return pick;
  }

  /**
   * Release a human seat (back to empty). Only valid in `waiting`
   * status; mid-match leaves are not supported (the seat is held
   * for reconnection). Detaches any live socket on that seat.
   */
  releaseSeat(seat: Seat): void {
    this.assertNotPaused("releaseSeat");
    if (this.statusValue !== "waiting") {
      throw new Error(
        `releaseSeat: cannot release seat in status "${this.statusValue}"`
      );
    }
    const p = this.players.get(seat);
    if (p === null || p === undefined || p.isBot) {
      return;
    }
    this.humanSockets[seat] = null;
    this.players.set(seat, null);
    this.broadcastRoomState();
  }

  /**
   * Fill every empty slot with a generic bot. Caller is expected
   * to invoke this immediately before `start()`; the bots' user
   * ids are stable (`bot:room:<seat>`) but not portal-resolvable
   * — they exist only inside the orchestrator + replay log.
   */
  fillBots(): void {
    this.assertNotPaused("fillBots");
    if (this.statusValue !== "waiting") {
      throw new Error(
        `fillBots: cannot fill bots in status "${this.statusValue}"`
      );
    }
    const names = ["Bot East", "Bot South", "Bot West", "Bot North"];
    for (const [seat, p] of this.players) {
      if (p === null) {
        this.players.set(seat, {
          userId: `bot:room:${seat}`,
          displayName: names[seat],
          isBot: true,
        });
      }
    }
  }

  /** Move occupants and every identity-bound connection field together. */
  private permuteSeatOccupants(
    permutation: readonly [Seat, Seat, Seat, Seat]
  ): void {
    const oldPlayers = new Map(this.players);
    const oldSockets = [...this.humanSockets];
    const oldDisconnected = [...this.disconnected];
    const oldAfkSelfReported = [...this.afkSelfReported];
    const oldProbes = [...this.livenessProbes];
    const oldProbeMisses = [...this.livenessProbeMisses];
    const oldConnectionGenerations = [...this.humanConnectionGeneration];

    for (let newSeat = 0; newSeat < 4; newSeat++) {
      const fromSeat = permutation[newSeat];
      this.players.set(newSeat as Seat, oldPlayers.get(fromSeat) ?? null);
      this.humanSockets[newSeat] = oldSockets[fromSeat];
      this.disconnected[newSeat] = oldDisconnected[fromSeat];
      this.afkSelfReported[newSeat] = oldAfkSelfReported[fromSeat];
      this.livenessProbes[newSeat] = oldProbes[fromSeat];
      this.livenessProbeMisses[newSeat] = oldProbeMisses[fromSeat];
      this.livenessProbeInflight[newSeat] = false;
      this.humanConnectionGeneration[newSeat] =
        oldConnectionGenerations[fromSeat] + 1;
    }
  }

  /** Apply the final random seating immediately before game start. */
  private randomizeWaitingRoomSeats(): void {
    this.permuteSeatOccupants(waitingRoomSeatPermutation(this.seed));
  }

  /**
   * Convenience: fill empty slots with bots, broadcast the
   * resulting `playing` room state, and start the match. Returns
   * the same promise as `start()`.
   */
  async fillBotsAndStart(): Promise<void> {
    this.assertNotPaused("fillBotsAndStart");
    if (this.statusValue !== "waiting") {
      throw new Error(
        `fillBotsAndStart: cannot start from status "${this.statusValue}"`
      );
    }
    this.randomizeWaitingRoomSeats();
    this.fillBots();
    // Status flip happens inside `start()`; broadcast the new
    // composition (now including the bots) BEFORE handing control
    // to the engine so clients can render the final seat list
    // before the first snapshot arrives.
    this.broadcastRoomState();
    await this.start();
  }

  /** Recipient-projected room state for `seat`, or `null` mySeat
   * for a spectator view. */
  buildRoomState(
    forSeat: Seat | null
  ): Extract<ServerMessage, { type: "room_state" }> {
    const seats: Array<{ seat: Seat; occupant: RoomSeatOccupant }> = [];
    for (let s = 0; s < 4; s++) {
      const seat = s as Seat;
      const p = this.players.get(seat) ?? null;
      let occupant: RoomSeatOccupant;
      if (p === null) {
        occupant = { kind: "empty" };
      } else if (p.isBot) {
        occupant = {
          kind: "bot",
          userId: p.userId,
          displayName: p.displayName,
        };
      } else {
        occupant = {
          kind: "human",
          userId: p.userId,
          displayName: p.displayName,
          // A seat counts as "connected" only when the WS is
          // attached AND the user hasn't self-reported AFK.
          // Network-disconnected seats set `disconnected=true`
          // in `detachHuman` so the badge flips immediately. Relay
          // players are connected to the external platform, not this
          // game server, so their socket state is intentionally unknown.
          connected:
            this.relayMode ||
            (this.humanSockets[seat] !== null && !this.disconnected[seat]),
        };
      }
      seats.push({ seat, occupant });
    }
    return {
      type: "room_state",
      matchId: this.matchId,
      status: this.statusValue,
      mySeat: forSeat,
      seats,
    };
  }

  /**
   * Push the current room state to every attached human and
   * spectator. Each human sees their own `mySeat`; spectators
   * get `mySeat: null`. Safe to call any time; cheap (one
   * allocation per recipient).
   */
  broadcastRoomState(): void {
    for (let s = 0; s < 4; s++) {
      const seat = s as Seat;
      const send = this.humanSockets[seat];
      if (send !== null) {
        send(this.buildRoomState(seat));
      }
    }
    if (this.spectatorSockets.size > 0) {
      const spectatorFrame = this.buildRoomState(null);
      for (const send of this.spectatorSockets) {
        send(spectatorFrame);
      }
    }
  }

  /** Build a stable, deduplicated list of authenticated people present. */
  buildViewerState(): Extract<ServerMessage, { type: "viewer_state" }> {
    const byUserId = new Map<string, ViewerPresence>();
    for (let seat = 0; seat < 4; seat++) {
      const player = this.players.get(seat as Seat);
      if (player && !player.isBot && this.humanSockets[seat] !== null) {
        byUserId.set(player.userId, {
          userId: player.userId,
          displayName: player.displayName,
          role: "player",
        });
      }
    }
    for (const viewer of this.spectatorViewers.values()) {
      if (!byUserId.has(viewer.userId)) {
        byUserId.set(viewer.userId, viewer);
      }
    }
    const viewers = [...byUserId.values()].sort((left, right) => {
      if (left.role !== right.role) {
        return left.role === "player" ? -1 : 1;
      }
      return left.displayName.localeCompare(right.displayName);
    });
    return { type: "viewer_state", viewers };
  }

  /** Broadcast presence outside the event log to every live connection. */
  private broadcastViewerState(): void {
    const frame = this.buildViewerState();
    for (const send of this.humanSockets) {
      send?.(frame);
    }
    for (const send of this.spectatorSockets) {
      send(frame);
    }
    for (const session of this.delayedSpectators) {
      if (!session.closed) {
        session.send(frame);
      }
    }
  }

  /**
   * Seats currently designated as human (not bot, not empty).
   * In `playing` / `finished` status this is stable; in `waiting`
   * it reflects the current claim state and may change.
   */
  humanSeats(): Seat[] {
    const out: Seat[] = [];
    for (const [seat, p] of this.players) {
      if (p !== null && !p.isBot) {
        out.push(seat);
      }
    }
    return out;
  }

  /** True iff `seat` is a human-controlled seat in this match.
   * False for both bot seats and empty (unclaimed) slots. */
  isHumanSeat(seat: Seat): boolean {
    const p = this.players.get(seat);
    return p !== null && p !== undefined && !p.isBot;
  }

  /**
   * Replay events `>= fromSeq` from the in-memory event log,
   * projected for the given seat. Used by the resync handler to
   * catch a reconnecting client up.
   *
   * The log holds the entire match for the lifetime of the
   * `MatchProcess`, so we always have an authoritative answer.
   * An empty result means the client is already caught up.
   *
   * The log itself stores the **archival (omniscient)** form so
   * replays can render full hands; this method is the redaction
   * boundary for live recipients. Mirrors `sendToSeat` (which
   * handles the per-event broadcast path) so the two stay in
   * lockstep on what a seat may see.
   */
  replayFromBuffer(
    fromSeq: number,
    recipient: Seat = 0
  ): Array<{ seq: number; event: GameEvent }> {
    // Re-derive the recipient's per-seat seq stream by walking the
    // omniscient log. Entries whose projection is `null` for this
    // recipient (private to another seat) are skipped without
    // advancing the recipient's counter, so the returned slice is
    // contiguous in the recipient's seq space. The recipient's
    // current live counter is `seatSeq[recipient]`, but we don't
    // rely on it here — projection is pure, so re-walking the log
    // produces the same numbering deterministically.
    const out: Array<{ seq: number; event: GameEvent }> = [];
    let seatSeq = 0;
    for (const entry of this.eventLog) {
      const projected = this.projectForSeat(entry.event, recipient);
      if (projected === null) {
        continue;
      }
      const seq = seatSeq++;
      if (seq >= fromSeq) {
        out.push({ seq, event: projected });
      }
    }
    return out;
  }

  /**
   * Per-recipient redaction shared by `sendToSeat` (live broadcast)
   * and `replayFromBuffer` (resync). Runs the projection layer and
   * re-attaches the recipient's own `hand` on `hand_start`. Returns
   * `null` when the projection drops the event for this recipient
   * (private to another seat); callers must treat that as "skip
   * this event entirely" and NOT advance the recipient's seq line.
   */
  private projectForSeat(event: GameEvent, recipient: Seat): GameEvent | null {
    const projected = projectEvent(event, recipient);
    if (projected === null) {
      return null;
    }
    if (projected.type === "hand_start") {
      return { ...projected, hand: [...this.state.hands[recipient]] };
    }
    return projected;
  }

  /**
   * Build a fresh snapshot from the perspective of `seat`. The
   * snapshot's `seq` is the last seq that seat saw on its own
   * per-seat seq line, NOT the omniscient seq. The client uses
   * it to set `lastSeq`, and the next event frame the client
   * receives carries `seatSeq[seat]` (assigned in `sendToSeat`).
   *
   * For multi-human matches each connected seat receives a
   * snapshot built with its own seat number, so `mySeat`, the
   * concealed-hand redaction, and the furiten field are all
   * recipient-correct.
   */
  buildSnapshotForSeat(seat: Seat): ServerMessage {
    return {
      type: "snapshot",
      seq: this.seatSeq[seat] - 1,
      state: {
        mySeat: seat,
        hands: this.state.hands.map((h, s) =>
          s === seat ? [...h] : new Array<Tile | null>(h.length).fill(null)
        ),
        discards: this.state.discards.map((d) => [...d]),
        melds: this.state.melds.map((mlds) =>
          mlds.map((m) => ({
            type: m.type,
            tiles: [...m.tiles],
            claimedTile: m.claimedTile,
            from: m.from,
          }))
        ),
        wallRemaining: this.state.liveWall.length,
        // Number of post-deal draws this hand. A normal draw removes
        // one live-wall tile; a rinshan draw reserves the back tile
        // into the dead wall, so both shrink `liveWall` by one.
        drawsTaken: 70 - this.state.liveWall.length,
        doraIndicators: [...this.state.doraIndicators],
        turn: this.state.turn,
        dealer: this.state.dealer,
        roundWind: this.state.roundWind,
        roundNumber: this.state.roundNumber,
        honba: this.state.honba,
        riichiSticks: this.state.riichiSticks,
        scores: [...this.state.scores],
        sinking: this.computeSinking(),
        riichiBetValue: this.state.ruleSet.riichiBetValue,
        ...(this.state.ruleSet.scoreCap
          ? { scoreCap: this.state.ruleSet.scoreCap }
          : {}),
        ...(this.state.ruleSet.buuMode
          ? {
              chips: [...this.state.chips] as [number, number, number, number],
              dabuken: [...this.state.dabuken] as [
                boolean,
                boolean,
                boolean,
                boolean,
              ],
            }
          : {}),
        riichiDeclared: [...this.state.riichiDeclared],
        riichiTileIdx: [...this.riichiTileIdx] as [
          number | null,
          number | null,
          number | null,
          number | null,
        ],
        lastDiscard: this.state.lastDiscard,
        phase: this.state.phase,
        dice: [this.dice[0], this.dice[1]],
        // Furiten is private; the snapshot only carries the
        // recipient's own status. Opponent slots are always
        // `false` from this seat's perspective (their real value
        // is never sent over the wire).
        furiten: [0, 1, 2, 3].map((s) =>
          s === seat ? isFuritenForRon(this.state, seat) : false
        ) as [boolean, boolean, boolean, boolean],
        // Per-seat display names so a reconnecting human or a
        // mid-match spectator sees the correct HUD labels without
        // having to wait for the next `match_start` (which only
        // fires once at the very start of the match).
        seatNames: [0, 1, 2, 3].map(
          (s) => this.players.get(s as Seat)?.displayName ?? ""
        ) as [string, string, string, string],
      },
      // Legals/deadline are per-seat (slice 2): each open window
      // has its own timer and option set; this projection surfaces
      // only the recipient's own.
      legalActions: this.legalActions[seat],
      ...(this.currentDeadline[seat] !== null
        ? { deadline: this.currentDeadline[seat] as number }
        : {}),
      bufferMs: this.bufferMs[seat],
    };
  }

  /**
   * Build a fresh spectator snapshot — public view of the table
   * with no seat assignment, no concealed hands, and no
   * recipient-specific fields. The `seq` is the last spectator
   * seq emitted so far, so the spectator's next `event` frame
   * carries `spectatorSeq` and the wire stream stays contiguous.
   *
   * Refused at the WS layer when the match is not in `playing`
   * status; this method itself is total (callable in any phase)
   * for testability.
   */
  buildSpectatorSnapshot(): ServerMessage {
    return {
      type: "snapshot",
      // `spectatorSeq` is the next seq to assign; `seq - 1` is the
      // last seq emitted. Clamp to 0 when no projected events have
      // happened yet (e.g. snapshot taken before `match_start`).
      seq: Math.max(0, this.spectatorSeq - 1),
      state: {
        mySeat: null,
        // Spectators are omniscient: every seat's full hand is
        // visible.
        hands: this.state.hands.map((h) => [...h]),
        discards: this.state.discards.map((d) => [...d]),
        melds: this.state.melds.map((mlds) =>
          mlds.map((m) => ({
            type: m.type,
            tiles: [...m.tiles],
            claimedTile: m.claimedTile,
            from: m.from,
          }))
        ),
        wallRemaining: this.state.liveWall.length,
        drawsTaken: 70 - this.state.liveWall.length,
        doraIndicators: [...this.state.doraIndicators],
        turn: this.state.turn,
        dealer: this.state.dealer,
        roundWind: this.state.roundWind,
        roundNumber: this.state.roundNumber,
        honba: this.state.honba,
        riichiSticks: this.state.riichiSticks,
        scores: [...this.state.scores],
        sinking: this.computeSinking(),
        riichiBetValue: this.state.ruleSet.riichiBetValue,
        ...(this.state.ruleSet.scoreCap
          ? { scoreCap: this.state.ruleSet.scoreCap }
          : {}),
        ...(this.state.ruleSet.buuMode
          ? {
              chips: [...this.state.chips] as [number, number, number, number],
              dabuken: [...this.state.dabuken] as [
                boolean,
                boolean,
                boolean,
                boolean,
              ],
            }
          : {}),
        riichiDeclared: [...this.state.riichiDeclared],
        riichiTileIdx: [...this.riichiTileIdx] as [
          number | null,
          number | null,
          number | null,
          number | null,
        ],
        lastDiscard: this.state.lastDiscard,
        phase: this.state.phase,
        dice: [this.dice[0], this.dice[1]],
        // Spectators see the live per-seat furiten state (union
        // of permanent / locked + temporary flags).
        furiten: [0, 1, 2, 3].map(
          (s) => this.state.furitenLocked[s] || this.state.furitenTemp[s]
        ) as [boolean, boolean, boolean, boolean],
        // Per-seat display names so a spectator joining mid-match
        // sees the correct HUD labels without waiting for the
        // next `match_start` (which only fires once per match).
        seatNames: [0, 1, 2, 3].map(
          (s) => this.players.get(s as Seat)?.displayName ?? ""
        ) as [string, string, string, string],
        // Omniscient starting wall for the current hand, plus the
        // number of live-wall draws taken since the hand began.
        // Together these power the `showWalls` overlay for
        // spectators who join mid-hand — the renderer uses
        // `liveDrawsTaken` to hide positions that have already
        // been drawn off the wall. `null` before the first
        // `hand_start` of the match (handled as "no wall data").
        ...(this.handStartLiveWall
          ? {
              liveWall: [...this.handStartLiveWall],
              liveDrawsTaken: Math.max(
                0,
                this.handStartLiveWall.length - this.state.liveWall.length
              ),
            }
          : {}),
      },
      legalActions: [],
    };
  }

  /**
   * Resync slice for a spectator: walks the omniscient event log,
   * re-projects each entry through `projectPublicEvent`, and
   * returns the contiguous spectator-seq slice from `fromSeq`
   * onward. Mirrors `replayFromBuffer` (per-seat) but for the
   * spectator stream — entries dropped by the projection do NOT
   * advance the spectator seq, so the returned slice is strictly
   * contiguous in spectator-seq space.
   */
  replaySpectatorBuffer(
    fromSeq: number
  ): Array<{ seq: number; event: GameEvent }> {
    const out: Array<{ seq: number; event: GameEvent }> = [];
    let seq = 0;
    for (const entry of this.eventLog) {
      const projected = projectPublicEvent(entry.event);
      if (projected === null) {
        continue;
      }
      const s = seq++;
      if (s >= fromSeq) {
        out.push({ seq: s, event: projected });
      }
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Action handling (called from WS layer)
  // -------------------------------------------------------------------------

  async handleAct(seat: Seat, actionId: string): Promise<void> {
    const receivedAtSeq = this.nextSeq;
    const activeTransaction = this.commandTransactionPromise;
    if (activeTransaction !== null) {
      try {
        await activeTransaction;
      } catch {
        // A failed transaction leaves the process paused or recovery-only.
      }
      if (this.commandTransactionPromise === activeTransaction) {
        this.commandTransactionPromise = null;
      }
      if (!this.isPaused && this.nextSeq === receivedAtSeq) {
        await this.handleAct(seat, actionId);
      }
      return;
    }
    if (this.isPaused || !this.isAcceptedAction(seat, actionId)) {
      return;
    }
    const command: PendingMatchCommand = { type: "act", seat, actionId };
    const transaction = this.runCommandTransaction(command);
    this.commandTransactionPromise = transaction;
    try {
      await transaction;
    } finally {
      if (this.commandTransactionPromise === transaction) {
        this.commandTransactionPromise = null;
      }
    }
  }

  private isAcceptedAction(seat: Seat, actionId: string): boolean {
    if (
      this.state.phase === "hand_ended" ||
      this.state.phase === "match_ended"
    ) {
      return false;
    }
    if (this.callWindow[seat] !== null) {
      return this.legalActions[seat].some((action) => action.id === actionId);
    }
    return (
      seat === this.state.turn &&
      this.legalActions[seat].some((action) => action.id === actionId)
    );
  }

  private async runCommandTransaction(
    command: PendingMatchCommand
  ): Promise<void> {
    const checkpoint = this.createCheckpoint();
    this.freezeCheckpoint(checkpoint);
    try {
      await this.repository.saveCommandTransaction({
        matchId: this.matchId,
        checkpoint,
        command,
      });
    } catch (error) {
      this.resumeCheckpoint(checkpoint);
      throw error;
    }
    this.resumeCheckpointForCommand(checkpoint, command.seat);
    await this.executePersistedCommand(command);
    await this.commitCommandState();
  }

  private async replayPendingCommand(
    command: PendingMatchCommand
  ): Promise<void> {
    const checkpoint = this.createCheckpoint();
    this.freezeCheckpoint(checkpoint);
    this.resumeCheckpointForCommand(checkpoint, command.seat);
    await this.executePersistedCommand(command);
    await this.commitCommandState();
  }

  private resumeCheckpointForCommand(
    checkpoint: MatchCheckpoint,
    seat: Seat
  ): void {
    this.resumeCheckpoint(checkpoint);
    this.currentDeadlineTimer[seat]?.cancel();
    this.currentDeadlineTimer[seat] = null;
    this.deadlineEpoch[seat] += 1;
  }

  private async executePersistedCommand(
    command: PendingMatchCommand
  ): Promise<void> {
    if (!this.isAcceptedAction(command.seat, command.actionId)) {
      this.commandRecoveryRequired = true;
      throw new Error(
        `MatchProcess: pending action ${command.actionId} is no longer legal for seat ${command.seat}`
      );
    }
    try {
      await this.handleActDirect(command.seat, command.actionId);
    } catch (error) {
      this.commandRecoveryRequired = true;
      throw error;
    }
  }

  private async commitCommandState(): Promise<void> {
    if (this.statusValue === "finished") {
      return;
    }
    const checkpoint = this.createCheckpoint();
    this.freezeCheckpoint(checkpoint);
    this.pendingCommandCommitCheckpoint = checkpoint;
    await this.repository.saveCheckpoint({
      matchId: this.matchId,
      checkpoint,
    });
    this.pendingCommandCommitCheckpoint = null;
    this.resumeCheckpoint(checkpoint);
  }

  private async handleActDirect(seat: Seat, actionId: string): Promise<void> {
    if (this.isPaused) {
      return;
    }
    if (
      this.state.phase === "hand_ended" ||
      this.state.phase === "match_ended"
    ) {
      return;
    }
    // Any action from a seat is proof of life — reset the
    // liveness strike counter so a stale missed pong doesn't
    // count against the next deadline window.
    this.livenessProbeMisses[seat] = 0;
    // Account for elapsed think time *before* applying the action,
    // so the next legal-actions frame reflects the updated buffer.
    // Only human seats consume the buffer (bots act synchronously).
    if (this.isHumanSeat(seat)) {
      this.consumeActionBuffer(seat);
    }
    // During a call window, accept this seat's
    // chi/pon/kan/ron/pass regardless of `state.turn` (the
    // engine's `turn` still points at the next-to-draw seat
    // after the discard, but a non-discarder gets first shot
    // through the call options).
    if (this.callWindow[seat] !== null) {
      const action = this.legalActions[seat].find((a) => a.id === actionId);
      if (!action) {
        return;
      }
      await this.resolveCallWindow(seat, action);
      return;
    }
    if (seat !== this.state.turn) {
      return;
    }
    const action = this.legalActions[seat].find((a) => a.id === actionId);
    if (!action) {
      return;
    }
    if (action.type === "discard" && action.tile) {
      await this.applyDiscard(seat, action.tile, action.discardSource);
      await this.afterDiscard();
      return;
    }
    // Self-kan declarations during own awaiting_discard turn.
    if (
      action.type === "kan" &&
      action.kanKind === "ankan" &&
      action.tiles &&
      action.tiles[0]
    ) {
      this.setSeatLegals(seat, []);
      await this.applyEngineAction({
        type: "kan",
        seat,
        kind: "ankan",
        tile: action.tiles[0],
      });
      await this.afterCall();
      return;
    }
    if (
      action.type === "kan" &&
      action.kanKind === "shouminkan" &&
      action.tiles &&
      action.tiles[0]
    ) {
      this.setSeatLegals(seat, []);
      await this.applyEngineAction({
        type: "kan",
        seat,
        kind: "shouminkan",
        tile: action.tiles[0],
      });
      // Engine is now in awaiting_chankan; open the chankan window.
      await this.openChankanWindow();
      return;
    }
    if (action.type === "tsumo") {
      // Brief beat between the seat's `draw` event and the
      // `win` event so the drawn tile registers visually before
      // the win panel takes over.
      await this.waitForWinReaction("draw");
      await this.applyEngineAction({ type: "tsumo", seat });
      await this.afterHandEnd();
      return;
    }
    if (action.type === "riichi" && action.tile) {
      // Close the seat's action window BEFORE emitting the
      // riichi / discard events so the wire frames carry an
      // empty `legalActions` for this seat. Otherwise the
      // events would echo back the still-populated
      // `riichi:TILE` legals and the client's Riichi toggle
      // button would re-appear after the optimistic clear,
      // lingering until the turn finally advances. Mirrors the
      // implicit "hand-ended" suppression that already hides
      // the ron / tsumo buttons immediately on click.
      this.setSeatLegals(seat, []);
      await this.applyEngineAction({
        type: "riichi",
        seat,
        tile: action.tile,
        discardSource: action.discardSource,
      });
      await this.afterDiscard();
      return;
    }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async waitForWinReaction(
    triggerType: "draw" | "discard" | "call"
  ): Promise<void> {
    if (WIN_REACTION_DELAY_MS <= 0) {
      return;
    }
    let triggerEmittedAt: number | null = null;
    for (let index = this.eventLog.length - 1; index >= 0; index--) {
      const entry = this.eventLog[index];
      if (entry.event.type === triggerType) {
        triggerEmittedAt = entry.emittedAt;
        break;
      }
    }
    const remaining =
      triggerEmittedAt === null
        ? WIN_REACTION_DELAY_MS
        : remainingWinReactionDelayMs(
            triggerEmittedAt,
            this.runtime.now(),
            WIN_REACTION_DELAY_MS
          );
    if (remaining > 0) {
      await this.runUncheckpointableTransition("win_reaction", remaining);
    }
  }

  private async advanceTurn(): Promise<void> {
    if (
      this.state.phase === "hand_ended" ||
      this.state.phase === "match_ended"
    ) {
      return;
    }

    // Debug: if seat 0 has queued forced draws, prepend the next one
    // to the live wall so the engine's `draw` step picks it up.
    // (Debug seeds remain seat-0 specific; the lobby panel is a
    // dev surface.)
    if (this.state.turn === 0 && this.humanDrawQueue.length > 0) {
      this.state.liveWall.unshift(this.humanDrawQueue.shift() as Tile);
    }

    // Pace turns so the client renders the previous action (and its
    // SFX) before the next draw arrives. Applies to every draw,
    // including the human's after a bot discards. Disabled during
    // tests via `setDelayAfterDiscardMs(0)`.
    if (DELAY_AFTER_DISCARD_MS > 0) {
      await this.runUncheckpointableTransition(
        "turn_pacing",
        DELAY_AFTER_DISCARD_MS
      );
    }

    const drawRes = step(this.state, { type: "draw", seat: this.state.turn });
    this.state = drawRes.state;
    for (const e of drawRes.events) {
      await this.emitEngineEvent(e);
    }
    await this.emitFuritenChanges(drawRes.furitenChanges);

    if (
      this.state.phase === "hand_ended" ||
      this.state.phase === "match_ended"
    ) {
      await this.afterHandEnd();
      return;
    }

    if (this.isHumanSeat(this.state.turn)) {
      // Human seat: surface legal discards, then wait for `act`.
      const turnSeat = this.state.turn;
      this.setSeatLegals(turnSeat, this.buildDiscardLegals(turnSeat));
      if (await this.maybeAutoRiichiDiscard()) {
        return;
      }
      this.flushLegalsToSeat(turnSeat);
      return;
    }

    // Bot seat: pick a discard. Seat 3 (left bot) honors the debug
    // queue when set, force-injecting the tile into hand if missing
    // (debug-only — wall/hand integrity is not preserved).
    const seat = this.state.turn;
    // Pause between the draw and the discard so the draw SFX
    // can play and the user can see the drawn tile briefly before
    // it's discarded.
    if (DRAW_TO_DISCARD_DELAY_MS > 0) {
      await this.runUncheckpointableTransition(
        "bot_discard_pacing",
        DRAW_TO_DISCARD_DELAY_MS
      );
    }
    // Self-kan check (yakuhai-only policy). The bot may declare an
    // ankan or shouminkan instead of discarding. After a successful
    // declaration the engine has either:
    //   - put the bot back in awaiting_discard with a fresh rinshan
    //     (ankan) → loop into another bot turn via afterCall, or
    //   - opened the chankan window (shouminkan) → handed off to
    //     openChankanWindow which resolves and resumes the bot's
    //     awaiting_discard.
    if (seat !== 3 || this.leftDiscardQueue.length === 0) {
      const selfKan = chooseBotSelfKan(this.state, seat);
      if (selfKan !== null) {
        if (selfKan.kind === "ankan") {
          await this.applyEngineAction({
            type: "kan",
            seat,
            kind: "ankan",
            tile: selfKan.tile,
          });
          await this.afterCall();
          return;
        }
        // shouminkan
        await this.applyEngineAction({
          type: "kan",
          seat,
          kind: "shouminkan",
          tile: selfKan.tile,
        });
        await this.openChankanWindow();
        return;
      }
    }
    let tile: Tile;
    let discardSource: DiscardSource;
    if (seat === 3 && this.leftDiscardQueue.length > 0) {
      tile = this.leftDiscardQueue.shift() as Tile;
      const handIdx = this.state.hands[seat].lastIndexOf(tile);
      if (handIdx < 0) {
        const drawn = this.state.lastDrawn[seat];
        const drawnIdx =
          drawn !== null ? this.state.hands[seat].lastIndexOf(drawn) : -1;
        this.state.hands[seat][drawnIdx >= 0 ? drawnIdx : 0] = tile;
        this.state.lastDrawn[seat] = tile;
        discardSource = "draw";
      } else {
        discardSource =
          this.state.lastDrawn[seat] !== null &&
          handIdx === this.state.hands[seat].length - 1
            ? "draw"
            : "hand";
      }
    } else {
      const drawn = this.state.lastDrawn[seat];
      const picked = randomBotDiscard({
        hand: this.state.hands[seat],
        drawn,
        random: () => this.runtime.random(),
      });
      tile = picked.tile;
      discardSource = picked.discardSource;
    }
    await this.applyDiscard(seat, tile, discardSource);
    await this.afterDiscard();
  }

  /**
   * Post-discard call window.
   *
   * Two response sources:
   *   - **Bots**: scanned synchronously here. Bots auto-take ron when
   *     legal (atamahane resolves ties); they always pass on
   *     chi/pon/kan.
  *   - **Humans**: each eligible seat opens its own UI window;
   *     resolution waits for the `act`. Bot rons are remembered in
   *     `pendingBotRons` and combined with the human's response when
   *     the window resolves.
   *
   * Priority: ron > pon/daiminkan > chi. Rons resolve atamahane:
   * closest non-discarder going counter-clockwise wins.
   */
  private async afterDiscard(): Promise<void> {
    if (
      this.state.phase === "hand_ended" ||
      this.state.phase === "match_ended"
    ) {
      await this.afterHandEnd();
      return;
    }
    const calls = enumerateCalls(this.state);

    // Collect bot intent: ron always; pon / daiminkan only when the
    // discard is a yakuhai for that seat (see `chooseBotCall`).
    const botRons: Seat[] = [];
    const botCalls: Array<{ seat: Seat; option: CallOption }> = [];
    for (const c of calls) {
      if (this.isHumanSeat(c.seat)) {
        continue;
      }
      if (c.options.some((o) => o.kind === "ron")) {
        botRons.push(c.seat);
        continue;
      }
      const chosen = chooseBotCall(this.state, c.seat, c.options);
      if (chosen !== null) {
        botCalls.push({ seat: c.seat, option: chosen });
      }
    }

    // Slice 2b: open a concurrent call window for every eligible
    // human. `resolveCallWindow` records each seat's response;
    // `finalizeCallWindow` runs once the last open window has
    // been answered (or timed out) and applies the head-bumpered
    // winner across humans + bots.
    const eligibleHumans = calls.filter(
      (c) => this.isHumanSeat(c.seat) && c.options.length > 0
    );
    if (eligibleHumans.length > 0) {
      // Stash bot rons / pon / kan / chi for combined resolution.
      // Bot non-ron calls compete on equal footing with human
      // claims via `finalizeCallWindow`'s head-bumper sort.
      this.pendingBotRons = botRons;
      this.pendingBotCalls = botCalls;
      for (const human of eligibleHumans) {
        this.openCallWindow(human.seat, human.options);
      }
      return;
    }

    // No human window. Resolve bot side immediately.
    if (botRons.length > 0) {
      await this.resolveRons(botRons);
      return;
    }
    if (botCalls.length > 0) {
      await this.resolveBotCall(botCalls);
      return;
    }
    await this.advanceTurn();
  }

  /**
   * Multi-ron resolution: dispatch one engine action covering every
   * winner. The "head bumper" (closest seat to the discarder going
   * counter-clockwise) is recorded as the primary winner so the
   * engine's rotation logic and riichi-stick award land on the
   * right seat. Single-winner case still routes through the same
   * `ron` action with no `additionalWinners` for simplicity.
   *
   * Sanchahou: when three opponents ron the same discard and the
   * `aborts.sanchahou` rule is enabled, the hand aborts instead of
   * resolving as a triple ron.
   */
  private async resolveRons(candidates: Seat[]): Promise<void> {
    const discarder = this.state.lastDiscard?.seat;
    if (discarder === undefined || candidates.length === 0) {
      await this.advanceTurn();
      return;
    }
    await this.waitForWinReaction("discard");
    const ordered = candidates
      .slice()
      .sort((a, b) => ((a - discarder + 3) % 4) - ((b - discarder + 3) % 4));
    const head = ordered[0];
    // Atamahane drops every non-head ron candidate (head-bump
    // wins outright) and also disables the sanchahou abort: with
    // head-bump there is only ever one winner, so triple-ron
    // simply can't happen. Without it, additional winners flow
    // into `applyMultiRon` for double / triple-ron resolution.
    if (this.state.ruleSet.atamahane) {
      await this.applyEngineAction({ type: "ron", seat: head });
    } else if (candidates.length === 3 && this.state.ruleSet.aborts.sanchahou) {
      await this.applyEngineAction({
        type: "abort",
        seat: head,
        kind: "sanchahou",
      });
    } else {
      const additional = ordered.slice(1);
      await this.applyEngineAction({
        type: "ron",
        seat: head,
        ...(additional.length > 0 ? { additionalWinners: additional } : {}),
      });
    }
    if (
      this.state.phase === "hand_ended" ||
      this.state.phase === "match_ended"
    ) {
      await this.afterHandEnd();
    }
  }

  /**
   * Resolve bot pon / daiminkan call(s). Two seats cannot legally
   * pon the same tile (it would require 4 copies of the tile in
   * hand split across both, plus one with the discarder), so the
   * list always contains at most one entry — but treat it as a list
   * for robustness and pick the highest-priority kind (kan over pon
   * if somehow both surfaced for the same seat).
   */
  private async resolveBotCall(
    candidates: Array<{ seat: Seat; option: CallOption }>
  ): Promise<void> {
    if (candidates.length === 0) {
      await this.advanceTurn();
      return;
    }
    const claimed = this.state.lastDiscard?.tile;
    if (claimed === undefined) {
      await this.advanceTurn();
      return;
    }
    const { seat, option } = candidates[0];
    if (option.kind === "pon") {
      const [a, b] = option.tiles;
      await this.applyEngineAction({
        type: "pon",
        seat,
        tiles: [a, b],
      });
    } else if (option.kind === "daiminkan") {
      await this.applyEngineAction({
        type: "kan",
        seat,
        kind: "daiminkan",
        tile: claimed,
      });
    } else {
      // chi / ron — neither flows through this path in the slice.
      await this.advanceTurn();
      return;
    }
    await this.afterCall();
  }

  /**
   * Chankan window: opened immediately after a shouminkan
   * declaration. Scans non-declarer seats for a legal ron on the
   * upgrade tile, surfaces a single "ron" button to the human if
   * eligible, and resolves the window — either by dispatching
   * `ron` (which the engine handles in `awaiting_chankan` with the
   * chankan yaku flag) or by completing the kan via
   * `complete_shouminkan`.
   */
  private async openChankanWindow(): Promise<void> {
    const pending = this.state.pendingShouminkan;
    if (pending === null) {
      // Defensive: shouldn't happen.
      await this.advanceTurn();
      return;
    }
    const declarer = pending.seat;
    const winTile = pending.tile;
    // Scan opponents for a legal chankan ron. Split eligible
    // candidates into a human (gets an interactive window) and
    // bots (auto-take ron on resolution). Slice 1 supports one
    // human chankan window at a time; multiple eligible humans
    // is a slice-2 concern.
    const botCandidates: Seat[] = [];
    let humanCandidate: Seat | null = null;
    for (let s = 0; s < 4; s++) {
      const seat = s as Seat;
      if (seat === declarer) {
        continue;
      }
      if (!this.canChankanRon(seat, winTile)) {
        continue;
      }
      if (this.isHumanSeat(seat) && humanCandidate === null) {
        humanCandidate = seat;
      } else {
        botCandidates.push(seat);
      }
    }
    if (humanCandidate !== null) {
      // Open a ron-only window for the human; bot rons combine on
      // resolution. Re-use `pendingChankanBotRons` to remember
      // the bot side.
      this.pendingChankanBotRons = botCandidates;
      this.openCallWindow(humanCandidate, [{ kind: "ron" }]);
      return;
    }
    if (botCandidates.length > 0) {
      await this.dispatchChankanRons(botCandidates);
      return;
    }
    await this.completeShouminkanAndResume();
  }

  private pendingChankanBotRons: Seat[] = [];

  /** True if `seat`'s 13-tile concealed hand wins on `winTile` as a chankan. */
  private canChankanRon(seat: Seat, winTile: Tile): boolean {
    const hand = this.state.hands[seat];
    if (hand.length !== 13) {
      return false;
    }
    const score = scoreHand({
      hand,
      winTile,
      tsumo: false,
      roundWind: this.state.roundWind,
      seatWind: seatWind(seat, this.state.dealer),
      doraIndicators: this.state.doraIndicators,
      uraDoraIndicators:
        this.state.ruleSet.uraDora && this.state.riichiDeclared[seat]
          ? this.state.uraDoraIndicators
          : undefined,
      riichi: this.state.riichiDeclared[seat],
      doubleRiichi: this.state.doubleRiichi[seat],
      ippatsu: this.state.ippatsuEligible[seat],
      melds: this.state.melds[seat],
      noKuitan: !this.state.ruleSet.kuitan,
      noAka: isAkaDisabled(this.state.ruleSet),
      rinshanOrChankan: true,
    });
    return score.isAgari && score.han > 0;
  }

  private async dispatchChankanRons(candidates: Seat[]): Promise<void> {
    const declarer = this.state.pendingShouminkan?.seat;
    if (declarer === undefined || candidates.length === 0) {
      await this.completeShouminkanAndResume();
      return;
    }
    await this.waitForWinReaction("call");
    // Head-bumper sort relative to the declarer (same atamahane
    // rule as a normal ron — closest counter-clockwise wins).
    const ordered = candidates
      .slice()
      .sort((a, b) => ((a - declarer + 3) % 4) - ((b - declarer + 3) % 4));
    const head = ordered[0];
    const additional = ordered.slice(1);
    await this.applyEngineAction({
      type: "ron",
      seat: head,
      ...(additional.length > 0 ? { additionalWinners: additional } : {}),
    });
    if (
      this.state.phase === "hand_ended" ||
      this.state.phase === "match_ended"
    ) {
      await this.afterHandEnd();
    }
  }

  /**
   * Close the chankan window with no robbing ron: complete the
   * shouminkan (rinshan draw + post-kan dora) and re-prompt the
   * declarer for their next discard.
   */
  private async completeShouminkanAndResume(): Promise<void> {
    await this.applyEngineAction({ type: "complete_shouminkan" });
    await this.afterCall();
  }

  /**
   * Open a call window for `seat`. `seat` MUST be a human seat
   * (the caller has already filtered eligible candidates). May
   * be called multiple times in the same `afterDiscard` pass —
   * once per eligible human — so multiple seats can race in
   * parallel; `finalizeCallWindow` waits for every window to
   * close before applying the head-bumpered winning call.
   */
  private openCallWindow(seat: Seat, options: CallOption[]): void {
    this.callWindow[seat] = options;
    this.setSeatLegals(seat, this.buildCallLegals(options));
    this.flushLegalsToSeat(seat);
  }

  private buildCallLegals(options: CallOption[]): LegalAction[] {
    const out: LegalAction[] = [];
    let i = 0;
    for (const opt of options) {
      if (opt.kind === "chi") {
        out.push({
          id: `chi:${i++}:${opt.tiles.join(",")}`,
          type: "chi",
          tiles: [...opt.tiles],
        });
      } else if (opt.kind === "pon") {
        out.push({
          id: `pon:${i++}:${opt.tiles.join(",")}`,
          type: "pon",
          tiles: [...opt.tiles],
        });
      } else if (opt.kind === "daiminkan") {
        out.push({
          id: `kan:${i++}:${opt.tiles.join(",")}`,
          type: "kan",
          tiles: [...opt.tiles],
          kanKind: "daiminkan",
        });
      } else if (opt.kind === "ron") {
        out.push({ id: `ron:${i++}`, type: "ron" });
      }
    }
    out.push({ id: "pass", type: "pass" });
    return out;
  }

  /**
   * Record `seat`'s response (`ron` / `chi` / `pon` / `kan` /
   * `pass`) for the current call window and close that seat's
   * window. If every still-open human window has now answered,
   * `finalizeCallWindow` consumes the collected actions plus
   * `pendingBotRons` / `pendingBotCalls` / `pendingChankanBotRons`
   * and applies the winning call (or advances if everyone passed).
   *
   * Priority short-circuit: when `seat` submits a non-`pass`
   * action, every other still-open window whose best legal option
   * is strictly weaker than the submitted action is force-passed —
   * those seats can't influence the outcome regardless of what
   * they pick, so we don't make the live humans wait on the call
   * timer. Equal-priority races (e.g. two seats with rons) keep
   * their windows open so atamahane / multi-ron can resolve
   * correctly in `finalizeCallWindow`. In particular, a submitted
   * `ron` (priority 4) never closes another seat's still-open ron
   * window (4 < 4 is false) — so double / triple ron rules that
   * allow multi-winner resolution always see every ron candidate.
   *
   * Atamahane short-circuit: when `ruleSet.atamahane` is on and
   * the submitted action is a ron, every still-open window for a
   * seat strictly downstream of `seat` (farther counter-clockwise
   * from the discarder) is also force-passed — head-bump means
   * those seats cannot win regardless of their response.
   *
   * Atamahane: when multiple seats race for the same priority,
   * the seat closest counter-clockwise from the discarder wins.
   * Ron beats every non-ron call; pon / kan beat chi; chi is only
   * legal from the discarder's shimocha (and only one seat can
   * ever have a legal chi on a given discard).
   */
  private async resolveCallWindow(
    seat: Seat,
    action: LegalAction
  ): Promise<void> {
    if (this.callWindow[seat] === null) {
      // Defensive: window already closed (timer + manual ack race).
      return;
    }
    this.pendingHumanCallActions[seat] = action;
    this.callWindow[seat] = null;
    this.setSeatLegals(seat, []);
    // Flush the empty legals frame to the submitter immediately so
    // their client tears down the call-prompt buttons and HUD
    // timer — otherwise the visible timer keeps ticking while we
    // wait for higher-priority windows to close (their submission
    // may even be dominated by a pending higher-priority call,
    // in which case there's nothing more for them to do).
    this.flushLegalsToSeat(seat);

    // Priority short-circuit: auto-pass any open window whose
    // best option can't beat the submitted action.
    const submittedPrio = callActionPriority(action);
    if (submittedPrio > 0) {
      for (let s = 0; s < 4; s++) {
        const seatIdx = s as Seat;
        const opts = this.callWindow[seatIdx];
        if (opts === null) {
          continue;
        }
        const bestPrio = callOptionsMaxPriority(opts);
        if (bestPrio < submittedPrio) {
          this.pendingHumanCallActions[seatIdx] = { id: "pass", type: "pass" };
          this.callWindow[seatIdx] = null;
          this.setSeatLegals(seatIdx, []);
          this.flushLegalsToSeat(seatIdx);
        }
      }
    }

    // Atamahane short-circuit: when a ron is submitted under the
    // head-bump rule, every still-open window strictly downstream
    // of `seat` (farther counter-clockwise from the discarder) is
    // dominated regardless of what they pick — they can neither
    // out-prio nor out-head-bump us. Force-pass them so the live
    // humans don't sit on a dead timer.
    if (action.type === "ron" && this.state.ruleSet.atamahane) {
      const discarder = this.state.lastDiscard?.seat;
      if (discarder !== undefined) {
        const submittedHb = (seat - discarder + 3) % 4;
        for (let s = 0; s < 4; s++) {
          const seatIdx = s as Seat;
          if (this.callWindow[seatIdx] === null) {
            continue;
          }
          const hb = (seatIdx - discarder + 3) % 4;
          if (hb > submittedHb) {
            this.pendingHumanCallActions[seatIdx] = {
              id: "pass",
              type: "pass",
            };
            this.callWindow[seatIdx] = null;
            this.setSeatLegals(seatIdx, []);
            this.flushLegalsToSeat(seatIdx);
          }
        }
      }
    }

    // Wait for every remaining human window to close before
    // resolving — otherwise we'd race an early `pass` ahead of
    // another seat's `ron`.
    for (let s = 0; s < 4; s++) {
      if (this.callWindow[s as Seat] !== null) {
        return;
      }
    }
    await this.finalizeCallWindow();
  }

  /**
   * Apply the winning call for the current discard. Reads and
   * clears `pendingHumanCallActions`, `pendingBotRons`,
   * `pendingBotCalls`, `pendingChankanBotRons`.
   */
  private async finalizeCallWindow(): Promise<void> {
    const humanActions = this.pendingHumanCallActions;
    this.pendingHumanCallActions = [null, null, null, null];
    const pendingBotRons = this.pendingBotRons;
    const pendingBotCalls = this.pendingBotCalls;
    const pendingChankanBotRons = this.pendingChankanBotRons;
    this.pendingBotRons = [];
    this.pendingBotCalls = [];
    this.pendingChankanBotRons = [];

    // Chankan window branch: engine is in awaiting_chankan, so any
    // ron must be routed through the chankan dispatcher (different
    // head-bumper anchor + chankan yaku flag handled by the engine).
    if (this.state.phase === "awaiting_chankan") {
      const candidates: Seat[] = [...pendingChankanBotRons];
      for (let s = 0; s < 4; s++) {
        const a = humanActions[s];
        if (a && a.type === "ron") {
          candidates.push(s as Seat);
        }
      }
      if (candidates.length > 0) {
        await this.dispatchChankanRons(candidates);
      } else {
        await this.completeShouminkanAndResume();
      }
      return;
    }

    // Combine human + bot ron candidates. Ron beats every other call.
    const ronCandidates: Seat[] = [...pendingBotRons];
    for (let s = 0; s < 4; s++) {
      const a = humanActions[s];
      if (a && a.type === "ron") {
        ronCandidates.push(s as Seat);
      }
    }
    if (ronCandidates.length > 0) {
      await this.resolveRons(ronCandidates);
      return;
    }

    // No ron. Resolve pon/kan/chi from humans (slice 2b: humans
    // can now claim pon/kan/chi in concurrent windows). Pon and
    // kan beat chi; among multiple equal-priority claims pick
    // the head-bumpered seat (closest counter-clockwise from
    // the discarder). Bot pon/kan combine into the same pool.
    const discarder = this.state.lastDiscard?.seat;
    const claimed = this.state.lastDiscard?.tile;
    if (discarder === undefined || claimed === undefined) {
      // Defensive: window should never outlive the discard.
      await this.advanceTurn();
      return;
    }
    const headBump = (a: Seat, b: Seat): number =>
      ((a - discarder + 3) % 4) - ((b - discarder + 3) % 4);

    type CallClaim =
      | { kind: "chi"; seat: Seat; tiles: [Tile, Tile] }
      | { kind: "pon"; seat: Seat; tiles: [Tile, Tile] }
      | { kind: "daiminkan"; seat: Seat };

    const claims: CallClaim[] = [];
    for (let s = 0; s < 4; s++) {
      const a = humanActions[s];
      if (!a) {
        continue;
      }
      if (a.type === "chi" && a.tiles) {
        claims.push({
          kind: "chi",
          seat: s as Seat,
          tiles: [a.tiles[0], a.tiles[1]],
        });
      } else if (a.type === "pon" && a.tiles) {
        claims.push({
          kind: "pon",
          seat: s as Seat,
          tiles: [a.tiles[0], a.tiles[1]],
        });
      } else if (a.type === "kan" && a.kanKind === "daiminkan") {
        claims.push({ kind: "daiminkan", seat: s as Seat });
      }
    }
    for (const bc of pendingBotCalls) {
      if (bc.option.kind === "pon") {
        claims.push({
          kind: "pon",
          seat: bc.seat,
          tiles: [bc.option.tiles[0], bc.option.tiles[1]],
        });
      } else if (bc.option.kind === "daiminkan") {
        claims.push({ kind: "daiminkan", seat: bc.seat });
      } else if (bc.option.kind === "chi") {
        claims.push({
          kind: "chi",
          seat: bc.seat,
          tiles: [bc.option.tiles[0], bc.option.tiles[1]],
        });
      }
    }

    if (claims.length === 0) {
      // Everyone passed.
      await this.advanceTurn();
      return;
    }
    // Priority: pon/kan > chi.
    const ponOrKan = claims.filter(
      (c) => c.kind === "pon" || c.kind === "daiminkan"
    );
    const winners = ponOrKan.length > 0 ? ponOrKan : claims;
    winners.sort((a, b) => headBump(a.seat, b.seat));
    const winner = winners[0];

    if (winner.kind === "chi") {
      await this.applyEngineAction({
        type: "chi",
        seat: winner.seat,
        tiles: winner.tiles,
      });
    } else if (winner.kind === "pon") {
      await this.applyEngineAction({
        type: "pon",
        seat: winner.seat,
        tiles: winner.tiles,
      });
    } else {
      await this.applyEngineAction({
        type: "kan",
        seat: winner.seat,
        kind: "daiminkan",
        tile: claimed,
      });
    }
    await this.afterCall();
  }

  /**
   * After a successful chi/pon/daiminkan, the engine puts the calling
   * seat into `awaiting_discard` (and for daiminkan also draws a
    * rinshan tile). If the caller is human, surface their discard
    * legals and wait.
   */
  private async afterCall(): Promise<void> {
    if (
      this.state.phase === "hand_ended" ||
      this.state.phase === "match_ended"
    ) {
      await this.afterHandEnd();
      return;
    }
    // After a call, `state.turn` is the caller. For chi/pon/daiminkan
    // we land in `awaiting_discard`; that seat (human or otherwise)
    // picks a tile to discard next.
    if (
      this.isHumanSeat(this.state.turn) &&
      this.state.phase === "awaiting_discard"
    ) {
      const turnSeat = this.state.turn;
      this.setSeatLegals(turnSeat, this.buildDiscardLegals(turnSeat));
      if (await this.maybeAutoRiichiDiscard()) {
        return;
      }
      this.flushLegalsToSeat(turnSeat);
      return;
    }
    // Bot caller would be unusual at this point (bots pass), but if
    // we ever extend bot AI to call, advanceTurn handles the bot
    // discard path.
    await this.advanceTurn();
  }

  /**
   * Riichi auto-discard: when the current turn seat is a human in
   * riichi and the only remaining legal action is the (single)
   * tsumogiri on the just-drawn tile, fire it immediately so the
   * human doesn't have to click their own tile every turn.
   * Returns `true` when an auto-discard was triggered (caller
   * should not flush legals or wait for further input).
   */
  private async maybeAutoRiichiDiscard(): Promise<boolean> {
    const seat = this.state.turn;
    const legals = this.legalActions[seat];
    if (
      this.isHumanSeat(seat) &&
      this.state.riichiDeclared[seat] &&
      legals.length === 1 &&
      legals[0].type === "discard" &&
      legals[0].tile
    ) {
      const tile = legals[0].tile;
      // Give the client a beat to render the draw (and play its
      // SFX) before the forced tsumogiri lands — otherwise the
      // discard event arrives in the same tick as the draw and
      // the draw cue gets stomped. Mirrors `DRAW_TO_DISCARD
      // _DELAY_MS` so a riichi'd seat ticks at the same cadence
      // as every other auto-played seat.
      if (DRAW_TO_DISCARD_DELAY_MS > 0) {
        await this.runUncheckpointableTransition(
          "auto_riichi_pacing",
          DRAW_TO_DISCARD_DELAY_MS
        );
      }
      await this.applyDiscard(seat, tile, legals[0].discardSource);
      await this.afterDiscard();
      return true;
    }
    return false;
  }

  private async applyEngineAction(
    action: Parameters<typeof step>[1]
  ): Promise<void> {
    const res = step(this.state, action);
    if (res.events.length === 0) {
      throw new Error(
        `applyEngineAction: engine rejected ${action.type} for seat ${
          "seat" in action ? action.seat : "?"
        }`
      );
    }
    this.state = res.state;
    for (const e of res.events) {
      await this.emitEngineEvent(e);
    }
    await this.emitFuritenChanges(res.furitenChanges);
  }

  private async applyDiscard(
    seat: Seat,
    tile: Tile,
    discardSource?: DiscardSource
  ): Promise<void> {
    const res = step(this.state, {
      type: "discard",
      seat,
      tile,
      discardSource,
    });
    if (res.events.length === 0) {
      // Engine rejected the action (illegal). Should not happen on
      // bot-driven or legal-action-driven paths; surface loudly.
      throw new Error(
        `applyDiscard: engine rejected discard ${tile} for seat ${seat}`
      );
    }
    this.state = res.state;
    // Clear the discarder's legals + per-seat deadline BEFORE
    // emitting the discard event, so the wire frame the discarder
    // receives carries `deadline: undefined` (and an empty
    // `legalActions`). Otherwise the discard event would echo back
    // the still-active discard deadline and the client's HUD timer
    // would keep counting until the call window resolves (or, if
    // no call follows, until the next draw frame arrives). Mirrors
    // the same pattern used on the riichi declaration path.
    this.setSeatLegals(seat, []);
    for (const e of res.events) {
      await this.emitEngineEvent(e);
    }
    await this.emitFuritenChanges(res.furitenChanges);
  }

  private buildDiscardLegals(seat: Seat): LegalAction[] {
    const out: LegalAction[] = [];
    const inRiichi = this.state.riichiDeclared[seat];
    if (inRiichi) {
      // Riichi locks the discard: the drawn tile must be discarded
      // tsumogiri. Only declarations that don't break tenpai
      // (tsumo, in-riichi-legal ankan) interrupt that flow. The
      // single discard option corresponds to `lastDrawn[seat]`; the
      // turn auto-resolves it from `advanceTurn` when no win/kan is
      // chosen.
      const drawn = this.state.lastDrawn[seat];
      if (drawn !== null) {
        out.push({
          id: `discard:draw:${drawn}`,
          type: "discard",
          tile: drawn,
          discardSource: "draw",
        });
      }
    } else {
      const hand = this.state.hands[seat];
      const drawn = this.state.lastDrawn[seat];
      if (drawn !== null && hand[hand.length - 1] === drawn) {
        out.push({
          id: `discard:draw:${drawn}`,
          type: "discard",
          tile: drawn,
          discardSource: "draw",
        });
      }
      // One hand-source action per unique tile, excluding the
      // appended drawn slot. A duplicate drawn value therefore
      // has both a hand action and a draw action.
      const seen = new Set<string>();
      const handEnd = drawn !== null ? hand.length - 1 : hand.length;
      for (let index = 0; index < handEnd; index++) {
        const tile = hand[index];
        if (seen.has(tile)) {
          continue;
        }
        seen.add(tile);
        out.push({
          id: `discard:hand:${tile}`,
          type: "discard",
          tile,
          discardSource: "hand",
        });
      }
    }
    // Tsumo: if `step` accepts a tsumo declaration for this seat,
    // surface it. The engine returns an empty event list for a
    // non-agari hand (noop), so a non-zero event count means the
    // current 14-tile hand is winning.
    const tsumoProbe = step(this.state, { type: "tsumo", seat });
    if (tsumoProbe.events.length > 0) {
      out.push({ id: "tsumo", type: "tsumo" });
    }
    // Self-call kans (ankan / shouminkan). The engine itself
    // rejects in-riichi shouminkan and any ankan that would change
    // the wait shape, so we can safely surface its accepted set.
    for (const opt of this.buildSelfKanLegals(seat)) {
      out.push(opt);
    }
    if (inRiichi) {
      return out;
    }
    // Riichi: enumerate the discardable tiles whose post-discard
    // 13-tile hand leaves the seat in tenpai. The engine's `step`
    // returns an empty event list when the riichi declaration is
    // rejected (already declared, < 1000 score, < 4 wall, open hand,
    // hand not tenpai after discard, etc.), so a non-zero event
    // count is sufficient to surface the option.
    if (!this.state.riichiDeclared[seat]) {
      const discardChoices = out.filter(
        (action) => action.type === "discard" && action.tile
      );
      const riichiChoices = [...discardChoices].sort((left, right) => {
        if (left.discardSource === right.discardSource) {
          return 0;
        }
        return left.discardSource === "draw" ? 1 : -1;
      });
      for (const choice of riichiChoices) {
        const tile = choice.tile as Tile;
        const probe = step(this.state, {
          type: "riichi",
          seat,
          tile,
          discardSource: choice.discardSource,
        });
        if (probe.events.length > 0) {
          out.push({
            id: `riichi:${choice.discardSource ?? "hand"}:${tile}`,
            type: "riichi",
            tile,
            discardSource: choice.discardSource,
          });
        }
      }
    }
    return out;
  }

  /**
   * Self-call kans: ankan (4 of the same tile in hand) and
   * shouminkan (matching pon already declared + 4th tile in hand).
   * Ankan during riichi is restricted to kans that don't change the
   * winning interpretation of the tenpai hand — enforced by the
   * engine; here we surface them and let `step.ts` reject illegal
   * declarations.
   *
   * Riichi-rules gate: a self-kan may only be declared immediately
   * after a draw (live wall or rinshan from a previous kan), never
   * after a chi/pon. We detect "just drew" via `lastDrawn[seat] !==
   * null` — chi/pon/daiminkan all clear the seat's `lastDrawn`
   * slot in `step.ts`, while every flavor of draw sets it.
   */
  private buildSelfKanLegals(seat: Seat): LegalAction[] {
    const out: LegalAction[] = [];
    if (this.state.phase !== "awaiting_discard") {
      return out;
    }
    if (this.state.liveWall.length === 0) {
      return out;
    }
    if (this.state.lastDrawn[seat] === null) {
      return out;
    }
    // Group hand tiles by canonical key (red 5 collapsed to 5).
    const counts = new Map<string, Tile[]>();
    for (const tile of this.state.hands[seat]) {
      const key = (tile[0] === "0" ? "5" : tile[0]) + tile[1];
      const arr = counts.get(key) ?? [];
      arr.push(tile);
      counts.set(key, arr);
    }
    // Ankan: any group with 4 copies.
    for (const [, group] of counts) {
      if (group.length >= 4) {
        const t = group[0];
        out.push({
          id: `kan:ankan:${t}`,
          type: "kan",
          kanKind: "ankan",
          tiles: [group[0], group[1], group[2]],
        });
      }
    }
    // Shouminkan: existing open pon owned by `seat` whose canonical
    // key matches a tile in hand. Riichi locks out shouminkan
    // declarations entirely.
    if (!this.state.riichiDeclared[seat]) {
      for (const meld of this.state.melds[seat]) {
        if (meld.type !== "pon") {
          continue;
        }
        const t = meld.tiles[0];
        const key = (t[0] === "0" ? "5" : t[0]) + t[1];
        const inHand = counts.get(key);
        if (inHand && inHand.length >= 1) {
          out.push({
            id: `kan:shouminkan:${inHand[0]}`,
            type: "kan",
            kanKind: "shouminkan",
            tiles: [inHand[0]],
          });
        }
      }
    }
    return out;
  }

  /**
   * Per-seat legals setter. Mutates `legalActions[seat]` and keeps
   * the matching deadline timer + start-time fields in lockstep.
   * Captures the action-window start, publishes the *visible*
   * deadline (`now + BASE_ACTION_MS`), and schedules the auto-
   * default for `now + BASE_ACTION_MS + bufferMs[seat] +
   * ACTION_GRACE_MS` — i.e. the seat's full think pool plus a
   * small lag-tolerance grace that doesn't bill the buffer.
   *
   * Always allocate a fresh start time per assignment: even when
   * the incoming set matches the prior one structurally, the
   * caller has reached this point because the engine state moved
   * forward (post-discard, post-call, …) and the seat deserves a
   * fresh budget. Cheap and avoids subtle "did the action set
   * really change?" comparisons.
   */
  private setSeatLegals(seat: Seat, actions: LegalAction[]): void {
    this.legalActions[seat] = actions;
    const existing = this.currentDeadlineTimer[seat];
    if (existing !== null) {
      existing.cancel();
      this.currentDeadlineTimer[seat] = null;
    }
    this.deadlineEpoch[seat] += 1;
    if (actions.length > 0 && BASE_ACTION_MS > 0) {
      const now = this.runtime.now();
      this.currentActionStartMs[seat] = now;
      this.currentDeadline[seat] = now + BASE_ACTION_MS;
      // Disconnected / AFK seats skip the human think pool: they
      // auto-default with the same draw→discard pause that other
      // auto-played seats use, so the cadence stays consistent
      // across seats (and tests that zero the delay via
      // `setDelayAfterDiscardMs(0)` retain their original
      // synchronous "no wait" semantics).
      const totalMs = this.disconnected[seat]
        ? DRAW_TO_DISCARD_DELAY_MS
        : BASE_ACTION_MS + this.bufferMs[seat] + ACTION_GRACE_MS;
      const epoch = this.deadlineEpoch[seat];
      const timer = this.runtime.schedule(
        () => {
          if (epoch !== this.deadlineEpoch[seat]) {
            return;
          }
          void this.handleDeadlineExpiry(seat);
        },
        totalMs,
        { unref: true }
      );
      this.currentDeadlineTimer[seat] = timer;
    } else {
      this.currentDeadline[seat] = null;
      this.currentActionStartMs[seat] = null;
    }
  }

  /**
   * Bill `seat`'s buffer for any time spent beyond the base per-
   * action budget. Called from `handleAct` before we apply the
   * action, so the next `setSeatLegals` (post-action) uses the
   * updated buffer when scheduling its expiry. Idempotent if
   * `currentActionStartMs[seat]` is already null (auto-default
   * path).
   */
  private consumeActionBuffer(seat: Seat): void {
    const startMs = this.currentActionStartMs[seat];
    if (startMs === null) {
      return;
    }
    const elapsed = this.runtime.now() - startMs;
    const overage = elapsed - BASE_ACTION_MS - ACTION_GRACE_MS;
    if (overage > 0) {
      let next = Math.max(0, this.bufferMs[seat] - overage);
      // The client renders the buffer as `ceil(bufferMs / 1000)`,
      // so a sub-second sliver left over after a deadline expiry
      // (the timer fires `ACTION_GRACE_MS` past the visible
      // countdown's zero, which the consumer treats as "free"
      // think time) would be painted as a misleading "+1" the
      // next turn even though the player exhausted the visible
      // pool. Snap down to whole-second granularity to keep the
      // displayed buffer and the server state in sync.
      next = Math.floor(next / 1000) * 1000;
      this.bufferMs[seat] = next;
    }
    this.currentActionStartMs[seat] = null;
  }

  /**
   * Server-side enforcement of `seat`'s action deadline. Picks
   * the least-impact default for the current window and routes
   * it through `handleAct` so accounting (broadcast, log, next-
   * turn scheduling) matches a human-submitted action exactly.
   *
   * Defaults:
   *   - call window open → `pass` (always present in the set).
   *   - awaiting discard → tsumogiri (discard the just-drawn
   *     tile). Falls back to the first legal discard when the
   *     drawn tile isn't a legal discard (post-call awaiting
   *     discard has no drawn tile to tsumogiri).
   *
   * Tsumo / riichi / self-kan are intentionally never auto-chosen:
   * those are strategic declarations and silently winning a hand
   * for an AFK player would be worse than the missed turn.
   */
  private async handleDeadlineExpiry(seat: Seat): Promise<void> {
    const activeTransaction = this.commandTransactionPromise;
    if (activeTransaction !== null) {
      try {
        await activeTransaction;
      } catch {
        // A failed client transaction leaves the process blocked.
      }
      if (!this.isPaused) {
        await this.handleDeadlineExpiry(seat);
      }
      return;
    }
    if (this.isPaused) {
      return;
    }
    // Buffer-exhausted human seats get one liveness ping before
    // we fire the auto-default. If the WS doesn't pong back in
    // time, the seat is flagged disconnected — future windows
    // skip the wait entirely. Already-disconnected seats skip the
    // probe (we already know they're out) and bot seats never
    // had a probe in the first place.
    const isHuman = this.isHumanSeat(seat);
    const probe = this.livenessProbes[seat];
    const connectionGeneration = this.humanConnectionGeneration[seat];
    if (
      isHuman &&
      probe !== null &&
      this.bufferMs[seat] === 0 &&
      !this.disconnected[seat] &&
      !this.livenessProbeInflight[seat]
    ) {
      this.livenessProbeInflight[seat] = true;
      try {
        const alive = await probe();
        const isCurrentConnection =
          this.humanConnectionGeneration[seat] === connectionGeneration &&
          this.livenessProbes[seat] === probe;
        if (!isCurrentConnection) {
          // A replacement socket attached while this probe was pending.
        } else if (alive) {
          this.livenessProbeMisses[seat] = 0;
        } else if (!this.disconnected[seat]) {
          this.livenessProbeMisses[seat] += 1;
          if (this.livenessProbeMisses[seat] >= LIVENESS_PROBE_STRIKE_COUNT) {
            this.disconnected[seat] = true;
            this.broadcastRoomState();
          }
        }
      } finally {
        if (
          this.humanConnectionGeneration[seat] === connectionGeneration &&
          this.livenessProbes[seat] === probe
        ) {
          this.livenessProbeInflight[seat] = false;
        }
      }
    }
    const actionId = this.pickDefaultActionId(seat);
    if (actionId === null) {
      return;
    }
    await this.handleActDirect(seat, actionId);
  }

  private pickDefaultActionId(seat: Seat): string | null {
    const legals = this.legalActions[seat];
    if (legals.length === 0) {
      return null;
    }
    if (this.callWindow[seat] !== null) {
      const pass = legals.find((a) => a.type === "pass");
      return pass ? pass.id : null;
    }
    const drawn = this.state.lastDrawn[seat];
    if (drawn !== null) {
      const tsumogiri = legals.find(
        (a) =>
          a.type === "discard" &&
          a.tile === drawn &&
          (a.discardSource === "draw" || a.discardSource === undefined)
      );
      if (tsumogiri) {
        return tsumogiri.id;
      }
    }
    const anyDiscard = legals.find((a) => a.type === "discard");
    return anyDiscard ? anyDiscard.id : null;
  }

  private flushLegalsToSeat(seat: Seat): void {
    const send = this.humanSockets[seat];
    if (!send) {
      return;
    }
    // Legals-only refresh — not a new event, so we don't advance
    // the seat's per-seat seq counter.
    const deadline = this.currentDeadline[seat];
    send({
      type: "event",
      seq: this.seatSeq[seat] - 1,
      events: [],
      legalActions: this.legalActions[seat],
      ...(deadline !== null ? { deadline } : {}),
      bufferMs: this.bufferMs[seat],
    });
  }

  /**
   * Called after a step that left the engine in `hand_ended` (or
   * `match_ended`). For `match_ended` we just finalize. For
   * `hand_ended` we dispatch `start_next_hand` and resume the turn
   * loop on the new dealer; if the engine then reports
   * `match_ended`, finalize with the engine-provided final scores.
   *
   * The `hand_end` wire event is already emitted by the upstream
   * engine event during the triggering step, so we never re-emit it
   * here.
   */
  private async afterHandEnd(): Promise<void> {
    if (this.state.phase === "match_ended") {
      // Engine never emits `match_end` from a non-`start_next_hand`
      // step, so finalize directly with current scores.
      await this.endMatch(
        this.state.lastHandResult?.reason ?? "exhaustive_draw",
        { skipHandEnd: true }
      );
      return;
    }
    if (this.state.phase !== "hand_ended") {
      return;
    }
    // Reset orchestrator-level per-hand state.
    this.callWindow = [null, null, null, null];
    this.pendingHumanCallActions = [null, null, null, null];
    this.pendingBotRons = [];
    this.pendingBotCalls = [];
    for (let s = 0; s < 4; s++) {
      this.setSeatLegals(s as Seat, []);
    }

    // Post-hand ready check: clients display an OK button + 5s
    // countdown over the win / draw panel. Resumes as soon as
    // every human acks or the deadline elapses. Skipped in tests
    // via `setNextHandDelayMs(0)`.
    if (NEXT_HAND_DELAY_MS > 0) {
      // For win results, hold off on starting the OK countdown
      // until the client's staged win-info reveal has had time
      // to play out (per-yaku 750ms beats + optional ura tail).
      // `pendingWinRevealMs` is accumulated by `emitEngineEvent`
      // as each `win` event fires and is 0 for non-win endings.
      const revealMs = this.pendingWinRevealMs;
      this.pendingWinRevealMs = 0;
      if (revealMs > 0) {
        await this.runResultTransition(
          "post_hand_reveal",
          revealMs,
          NEXT_HAND_DELAY_MS
        );
      }
      await this.runReadyCheck(NEXT_HAND_DELAY_MS, "next_hand");
    } else {
      this.pendingWinRevealMs = 0;
    }

    await this.beginNextHandAfterReady();
  }

  private async beginNextHandAfterReady(): Promise<void> {
    const result = step(this.state, { type: "start_next_hand" });
    this.state = result.state;
    for (const ev of result.events) {
      await this.emitEngineEvent(ev);
      if (this.finalized) {
        return;
      }
    }
    await this.emitFuritenChanges(result.furitenChanges);
    if (this.state.phase === "match_ended" || this.finalized) {
      return;
    }
    await this.advanceTurn();
  }

  private async endMatch(
    reason: "exhaustive_draw" | "ron" | "tsumo" | "abort",
    opts: {
      skipHandEnd?: boolean;
      finalScores?: [number, number, number, number];
      matchEndReason?: MatchEndReason;
      /**
       * When true, skip the Buu continue-vote and finalize the
       * session immediately with `reason: "server_abort"`. Set
       * by the orchestrator for shutdown / forced-end paths so a
       * dying server doesn't leave clients staring at a frozen
       * vote modal.
       */
      serverAbort?: boolean;
    } = {}
  ): Promise<void> {
    if (this.sessionFinalized) {
      return;
    }
    if (this.finalized) {
      // This game already wrapped up; either we're between games
      // in a session (awaiting vote) or finalizeSession is in
      // flight. Either way, ignore the duplicate trigger.
      return;
    }
    this.finalized = true;
    if (!opts.skipHandEnd) {
      await this.emitEvent({ type: "hand_end", reason });
    }
    const rawScores: [number, number, number, number] =
      opts.finalScores ?? this.state.scores;
    // Place by score desc; ties broken by seat order (closer to dealer wins).
    const ordered = [0, 1, 2, 3]
      .map((s) => ({ seat: s as Seat, score: rawScores[s] }))
      .sort((a, b) => {
        if (b.score !== a.score) {
          return b.score - a.score;
        }
        return a.seat - b.seat;
      });
    const placeBySeat = new Map<Seat, 1 | 2 | 3 | 4>();
    for (let i = 0; i < ordered.length; i++) {
      placeBySeat.set(ordered[i].seat, (i + 1) as 1 | 2 | 3 | 4);
    }
    const finalScores = [0, 1, 2, 3].map((s) => ({
      seat: s as Seat,
      score: rawScores[s],
      place: placeBySeat.get(s as Seat) as 1 | 2 | 3 | 4,
    }));

    // Snapshot engine-level chips/dabuken into the session ledger
    // BEFORE emitting `match_end`, so the event carries the
    // post-game session view. No-op for non-Buu sessions (chips
    // and dabuken stay at zero/false throughout).
    const isBuu = this.state.ruleSet.buuMode;
    let chipsDelta: [number, number, number, number] | null = null;
    if (isBuu) {
      // End-of-game chip payout. Per-hand sankoro/nikoro/chinmai
      // chip transfers are disabled (see `applyBuuWinSideEffects`
      // in `step.ts`); chips only move via chombo penalties
      // during the game and via this end-of-game settlement.
      // Dabuken awards / consumption also happen here (not per
      // hand) — see `evaluateBuuEndOfGameChips` for the rule
      // definition.
      const eog = evaluateBuuEndOfGameChips(this.state);
      applyChipDelta(this.state.chips, eog.chipDelta);
      // Wipe every seat's dabuken first (any prior token is
      // either consumed by the winner or expires unused), then
      // award a fresh one to the winner iff this settlement was
      // a sankoro.
      this.state.dabuken = [false, false, false, false];
      if (eog.awardedDabuken) {
        this.state.dabuken[eog.winner] = true;
      }

      // Per-seat chip change reported in `match_end`. We only
      // surface the end-of-game settlement payout (sankoro /
      // nikoro / chinmai, possibly doubled by a consumed
      // dabuken) — NOT the full `state.chips - gameStartChips`
      // diff. The reason: any in-game chombo penalties have
      // already been animated into the on-table chip counters
      // when they happened, so including them in the match-end
      // delta would double-count them visually (the score panel
      // would show a "compound" number that the player has
      // already watched accrue tile-by-tile during play).
      chipsDelta = [
        eog.chipDelta[0],
        eog.chipDelta[1],
        eog.chipDelta[2],
        eog.chipDelta[3],
      ];
      this.sessionChips = [...this.state.chips] as [
        number,
        number,
        number,
        number,
      ];
      this.sessionDabuken = [...this.state.dabuken] as [
        boolean,
        boolean,
        boolean,
        boolean,
      ];
    }
    await this.emitEvent({
      type: "match_end",
      reason: opts.matchEndReason ?? "round_limit",
      finalScores,
      ...(isBuu
        ? {
            chips: [...this.sessionChips],
            dabuken: [...this.sessionDabuken],
            gameIndex: this.gameIndex,
            ...(chipsDelta ? { chipsDelta } : {}),
          }
        : {}),
    });
    await this.archiveCurrentGame(finalScores);

    // Buu multi-game session: ask the table whether to start
    // another East-only game. Bots auto-yes; disconnected humans
    // auto-no. The whole session ends on any "no" or timeout.
    if (isBuu && !opts.serverAbort) {
      // Hold the "match ended" screen for a moment before the
      // continue-vote overlay opens and covers it.
      if (MATCH_END_DISPLAY_MS > 0) {
        await this.runUncheckpointableTransition(
          "match_end_display",
          MATCH_END_DISPLAY_MS
        );
      }
      const cont = await this.runContinueVote(finalScores);
      await this.continueAfterVote(cont, finalScores);
      return;
    }
    await this.finalizeSession(
      opts.serverAbort ? "server_abort" : "single_game"
    );
  }

  /**
   * Slice the current game's events out of the omniscient log
   * and write both the Mongo `Match` archive and the cross-
   * platform `ReplayLog` row. Called from `endMatch` once per
   * game (so a Buu session writes N docs, all sharing
   * `sessionId === this.matchId`).
   */
  private async archiveCurrentGame(
    finalScores: Array<{ seat: Seat; score: number; place: 1 | 2 | 3 | 4 }>
  ): Promise<void> {
    const gameEvents = this.eventLog.slice(this.gameStartLogIdx);
    const docId = this.currentGameMongoId();
    await this.repository.archiveMatch({
      matchId: docId,
      events: gameEvents,
      finalScores: finalScores.map((f) => ({
        seat: f.seat,
        score: f.score,
        place: f.place,
      })),
    });
    try {
      const startedAt = this.startedAt ?? new Date(this.runtime.now());
      await this.repository.archiveReplayLog({
        matchId: docId,
        startedAt,
        endedAt: new Date(this.runtime.now()),
        ruleSet: this.state.ruleSet.buuMode ? "buu-east" : "tenhou-default",
        events: gameEvents.map((e) => e.event),
        seats: finalScores.map((f) => {
          const player = this.players.get(f.seat);
          return {
            seat: f.seat,
            displayName: player?.displayName ?? `Seat ${f.seat}`,
            finalScore: f.score,
            place: f.place,
          };
        }),
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[game-server] archiveReplayLog failed (non-fatal)", err);
    }
  }

  /**
   * Mongo doc id for the currently-running game. Non-Buu matches
   * use the raw `matchId` (legacy compatibility). Buu sessions
   * suffix each game with `-g${gameIndex}` so a session writes N
   * sibling docs sharing the same `sessionId`.
   */
  private currentGameMongoId(): string {
    if (!this.state?.ruleSet.buuMode) {
      return this.matchId;
    }
    return `${this.matchId}-g${this.gameIndex}`;
  }

  /**
   * Open a Buu continue-vote window and resolve once every seat
   * has voted (unanimous yes → continue) or any seat votes no /
   * the deadline elapses → end session. Bots are auto-yes;
   * disconnected humans are auto-no. Resolves true to continue,
   * false to end.
   */
  private async runContinueVote(finalScores: FinalScore[]): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      this.continueVote = [null, null, null, null];
      this.continueVoteFinalScores = finalScores.map((score) => ({ ...score }));
      this.lastVoteReason = null;
      for (let s = 0; s < 4; s++) {
        const p = this.players.get(s as Seat);
        if (p?.isBot) {
          this.continueVote[s] = "yes";
        }
      }
      for (let s = 0; s < 4; s++) {
        if (this.disconnected[s] && this.continueVote[s] === null) {
          this.continueVote[s] = "no";
        }
      }
      this.continueVoteDeadline = this.runtime.now() + CONTINUE_VOTE_MS;
      this.continueVoteResolve = resolve;
      // Fire-and-forget: the broadcast emits a normal wire event
      // and persists into the omniscient log.
      void this.emitEvent({
        type: "session_vote_open",
        deadline: this.continueVoteDeadline,
        votes: [...this.continueVote] as [
          "yes" | "no" | null,
          "yes" | "no" | null,
          "yes" | "no" | null,
          "yes" | "no" | null,
        ],
        gameIndex: this.gameIndex,
      });

      // Resolve immediately if bots-only / pre-voted state already
      // decides the question.
      this.tallyContinueVote();
      if (this.continueVoteResolve === null) {
        return;
      }
      if (CONTINUE_VOTE_MS > 0) {
        this.continueVoteTimer = this.runtime.schedule(
          () => {
            this.lastVoteReason = "vote_timeout";
            this.finishContinueVote(false);
          },
          CONTINUE_VOTE_MS,
          { unref: true }
        );
      }
    });
  }

  /**
   * Public WS entry point for a seated human's continue-vote
   * frame. No-ops outside an open vote window. Voters may
   * change their mind freely (yes ↔ no) until the window
   * resolves.
   */
  handleVoteContinue(seat: Seat, vote: "yes" | "no"): void {
    if (this.isPaused) {
      return;
    }
    if (this.continueVoteResolve === null) {
      return;
    }
    if (this.continueVote[seat] === vote) {
      return;
    }
    this.continueVote[seat] = vote;
    void this.emitEvent({
      type: "session_vote_update",
      votes: [...this.continueVote] as [
        "yes" | "no" | null,
        "yes" | "no" | null,
        "yes" | "no" | null,
        "yes" | "no" | null,
      ],
    });
    this.tallyContinueVote();
  }

  private tallyContinueVote(): void {
    if (this.continueVoteResolve === null) {
      return;
    }
    if (this.continueVote.some((v) => v === "no")) {
      this.lastVoteReason = "vote_no";
      this.finishContinueVote(false);
      return;
    }
    if (this.continueVote.every((v) => v === "yes")) {
      this.finishContinueVote(true);
      return;
    }
  }

  private finishContinueVote(cont: boolean): void {
    if (this.isPaused) {
      return;
    }
    if (this.continueVoteTimer) {
      this.continueVoteTimer.cancel();
      this.continueVoteTimer = null;
    }
    const resolve = this.continueVoteResolve;
    this.continueVoteResolve = null;
    this.continueVoteDeadline = null;
    this.continueVoteFinalScores = null;
    if (resolve) {
      resolve(cont);
    }
  }

  private async continueAfterVote(
    cont: boolean,
    finalScores: FinalScore[]
  ): Promise<void> {
    if (cont) {
      await this.startNextGame(finalScores);
      return;
    }
    await this.finalizeSession(this.lastVoteReason ?? "vote_no");
  }

  /**
   * Begin the next game of an ongoing Buu session. Seats are
   * permuted so the previous game's place-1 finisher takes East
   * (seat 0); the other three are randomized via a session-
   * deterministic RNG. Chips / dabuken are carried across,
   * permuted by the same seating; scores reset to the rule-set
   * starting value.
   */
  private async startNextGame(
    finalScores: FinalScore[]
  ): Promise<void> {
    const winnerEntry = finalScores.find((f) => f.place === 1);
    if (!winnerEntry) {
      // Defensive: should never happen — `finalScores` always has a place-1.
      await this.finalizeSession("server_abort");
      return;
    }
    const winnerOldSeat = winnerEntry.seat;
    const others = ([0, 1, 2, 3] as Seat[]).filter((s) => s !== winnerOldSeat);
    const rngSeed = (this.seed + (this.gameIndex + 1) * 0x9e3779b9) | 0;
    const shuffled = deterministicShuffle(others, rngSeed);
    const perm: [Seat, Seat, Seat, Seat] = [
      winnerOldSeat,
      shuffled[0],
      shuffled[1],
      shuffled[2],
    ];

    // Permute identity-bound orchestrator state through the same
    // primitive used by the initial waiting-room shuffle.
    const oldChips = [...this.sessionChips] as [number, number, number, number];
    const oldDabuken = [...this.sessionDabuken] as [
      boolean,
      boolean,
      boolean,
      boolean,
    ];
    this.permuteSeatOccupants(perm);
    for (let newSeat = 0; newSeat < 4; newSeat++) {
      const fromSeat = perm[newSeat];
      this.sessionChips[newSeat] = oldChips[fromSeat];
      this.sessionDabuken[newSeat] = oldDabuken[fromSeat];
    }

    // Advance session, derive deterministic next seed.
    this.gameIndex += 1;
    const nextSeed = (this.seed + this.gameIndex * 0x9e3779b9) | 0;
    this.state = createInitialState(nextSeed, {
      ruleSet: this.ruleSetOverride,
    });
    this.state.chips = [...this.sessionChips] as [
      number,
      number,
      number,
      number,
    ];
    this.state.dabuken = [...this.sessionDabuken] as [
      boolean,
      boolean,
      boolean,
      boolean,
    ];
    // Snapshot starting chips for this game (Buu) so the next
    // `match_end` can emit a per-game chip delta.
    this.gameStartChips = [...this.state.chips] as [
      number,
      number,
      number,
      number,
    ];

    // Reset per-game orchestrator state.
    this.callWindow = [null, null, null, null];
    this.pendingHumanCallActions = [null, null, null, null];
    this.pendingBotRons = [];
    this.pendingBotCalls = [];
    this.riichiTileIdx = [null, null, null, null];
    this.bufferMs = [
      INITIAL_BUFFER_MS,
      INITIAL_BUFFER_MS,
      INITIAL_BUFFER_MS,
      INITIAL_BUFFER_MS,
    ];
    this.finalized = false;
    for (let s = 0; s < 4; s++) {
      this.setSeatLegals(s as Seat, []);
    }

    const matchPlayers: PersistedMatchPlayer[] = [];
    for (const [seat, p] of this.players) {
      if (p === null) {
        continue;
      }
      matchPlayers.push({
        userId: p.userId,
        seat,
        displayName: p.displayName,
        isBot: p.isBot,
      });
    }

    await this.repository.createMatch({
      matchId: this.currentGameMongoId(),
      seed: nextSeed,
      players: matchPlayers,
      sessionId: this.matchId,
      gameIndex: this.gameIndex,
    });

    // Re-broadcast room_state so each human's `mySeat` reflects
    // the new seating before they see `match_start`.
    this.broadcastRoomState();

    this.gameStartLogIdx = this.eventLog.length;

    await this.emitEvent({
      type: "match_start",
      seats: matchPlayers.map((p) => ({
        seat: p.seat,
        userId: p.userId,
        displayName: p.displayName,
      })),
      ruleSet: this.state.ruleSet.buuMode ? "buu-east" : "tenhou-default",
      riichiBetValue: this.state.ruleSet.riichiBetValue,
      ...(this.state.ruleSet.scoreCap
        ? { scoreCap: this.state.ruleSet.scoreCap }
        : {}),
      ...(this.state.ruleSet.buuMode
        ? {
            chips: [...this.state.chips] as [number, number, number, number],
            dabuken: [...this.state.dabuken] as [
              boolean,
              boolean,
              boolean,
              boolean,
            ],
          }
        : {}),
    });

    await this.runReadyCheck(READY_CHECK_MS, "initial_hand");

    await this.beginInitialHandAfterReady();
  }

  /**
   * Finalize the whole session. Emits `session_end`, flips
   * status to `finished`, and prevents any further game-level
   * resumption.
   */
  private finalizeSession(
    reason: "vote_no" | "vote_timeout" | "single_game" | "server_abort"
  ): Promise<void> {
    if (this.sessionFinalized) {
      return Promise.resolve();
    }
    if (this.sessionFinalizePromise !== null) {
      return this.sessionFinalizePromise;
    }
    this.pendingSessionEndReason ??= reason;
    const finalizing = this.persistTerminalAndFinalize();
    this.sessionFinalizePromise = finalizing;
    return finalizing;
  }

  private async persistTerminalAndFinalize(): Promise<void> {
    const reason = this.pendingSessionEndReason;
    if (reason === null) {
      return;
    }
    try {
      await this.repository.markCheckpointTerminal({
        matchId: this.matchId,
        finishedAt: this.runtime.now(),
      });
      this.sessionFinalized = true;
      this.statusValue = "finished";
      await this.emitEvent({
        type: "session_end",
        reason,
        gamesPlayed: this.gameIndex + 1,
        chips: [...this.sessionChips],
      });
      this.pendingSessionEndReason = null;
    } finally {
      this.sessionFinalizePromise = null;
    }
  }

  async retryPendingFinalization(): Promise<boolean> {
    if (this.sessionFinalized) {
      return true;
    }
    const reason = this.pendingSessionEndReason;
    if (reason === null) {
      return false;
    }
    await this.finalizeSession(reason);
    return this.sessionFinalized;
  }

  /**
   * Emit a wire `furiten` event for every per-seat transition the
   * engine flagged on the just-applied step. No-op when the step
   * didn't change anyone's furiten status. Always runs *after* the
   * step's own engine events so the client sees the indicator flip
   * immediately following the state change that caused it.
   */
  private async emitFuritenChanges(
    changes: FuritenChange[] | undefined
  ): Promise<void> {
    if (!changes) {
      return;
    }
    for (const c of changes) {
      await this.emitEvent({
        type: "furiten",
        seat: c.seat,
        active: c.active,
      });
    }
  }

  /**
   * Translate a pure engine event into the wire `GameEvent` and
   * persist + broadcast it. The two unions share field names so the
   * mapping is mostly structural.
   */
  private async emitEngineEvent(e: EngineEvent): Promise<void> {
    // Chombo-by-winning: the engine emits `win` then
    // `buu_chombo` in the same step batch (see `applyWin` in
    // `app/game/rules/step.ts`). Pause between them so the
    // client renders the win-info panel for its normal
    // display duration before the chombo screen takes over.
    if (
      e.type === "buu_chombo" &&
      this.lastEngineEventType === "win" &&
      NEXT_HAND_DELAY_MS > 0
    ) {
      await this.runReadyCheck(NEXT_HAND_DELAY_MS);
    }
    // Pause between the `win` event (which makes the client flip
    // the winner's concealed hand face-up at the seat band) and
    // the `hand_end` event (which pops up the central win-info
    // panel). Without this, the panel can occlude the flipped
    // hand before the audience registers what was declared.
    if (
      e.type === "hand_end" &&
      this.lastEngineEventType === "win" &&
      WIN_TO_PANEL_DELAY_MS > 0
    ) {
      await this.runUncheckpointableTransition(
        "win_to_panel",
        WIN_TO_PANEL_DELAY_MS
      );
    }
    this.lastEngineEventType = e.type;
    if (e.type === "draw") {
      await this.emitEvent({
        type: "draw",
        seat: e.seat,
        tile: e.tile,
        wallRemaining: e.wallRemaining,
        ...(e.fromDeadWall ? { fromDeadWall: true as const } : {}),
      });
      return;
    }
    if (e.type === "discard") {
      await this.emitEvent({
        type: "discard",
        seat: e.seat,
        tile: e.tile,
        tsumogiri: e.tsumogiri,
        discardSource: e.discardSource,
        ...(e.riichi ? { riichi: true as const } : {}),
      });
      if (e.riichi) {
        // Record the discard pile index where this seat's riichi
        // declaration tile landed, so snapshots can mark it as
        // rotated even after a rejoin.
        this.riichiTileIdx[e.seat] = this.state.discards[e.seat].length - 1;
        // The engine already deducted `riichiBetValue` from
        // `state.scores[seat]` when the riichi action stepped,
        // so the declarer may have just crossed the sink
        // threshold. Refresh the client view in Buu mode.
        if (this.state.ruleSet.buuMode) {
          await this.emitEvent({
            type: "sinking_update",
            sinking: this.computeSinking(),
          });
        }
      }
      return;
    }
    if (e.type === "win") {
      const score = e.score;
      const yakuRomaji = riichiLibYakuToRomaji(score.yaku);
      // Compute this winner's staged-reveal duration so the
      // post-hand ready check (in `afterHandEnd`) can wait for
      // the client animation to finish before starting the OK
      // countdown. Mirrors the visibility logic in
      // `TableRenderer.renderResultCenterInfo`: filter out
      // 0-han yaku, schedule each remaining yaku at a 750ms
      // beat, tack on +1000ms when ura indicators are shown
      // without an accompanying "Ura Dora" yaku, then leave one
      // final beat for the han/fu + hand-value summary.
      const hasUraIndicators =
        this.state.ruleSet.uraDora && this.state.riichiDeclared[e.winner];
      let visibleYakuCount = 0;
      let hasUraYaku = false;
      for (const [name, value] of Object.entries(yakuRomaji)) {
        const leading = parseInt(value, 10);
        if (Number.isFinite(leading) && leading === 0) {
          continue;
        }
        visibleYakuCount += 1;
        if (name === "Ura Dora") {
          hasUraYaku = true;
        }
      }
      const revealMs = winResultRevealDurationMs({
        visibleYakuCount,
        hasUraIndicators,
        hasUraYaku,
      });
      if (revealMs > this.pendingWinRevealMs) {
        this.pendingWinRevealMs = revealMs;
      }
      await this.emitEvent({
        type: "win",
        seat: e.winner,
        loser: e.loser,
        winTile: e.winTile,
        delta: e.delta,
        han: score.han,
        fu: score.fu,
        ten: score.ten,
        yakumanCount: score.yakumanCount,
        yaku: yakuRomaji,
        doraCount: score.doraCount,
        akaDoraCount: score.akaDoraCount,
        ...(hasUraIndicators ? { uraDoraCount: score.uraDoraCount } : {}),
        hand: [...this.state.hands[e.winner]],
        melds: this.state.melds[e.winner].map((m) => ({
          type: m.type,
          tiles: [...m.tiles],
          claimedTile: m.claimedTile,
          from: m.from,
        })),
        doraIndicators: [...this.state.doraIndicators],
        uraDoraIndicators: hasUraIndicators
          ? [...this.state.uraDoraIndicators]
          : undefined,
      });
      return;
    }
    if (e.type === "hand_end") {
      const r = this.state.lastHandResult;
      // At exhaustive draw, reveal the concealed hand of each
      // tenpai seat so the post-hand panel can show what each
      // tenpai player was waiting on. Non-tenpai seats stay
      // null; other reasons skip this entirely (winners are
      // handled by per-seat `win` events).
      //
      // Kyuushuu kyuuhai is the one abort that also reveals a hand:
      // just the declaring seat's, so opponents and spectators see
      // the ≥9 terminals/honors that justified the abort. The engine
      // keeps `turn` pinned to the declarer through the abort.
      const tenpaiHands =
        e.reason === "exhaustive_draw" && r?.tenpai
          ? (r.tenpai.map((t, s) => (t ? [...this.state.hands[s]] : null)) as (
              | Tile[]
              | null
            )[])
          : e.reason === "abort" && e.abortKind === "kyuushuu"
            ? ([0, 1, 2, 3].map((s) =>
                s === this.state.turn ? [...this.state.hands[s]] : null
              ) as (Tile[] | null)[])
            : undefined;
      await this.emitEvent({
        type: "hand_end",
        reason: e.reason,
        ...(e.abortKind ? { abortKind: e.abortKind } : {}),
        delta: e.delta,
        ...(r?.tenpai ? { tenpai: r.tenpai } : {}),
        ...(r?.nagashi ? { nagashi: r.nagashi } : {}),
        scores: [...this.state.scores] as [number, number, number, number],
        honba: this.state.honba,
        riichiSticks: this.state.riichiSticks,
        ...(tenpaiHands ? { tenpaiHands } : {}),
        ...(e.chipDelta ? { chipDelta: e.chipDelta } : {}),
        ...(e.sinkingCount !== undefined
          ? { sinkingCount: e.sinkingCount }
          : {}),
        ...(e.dabukenConsumed !== undefined
          ? { dabukenConsumed: e.dabukenConsumed }
          : {}),
        ...(e.dabukenAwarded !== undefined
          ? { dabukenAwarded: e.dabukenAwarded }
          : {}),
        // Buu: ship the absolute chips/dabuken totals so the
        // client's player-nameplate chip counters + dabuken
        // tokens refresh immediately on hand_end (matching the
        // engine state) instead of waiting for the next
        // hand_start / match_start. Skipped for non-Buu rule sets.
        ...(this.state.ruleSet.buuMode
          ? {
              chips: [...this.state.chips] as [number, number, number, number],
              dabuken: [...this.state.dabuken] as [
                boolean,
                boolean,
                boolean,
                boolean,
              ],
            }
          : {}),
      });
      return;
    }
    if (e.type === "buu_chombo") {
      await this.emitEvent({
        type: "buu_chombo",
        seat: e.seat,
        reason: e.reason,
        chipDelta: e.chipDelta,
        chips: e.chips,
      });
      return;
    }
    if (e.type === "call") {
      await this.emitEvent({ type: "call", seat: e.seat, meld: e.meld });
      return;
    }
    if (e.type === "new_dora") {
      await this.emitEvent({ type: "new_dora", indicator: e.indicator });
      return;
    }
    if (e.type === "hand_start") {
      this.riichiTileIdx = [null, null, null, null];
      // Refill each seat's per-hand think buffer.
      this.bufferMs = [
        INITIAL_BUFFER_MS,
        INITIAL_BUFFER_MS,
        INITIAL_BUFFER_MS,
        INITIAL_BUFFER_MS,
      ];
      await this.emitEvent({
        type: "hand_start",
        round:
          (e.roundWind === "E"
            ? 0
            : e.roundWind === "S"
              ? 1
              : e.roundWind === "W"
                ? 2
                : 3) *
            4 +
          (e.roundNumber - 1),
        dealer: e.dealer,
        roundWind: e.roundWind,
        roundNumber: e.roundNumber,
        honba: e.honba,
        riichiSticks: this.state.riichiSticks,
        scores: [...this.state.scores] as [number, number, number, number],
        sinking: this.computeSinking(),
        ...(this.state.ruleSet.buuMode
          ? {
              chips: [...this.state.chips] as [number, number, number, number],
              dabuken: [...this.state.dabuken] as [
                boolean,
                boolean,
                boolean,
                boolean,
              ],
            }
          : {}),
        doraIndicators: [...e.doraIndicators],
        dice: this.rollDice(),
      });
      return;
    }
    if (e.type === "match_end") {
      // Defer wire emission to endMatch (so we don't double-emit).
      await this.endMatch(
        this.state.lastHandResult?.reason ?? "exhaustive_draw",
        {
          skipHandEnd: true,
          finalScores: e.finalScores,
          matchEndReason: e.reason,
        }
      );
      return;
    }
  }

  /**
   * Persist + ring-buffer + broadcast an event to all currently-connected
   * sockets (slice: just the one human socket). Each recipient gets a
   * projected copy.
   *
   * The event the rules engine produces is the **wire-clean** form
   * — it never carries omniscient fields like `startingHands`. The
   * archival enrichment happens here, in one place: we snapshot any
   * server-side state we want preserved in the replay log (today,
   * per-seat starting hands at `hand_start`) onto a separate copy
   * that's pushed to `eventLog` and published to the event stream.
   * The wire copy stays bare, so a future send path can't leak the
   * omniscient view by mistake.
   */
  private async emitEvent(event: GameEvent): Promise<void> {
    const omniSeq = this.nextSeq++;
    const archived = this.enrichForArchive(event);
    this.eventLog.push({
      seq: omniSeq,
      event: archived,
      emittedAt: this.runtime.now(),
    });
    // Live broadcast — per recipient. Each seat's per-seat seq is
    // assigned inside `sendToSeat`, only when the projection emits
    // a non-null frame. We iterate every human seat so multi-
    // human matches fan out correctly; bots don't have sockets.
    for (const seat of this.humanSeats()) {
      this.sendToSeat(seat, event);
    }
    // In-process spectator fan-out. Project once via the
    // public-projection helper (recipient: "spectator") and
    // assign the spectator seq line only when the projection is
    // non-null. All attached spectators share the same wire
    // stream / numbering because the projection is pure.
    // Pass the **archived** event so the projection can forward
    // omniscient fields (e.g. `startingHands` on `hand_start`)
    // — spectators are omniscient in this product.
    this.sendToSpectators(archived);
    // Notify delayed spectator sessions so they can (re-)schedule
    // their dispatch timer for this freshly appended event. No-op
    // when there are no delayed sessions.
    this.notifyDelayedSpectators();
    // Durability lives entirely in the in-process `eventLog` until
    // `match_end`, at which point `archiveCurrentGame` writes the
    // full archived form to Mongo via `archiveMatch`. Resync (live
    // and spectator) reads from the same `eventLog`. No per-event
    // database writes in this path — see `persist.ts` for the
    // durability story.
  }

  /**
   * Append an event from an external relay (e.g. Tenhou live spectating) and
   * fan it out to spectators. Bypasses the rules engine, per-seat projection,
   * timers, and bots. Events are expected to be pre-enriched (omniscient
   * `hand_start`), so no `enrichForArchive` pass runs. No-op unless this is a
   * relay match still in `playing` status.
   */
  injectRelayEvent(event: GameEvent): void {
    if (!this.relayMode || this.statusValue !== "playing") {
      return;
    }
    this.eventLog.push({
      seq: this.nextSeq++,
      event,
      emittedAt: this.runtime.now(),
    });
    if (event.type === "match_start") {
      this.relaySeats = event.seats.map((s) => ({
        seat: s.seat,
        displayName: s.displayName,
      }));
      for (const s of event.seats) {
        this.players.set(s.seat, {
          userId: s.userId,
          displayName: s.displayName,
          isBot: false,
        });
      }
    } else if (event.type === "match_end") {
      this.relayFinalScores = event.finalScores.map((f) => ({
        seat: f.seat,
        score: f.score,
        place: f.place as 1 | 2 | 3 | 4,
      }));
    }
    this.sendToSpectators(event);
    this.notifyDelayedSpectators();
  }

  /**
   * Finalize a relay match: mark it `finished` and archive the collected event
   * log as a cross-platform `ReplayLog` (best-effort; non-fatal on failure).
   */
  async closeRelay(): Promise<void> {
    if (!this.relayMode || this.statusValue !== "playing") {
      return;
    }
    this.statusValue = "finished";
    const seats = ([0, 1, 2, 3] as Seat[]).map((seat) => {
      const fs = this.relayFinalScores?.find((f) => f.seat === seat);
      return {
        seat,
        displayName:
          this.relaySeats?.find((r) => r.seat === seat)?.displayName ||
          this.players.get(seat)?.displayName ||
          `Seat ${seat}`,
        finalScore: fs?.score ?? 0,
        place: fs?.place ?? ((seat + 1) as 1 | 2 | 3 | 4),
      };
    });
    try {
      await this.repository.archiveReplayLog({
        matchId: this.matchId,
        source: "tenhou",
        sourceGameId: this.relaySourceGameId ?? this.matchId,
        startedAt: this.startedAt ?? new Date(this.runtime.now()),
        endedAt: new Date(this.runtime.now()),
        ruleSet: this.relayRuleSet,
        events: this.eventLog.map((e) => e.event),
        seats,
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(
        "[game-server] relay archiveReplayLog failed (non-fatal)",
        err
      );
    }
  }

  /**
   * Send a single event to one seat's live socket using that seat's
   * per-seat seq line. The projection layer may drop the event for
   * this recipient (private to another seat), in which case the
   * recipient's seq counter does NOT advance — keeping their wire
   * stream strictly contiguous from their own perspective.
   *
   * No-op when the seat has no attached socket (bot seat, or a
   * human who hasn't connected / has disconnected).
   */
  private sendToSeat(seat: Seat, event: GameEvent): void {
    const send = this.humanSockets[seat];
    if (!send) {
      return;
    }
    const projected = this.projectForSeat(event, seat);
    if (projected === null) {
      return;
    }
    const seq = this.seatSeq[seat]++;
    const legals = this.legalActions[seat];
    const deadline = this.currentDeadline[seat];
    send({
      type: "event",
      seq,
      events: [projected],
      legalActions: legals,
      ...(deadline !== null ? { deadline } : {}),
      bufferMs: this.bufferMs[seat],
    });
  }

  /**
   * Fan out one event to every attached spectator using the
   * shared `spectatorSeq` line. The projection layer may drop the
   * event for spectators (private events such as `furiten`), in
   * which case `spectatorSeq` does NOT advance — keeping the
   * spectator wire stream strictly contiguous in spectator-seq
   * space. No-op when there are no spectators.
   *
   * Spectators have no `legalActions` and no `deadline`; the
   * frame they receive is purely informational.
   */
  private sendToSpectators(event: GameEvent): void {
    const projected = projectPublicEvent(event);
    if (projected === null) {
      return;
    }
    // Advance the spectator seq line whether or not anyone is
    // attached — the projected stream is the canonical public
    // wire history, so a late-joining spectator's snapshot must
    // already point at the most-recent seq.
    const seq = this.spectatorSeq++;
    if (this.spectatorSockets.size === 0) {
      return;
    }
    for (const send of this.spectatorSockets) {
      send({
        type: "event",
        seq,
        events: [projected],
        legalActions: [],
      });
    }
  }

  /**
   * Attach server-side state needed by replay archival to a
   * wire-clean event. Today this means snapshotting per-seat
   * starting hands at `hand_start`; the wire event itself never
   * carries this field, eliminating the risk of leaking opponent
   * hands through a future send path. The result is what gets
   * pushed to `eventLog`; consumers that forward it to live
   * recipients (`sendToSeat`, future spectator / resync paths)
   * MUST project it through the redaction layer at their boundary.
   */
  private enrichForArchive(event: GameEvent): GameEvent {
    if (event.type === "hand_start") {
      const liveWall = [...this.state.liveWall];
      // Cache for mid-hand spectator snapshots. `state.liveWall`
      // at hand_start time is the full 70-tile starting wall (no
      // draws have happened yet for this hand).
      this.handStartLiveWall = liveWall;
      return {
        ...event,
        startingHands: this.state.hands.map((h) => [...h]) as [
          Tile[],
          Tile[],
          Tile[],
          Tile[],
        ],
        // Omniscient live wall in draw order — 70 tiles remaining
        // after the initial 4×13 deal. Used by replay clients for
        // the `showWalls` overlay; the live wire copy never has
        // this field (the projection layer / `emitEvent` pair
        // only attaches it to the archived event).
        liveWall,
      };
    }
    if (event.type === "hand_end") {
      // Per-seat wait tiles at hand end. Computed against each
      // seat's concealed hand via the rules engine; mirrors the
      // same `waits()` predicate the engine uses for
      // tenpai-payment detection at exhaustive draw. Seats not
      // in tenpai get `null`. Used by replay clients for the
      // `showWaits` overlay so the renderer doesn't have to
      // recompute (and can stay consistent with whatever waits
      // the platform recorded).
      const seatWaits: (Tile[] | null)[] = this.state.hands.map((h) => {
        const w = waits(h);
        return w.length > 0 ? w : null;
      });
      return {
        ...event,
        waits: seatWaits as [
          Tile[] | null,
          Tile[] | null,
          Tile[] | null,
          Tile[] | null,
        ],
      };
    }
    return event;
  }
}
