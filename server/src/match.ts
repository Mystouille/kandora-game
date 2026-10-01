import { RecoveryCoordinator } from "./session/recoveryCoordinator";
import { MatchEventPublisher } from "./session/eventPublisher";
import { EngineEventPresenter } from "./session/engineEventPresenter";
import { ArchiveEventComposer } from "./session/archiveEventComposer";
import { CheckpointFactory } from "./recovery/checkpointFactory";
import { SnapshotComposer } from "./session/snapshotComposer";
/**
 * Public compatibility facade for an authoritative match.
 * Kernel, roster, connections, windows, bank and commands own their state.
 * Turn/call, lifecycle, publication and recovery extraction remains here.
 */
import type {
  DuplicateWallState,
  GameEvent,
  LegalAction,
  MatchDebug,
  RoomSeatOccupant,
  Seat,
  ServerMessage,
  ViewerPresence,
} from "~/game/protocol/messages";
import { estimateDuplicateExhaustion } from "~/game/duplicate/duplicateExhaustion";
import {
  MatchModeConfigSchema,
  normalMatchMode,
  type MatchModeConfig,
} from "~/game/protocol/matchMode";
import {
  SpectatorDelayMsSchema,
  type SpectatorDelayMs,
} from "~/game/protocol/spectatorDelay";
import {
  type CallOption,
  type DiscardSource,
  type EngineEvent,
  type FuritenChange,
  type MatchEndReason,
  type RuleSetOverride,
  type Tile,
} from "~/game/rules";
import {
  parseMatchCheckpoint,
  type MatchCheckpoint,
  type PlayingActionCheckpoint,
  type PlayingCallCheckpoint,
  type PlayingContinueVoteCheckpoint,
  type PlayingReadyCheckpoint,
  type PlayingResultTransitionCheckpoint,
  type WaitingRoomCheckpoint,
} from "./checkpoint";
import { projectPublicEvent } from "./projection";
import {
  type MatchRepository,
  type MatchEventJournalStore,
} from "./repository";
import {
  MatchEventJournal,
  type EventJournalErrorContext,
} from "./eventJournal";
import { type MatchRuntime, type MatchTimer } from "./runtime";
import { createSystemMatchRuntime } from "./runtime";
import { duplicateMatchSeed } from "./match-drivers/duplicatePlan";
import { TimeBank } from "./timing/timeBank";
import { DecisionTiming } from "./timing/decisionTiming";
import type { AuthorityClock } from "./timing/authorityClock";
import type { LatencyProfile } from "./transport/latencyProfile";
import type { InputReceipt, TimingMode } from "~/game/protocol/timing";
import {
  ActionWindowRegistry,
  DecisionWindowError,
  type ActionWindowKind,
} from "./timing/actionWindows";
import { CommandCoordinator } from "./session/commandCoordinator";
import { ReadyCheck } from "./session/readyCheck";
import { ResultTransition } from "./session/resultTransition";
import { ContinueVote } from "./session/continueVote";
import { HandLifecycle } from "./session/handLifecycle";
import { HandMetadata } from "./session/handMetadata";
import {
  SessionCoordinator,
  type SessionSnapshot,
} from "./session/sessionCoordinator";
import {
  CallCoordinator,
  type CallResolutionSnapshot,
} from "./session/callCoordinator";
import { CallResolution } from "./session/callResolution";
import { TurnCoordinator } from "./session/turnCoordinator";
import { ActionExecutor } from "./session/actionExecutor";
import { LegacyDecisions } from "./session/legacyDecisions";
import {
  TransitionBarrier,
  type TransitionKind,
} from "./session/transitionBarrier";
import { buildCallLegals } from "./session/callActions";
import {
  legacyTiming,
  remainingWinReactionDelayMs,
} from "./session/legacyPolicy";
import { waitingRoomSeatPermutation } from "./session/seating";
import { compactRyuukyokuDeclarationsForReplay } from "./session/replayEvents";
export {
  setNextHandDelayMs,
  setContinueVoteMs,
  setMatchEndDisplayMs,
  setDelayAfterDiscardMs,
  setExhaustiveDrawDelayMs,
  setRyuukyokuDeclarationTimingMs,
  setActionTimeoutMs,
  setActionTimingMs,
  setReadyCheckMs,
  remainingWinReactionDelayMs,
  winResultRevealDurationMs,
} from "./session/legacyPolicy";
export { waitingRoomSeatPermutation } from "./session/seating";
export { compactRyuukyokuDeclarationsForReplay } from "./session/replayEvents";
import { RoomRoster, type MatchPlayerInit } from "./session/roomRoster";
import {
  PlayerConnections,
  type Send,
  type HumanConnectionOptions,
  type HumanAttachResult,
} from "./session/playerConnections";
import {
  MatchKernel,
  type KernelAction,
  type MatchStateView,
} from "./session/matchKernel";

export type { MatchPlayerInit } from "./session/roomRoster";
export {
  HumanSessionTakeoverRequiredError,
  type HumanConnectionOptions,
  type HumanAttachResult,
} from "./session/playerConnections";

type FinalScore = {
  seat: Seat;
  score: number;
  place: 1 | 2 | 3 | 4;
};

export interface MatchProcessDependencies {
  repository: MatchRepository;
  eventJournalStore?: MatchEventJournalStore;
  onEventJournalError?: (context: EventJournalErrorContext) => void;
  onAutomaticAction?: (context: AutomaticActionContext) => void;
  runtime?: MatchRuntime;
  authorityClock?: AuthorityClock;
  timingMode?: TimingMode;
}

export interface AutomaticActionContext {
  matchId: string;
  gameId: string;
  seat: Seat;
  actionId: string;
  reason: "deadline" | "disconnected" | "afk";
  nextSeq: number;
  bufferMs: number;
  actionWindowElapsedMs: number | null;
}

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

export class MatchProcess {
  private readonly recovery: RecoveryCoordinator;

  private readonly publisher: MatchEventPublisher;

  private readonly archiveEvents: ArchiveEventComposer;

  private readonly engineEvents: EngineEventPresenter;

  private readonly checkpoints: CheckpointFactory;

  private readonly snapshots: SnapshotComposer;

  private readonly ready: ReadyCheck;
  private readonly results: ResultTransition;
  private readonly votes: ContinueVote;
  private readonly hand: HandLifecycle;
  private readonly metadata: HandMetadata;
  private readonly session: SessionCoordinator;
  sessionSnapshot(): SessionSnapshot {
    return this.session.snapshot();
  }

  private readonly calls: CallCoordinator;
  private readonly callResolution: CallResolution;
  private readonly turns: TurnCoordinator;
  private readonly actions: ActionExecutor;
  private readonly decisions: LegacyDecisions;
  private readonly barrier: TransitionBarrier;
  callResolutionSnapshot(): CallResolutionSnapshot {
    return this.calls.snapshot();
  }

  readonly matchId: string;
  readonly seed: number;
  private readonly roster: RoomRoster;
  private readonly connections: PlayerConnections;

  private get players(): ReadonlyMap<Seat, Readonly<MatchPlayerInit> | null> {
    return this.roster.players();
  }
  get status(): "waiting" | "playing" | "finished" {
    return this.session.snapshot().status;
  }

  /** True for a relay/virtual match fed by an external decoder (e.g. Tenhou
   * live spectating) rather than the local rules engine. */
  private relayMode = false;
  get isRelay(): boolean {
    return this.relayMode;
  }
  get spectatorDelayMs(): SpectatorDelayMs {
    return this.relayMode
      ? legacyTiming.TENHOU_RELAY_VIEWER_DELAY_MS
      : this.minimumSpectatorDelayMs;
  }
  spectatorDispatchDelayMs(requestedDelayMs: number): number {
    return this.relayMode
      ? 0
      : Math.max(this.minimumSpectatorDelayMs, requestedDelayMs);
  }
  /** Relay archive metadata, set by `createRelayMatch` / `injectRelayEvent`. */
  private relaySourceGameId: string | null = null;
  private relaySourceGameIdAliases: string[] = [];
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
    mode: MatchModeConfig;
    spectatorDelayMs: SpectatorDelayMs;
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
      this.session.snapshot().status === "waiting"
        ? (this.ruleSetOverride?.buuMode ?? false)
        : (this.state?.ruleSet.buuMode ?? false);
    return {
      matchId: this.matchId,
      status: this.session.snapshot().status,
      presetId: this.relayMode ? this.relayRuleSet : this.presetId,
      mode: this.kernel.mode,
      spectatorDelayMs: this.spectatorDelayMs,
      buuMode,
      seats,
    };
  }

  // Engine state — created in `start()`, advanced only by `step()`
  // (apart from the narrow debug-seed overrides documented at each
  // callsite below).
  private readonly kernel: MatchKernel;

  private get state(): MatchStateView {
    return this.kernel.view;
  }

  private readonly timeBank: TimeBank;
  private readonly actionWindows: ActionWindowRegistry;
  private readonly timing: DecisionTiming;
  get timingMode(): TimingMode {
    return this.timing.timingMode;
  }

  authorityNow(): number {
    return this.runtime.now();
  }

  actionReceipt(seat: Seat, receivedAt: number): InputReceipt {
    const window = this.actionWindows.timedView(seat);
    return {
      receivedAt,
      ...(window ? { windowId: window.id, clockEpoch: window.clockEpoch } : {}),
    };
  }

  reserveAction(seat: Seat, actionId: string, receipt: InputReceipt): void {
    if (
      this.timingMode !== "legacy" &&
      (this.isPaused || this.checkpointSavePromise !== null)
    ) {
      throw new DecisionWindowError("The decision is paused for recovery.");
    }
    this.timing.reserve(seat, actionId, receipt);
  }

  configurePlayerTiming(
    seat: Seat,
    network: "direct" | "remote",
    profile: () => LatencyProfile | null
  ): void {
    this.timing.connection(seat, network, profile);
  }
  /**
   * Omniscient seq counter. Drives the in-memory `eventLog` and
   * the Mongo archive — i.e. every consumer that sees the
   * unredacted form (replay viewer, archival writes, future
   * omniscient spectator paths).
   */
  private get nextSeq(): number {
    return this.publisher.nextSequence;
  }
  private set nextSeq(value: number) {
    this.publisher.restoreNextSequence(value);
  }
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
  private get seatSeq(): [number, number, number, number] {
    return this.publisher.seatSequences();
  }
  private set seatSeq(value: [number, number, number, number]) {
    this.publisher.restoreSeatSequences(value);
  }

  /**
   * Type of the most recently emitted engine event. Used to
   * detect the `win` → `buu_chombo` sequence emitted by the
   * engine on a Buu illegal-victory chombo, so the server can
   * pause between the win-info panel and the chombo panel for
   * the same duration as the post-hand ready check.
   */

  private get lastEngineEventType(): EngineEvent["type"] | null {
    return this.engineEvents.lastType;
  }
  private set lastEngineEventType(type: EngineEvent["type"] | null) {
    this.engineEvents.restoreLastType(type);
  }

  private rollDice(): [number, number] {
    return this.metadata.rollDice();
  }

  /**
   * In-memory event log retained for the lifetime of the match.
   * Doubles as (a) the source for in-process resync replay, (b) the payload
   * source for best-effort journal batches, and (c) the complete final archive.
   * The journal queue stores only cursors, so this array remains the sole
   * in-memory owner of events that have not reached storage yet.
   */
  private get eventLog(): readonly import("./repository").PersistedMatchEvent[] {
    return this.publisher.history();
  }
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
  private get spectatorSeq(): number {
    return this.publisher.spectatorSequence;
  }
  private set spectatorSeq(value: number) {
    this.publisher.restoreSpectatorSequence(value);
  }

  /**
   * Snapshot of the live wall at the most recent `hand_start`, in
   * draw order (70 tiles). Captured by `enrichForArchive` when
   * the `hand_start` event is enriched and exposed verbatim to
   * mid-hand spectator snapshots so the wall-reveal overlay can
   * render the full starting wall (the renderer hides positions
   * that have already been drawn via `liveDrawsTaken`). `null`
   * before the first `hand_start` of the match.
   */

  private get handStartLiveWall(): Tile[] | null {
    return this.archiveEvents.wall();
  }
  private set handStartLiveWall(wall: Tile[] | null) {
    this.archiveEvents.restoreWall(wall);
  }

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

  /**
   * Optional rule-set override applied to every game in this
   * session. Threaded through to `createInitialState` for both
   * the initial game and every subsequent game in a Buu multi-
   * game session. `undefined` keeps the engine default
   * (tenhou-hanchan).
   */
  private readonly ruleSetOverride?: RuleSetOverride;
  private readonly presetId: string;
  private readonly minimumSpectatorDelayMs: SpectatorDelayMs;

  get hasPendingFinalization(): boolean {
    return this.session.hasPendingFinalization;
  }
  private readonly runtime: MatchRuntime;
  private readonly repository: MatchRepository;
  private readonly eventJournalStore: MatchEventJournalStore | null;
  private readonly onEventJournalError:
    ((context: EventJournalErrorContext) => void) | undefined;
  private readonly onAutomaticAction:
    ((context: AutomaticActionContext) => void) | undefined;
  private get eventJournal(): MatchEventJournal | null {
    return this.publisher.journal;
  }
  private get pausedCheckpoint(): MatchCheckpoint | null {
    return this.recovery.paused;
  }
  private get checkpointSavePromise(): Promise<MatchCheckpoint> | null {
    return this.recovery.saving;
  }
  private readonly commands: CommandCoordinator;

  get isPaused(): boolean {
    return this.pausedCheckpoint !== null || this.commands.recoveryRequired;
  }

  get pendingCommandRecoveryError(): Error | null {
    return this.commands.recoveryError;
  }

  async waitUntilConnectionReady(): Promise<boolean> {
    return this.commands.waitUntilConnectionReady();
  }

  private assertNotPaused(operation: string): void {
    if (this.isPaused || this.checkpointSavePromise !== null) {
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
    presetId = "tenhou-hanchan",
    mode: MatchModeConfig = normalMatchMode,
    spectatorDelayMs: SpectatorDelayMs = 0
  ) {
    if (players.length !== 4) {
      throw new Error("MatchProcess requires exactly 4 players");
    }
    this.matchId = matchId;
    this.seed = seed;
    this.roster = new RoomRoster(matchId, players, {
      status: () => this.session.snapshot().status,
      assertNotPaused: (operation) => this.assertNotPaused(operation),
      hasSender: (seat) => this.connections.sender(seat) !== null,
      send: (seat, message) => this.connections.sender(seat)?.(message),
      clearConnection: (seat) => this.connections.clearSeat(seat),
      permuteConnections: (permutation) =>
        this.connections.permute(permutation),
      onPlayingHumanClaimed: (seat) => {
        this.ready.unackHuman(seat);
      },
      broadcastRoom: () => this.broadcastRoomState(),
      broadcastViewers: () => this.broadcastViewerState(),
      start: () => this.start(),
    });
    this.connections = new PlayerConnections(
      (seat) => this.roster.player(seat),
      () => this.broadcastRoomState()
    );
    const parsedMode = MatchModeConfigSchema.parse(mode);
    if (parsedMode.type === "duplicate" && debug !== undefined) {
      throw new Error(
        "MatchProcess: debug overrides are unavailable in duplicate mode"
      );
    }
    if (
      parsedMode.type === "duplicate" &&
      seed !== duplicateMatchSeed(parsedMode)
    ) {
      throw new Error(
        "MatchProcess: duplicate seed does not match public mode seed"
      );
    }
    this.debug = debug;
    this.ruleSetOverride = ruleSetOverride;
    this.presetId = presetId;
    this.minimumSpectatorDelayMs =
      SpectatorDelayMsSchema.parse(spectatorDelayMs);
    this.runtime =
      dependencies.runtime ??
      createSystemMatchRuntime(seed, dependencies.authorityClock);
    this.kernel = new MatchKernel(parsedMode, presetId, this.runtime);
    this.repository = dependencies.repository;
    this.eventJournalStore = dependencies.eventJournalStore ?? null;
    this.onEventJournalError = dependencies.onEventJournalError;
    this.onAutomaticAction = dependencies.onAutomaticAction;
    this.timeBank = new TimeBank(legacyTiming.INITIAL_BUFFER_MS);
    this.actionWindows = new ActionWindowRegistry(
      this.runtime,
      (seat) => {
        void this.handleDeadlineExpiry(seat);
      },
      () => this.isPaused
    );
    this.timing = new DecisionTiming(
      this.runtime.clockEpoch ?? `match-${this.matchId}`,
      this.matchId,
      this.runtime,
      this.actionWindows,
      this.timeBank,
      dependencies.timingMode ?? "legacy"
    );
    this.commands = new CommandCoordinator(this.actionWindows, {
      sequence: () => this.nextSeq,
      status: () => this.session.snapshot().status,
      isPaused: () => this.isPaused,
      pendingCheckpointSave: () => this.checkpointSavePromise,
      afkDefaultAction: (seat) => this.pickImmediateAfkDefaultActionId(seat),
      persistRecovery: () => this.persistLegacyCommandRecovery(),
      accept: (command) => {
        if (command.type === "act") {
          return this.isAcceptedAction(command.seat, command.actionId);
        }
        if (command.type === "ready") {
          return this.isAcceptedReady(command.seat);
        }
        if (command.type === "afk") {
          return this.isAcceptedAfk(
            command.seat,
            command.afk,
            command.defaultActionId
          );
        }
        return this.isAcceptedContinueVote(command.seat, command.vote);
      },
      execute: async (command) => {
        if (command.type === "act") {
          await this.handleActDirect(command.seat, command.actionId);
        } else if (command.type === "ready") {
          this.handleReadyDirect(command.seat);
        } else if (command.type === "afk") {
          await this.handleAfkDirect(
            command.seat,
            command.afk,
            command.defaultActionId
          );
        } else {
          await this.handleVoteContinueDirect(command.seat, command.vote);
        }
      },
    });
    this.barrier = new TransitionBarrier(this.runtime);
    const kernelEffects = {
      applyEngineAction: (action: KernelAction) =>
        this.applyEngineAction(action),
      applyDiscard: (seat: Seat, tile: Tile, source?: DiscardSource) =>
        this.applyDiscard(seat, tile, source),
    };
    const decisionEffects = {
      isHumanSeat: (seat: Seat) => this.roster.isHumanSeat(seat),
      setSeatLegals: (
        seat: Seat,
        actions: LegalAction[],
        kind?: ActionWindowKind
      ) => this.setSeatLegals(seat, actions, kind),
      flushLegalsToSeat: (seat: Seat) => this.flushLegalsToSeat(seat),
    };
    const callEffects = {
      ...decisionEffects,
      applyEngineAction: kernelEffects.applyEngineAction,
      waitForWinReaction: (trigger: "draw" | "discard" | "call") =>
        this.waitForWinReaction(trigger),
      advanceTurn: () => this.advanceTurn(),
      afterHandEnd: () => this.afterHandEnd(),
      afterCall: () => this.afterCall(),
    };
    this.calls = new CallCoordinator(this.kernel, callEffects);
    this.callResolution = new CallResolution(this.kernel, callEffects);
    this.turns = new TurnCoordinator(this.kernel, this.actionWindows, {
      ...kernelEffects,
      ...decisionEffects,
      emitEngineEvent: (event) => this.emitEngineEvent(event),
      emitFuritenChanges: (changes) => this.emitFuritenChanges(changes),
      afterDiscard: () => this.afterDiscard(),
      openChankanWindow: () => this.openChankanWindow(),
      afterHandEnd: () => this.afterHandEnd(),
      runUncheckpointableTransition: (kind, delay) =>
        this.runUncheckpointableTransition(kind, delay),
    });
    this.actions = new ActionExecutor(
      this.kernel,
      this.roster,
      this.connections,
      this.actionWindows,
      {
        ...kernelEffects,
        ...decisionEffects,
        isPaused: () => this.isPaused,
        isCallOpen: (seat) => this.calls.isOpen(seat),
        status: () => this.session.snapshot().status,
        consumeActionBuffer: (seat) => this.consumeActionBuffer(seat),
        resolveCallWindow: (seat, action) =>
          this.resolveCallWindow(seat, action),
        continueRyuukyokuDeclarations: () =>
          this.continueRyuukyokuDeclarations(),
        afterDiscard: () => this.afterDiscard(),
        afterCall: () => this.afterCall(),
        openChankanWindow: () => this.openChankanWindow(),
        afterHandEnd: () => this.afterHandEnd(),
        waitForWinReaction: (trigger) => this.waitForWinReaction(trigger),
        pickImmediateAfkDefaultActionId: (seat) =>
          this.pickImmediateAfkDefaultActionId(seat),
        reportAutomaticAction: (seat, action, reason) =>
          this.reportAutomaticAction(seat, action, reason),
        broadcastRoomState: () => this.broadcastRoomState(),
      }
    );
    this.decisions = new LegacyDecisions(
      this.matchId,
      this.runtime,
      this.actionWindows,
      this.timeBank,
      this.connections,
      this.commands,
      {
        state: () => this.kernel.currentState(),
        isPaused: () => this.isPaused,
        isHumanSeat: decisionEffects.isHumanSeat,
        isCallOpen: (seat) => this.calls.isOpen(seat),
        currentGameMongoId: () => this.currentGameMongoId(),
        nextSequence: () => this.nextSeq,
        handleActDirect: (seat, action) => this.handleActDirect(seat, action),
        runUncheckpointableTransition: (kind, delay) =>
          this.runUncheckpointableTransition(kind, delay),
        onAutomaticAction: this.onAutomaticAction,
      }
    );
    this.metadata = new HandMetadata(this.runtime);
    this.ready = new ReadyCheck(this.runtime, this.roster, this.commands, {
      isPaused: () => this.isPaused,
      humanSeats: () => this.humanSeats(),
      sender: (seat) => this.connections.sender(seat),
      resumeReadyContinuation: (kind) => this.resumeReadyContinuation(kind),
    });
    this.results = new ResultTransition(this.runtime, this.commands, {
      isPaused: () => this.isPaused,
      resumeResultTransition: (kind, nextReadyMs) =>
        this.resumeResultTransition(kind, nextReadyMs),
    });
    this.votes = new ContinueVote(
      this.runtime,
      this.roster,
      this.connections,
      this.commands,
      {
        isPaused: () => this.isPaused,
        emitEvent: (event) => this.emitEvent(event),
        gameIndex: () => this.session.snapshot().gameIndex,
        gameFinalized: () => this.session.markGameFinalized(),
        continueAfterVote: (cont, scores) =>
          this.continueAfterVote(cont, scores),
      }
    );
    this.hand = new HandLifecycle(this.kernel, {
      emitEvent: (event) => this.emitEvent(event),
      emitEngineEvent: (event) => this.emitEngineEvent(event),
      emitFuritenChanges: (changes) => this.emitFuritenChanges(changes),
      advanceTurn: () => this.advanceTurn(),
      endMatch: (reason, options) => this.endMatch(reason, options),
      gameIndex: () => this.session.snapshot().gameIndex,
      gameFinalized: () => this.session.snapshot().finalized,
      resetCallState: () => this.calls.resetHand(),
      clearLegals: (seat) => this.setSeatLegals(seat, []),
      runReadyCheck: (ms, kind) => this.runReadyCheck(ms, kind),
      runResultTransition: (kind, delay, nextReadyMs) =>
        this.runResultTransition(kind, delay, nextReadyMs),
      computeSinking: () => this.computeSinking(),
      rollDice: () => this.rollDice(),
      duplicateWallEventFields: () => this.duplicateWallEventFields(),
    });
    this.session = new SessionCoordinator(
      {
        matchId: this.matchId,
        seed: this.seed,
        debug: this.debug,
        ruleSetOverride: this.ruleSetOverride,
        presetId: this.presetId,
        mode: this.kernel.mode,
        spectatorDelayMs: this.minimumSpectatorDelayMs,
      },
      this.runtime,
      this.repository,
      this.kernel,
      this.roster,
      {
        assertNotPaused: (operation) => this.assertNotPaused(operation),
        isPaused: () => this.isPaused,
        emitEvent: (event) => this.emitEvent(event),
        eventCount: () => this.eventLog.length,
        openEventJournal: (gameId, seq) => this.openEventJournal(gameId, seq),
        broadcastRoomState: () => this.broadcastRoomState(),
        archiveCurrentGame: (scores) => this.archiveCurrentGame(scores),
        runReadyCheck: (ms, kind) => this.runReadyCheck(ms, kind),
        beginInitialHandAfterReady: () => this.beginInitialHandAfterReady(),
        runContinueVote: (scores) => this.runContinueVote(scores),
        lastVoteReason: () => this.votes.snapshot().lastVoteReason,
        runUncheckpointableTransition: (kind, delay) =>
          this.runUncheckpointableTransition(kind, delay),
        resetCallState: () => this.calls.resetHand(),
        resetRiichiTiles: () => this.metadata.resetRiichiTiles(),
        refillBank: () => this.timeBank.refill(legacyTiming.INITIAL_BUFFER_MS),
        clearLegals: (seat) => this.setSeatLegals(seat, []),
        cancelReadyTimer: () => this.ready.cancelTimer(),
        cancelActionTimers: () => this.actionWindows.cancelAllTimers(),
        hasContinueVote: () => this.votes.snapshot().active,
        finishContinueVote: (cont) => this.finishContinueVote(cont),
      }
    );

    this.engineEvents = new EngineEventPresenter({
      state: () => this.state,
      metadata: this.metadata,
      hand: this.hand,
      bank: this.timeBank,
      emitEvent: (event) => this.emitEvent(event),
      waitForEventAge: (trigger, age, transition) =>
        this.waitForEventAge(trigger, age, transition),
      runReadyCheck: (ms) => this.runReadyCheck(ms),
      runUncheckpointableTransition: (kind, delay) =>
        this.runUncheckpointableTransition(kind, delay),
      duplicateWallEventFields: () => this.duplicateWallEventFields(),
      computeSinking: () => this.computeSinking(),
      rollDice: () => this.rollDice(),
      endMatch: (reason, options) => this.endMatch(reason, options),
    });

    this.archiveEvents = new ArchiveEventComposer({
      state: () => this.state,
      kernel: this.kernel,
    });

    this.publisher = new MatchEventPublisher({
      runtime: this.runtime,
      timing: this.timing,
      eventJournalStore: this.eventJournalStore,
      onEventJournalError: this.onEventJournalError,
      enrichForArchive: (event) => this.enrichForArchive(event),
      humanSeats: () => this.humanSeats(),
      sendToSeat: (seat, event) => this.sendToSeat(seat, event),
      sendToSpectators: (event) => this.sendToSpectators(event),
      notifyDelayedSpectators: () => this.notifyDelayedSpectators(),
    });

    this.recovery = new RecoveryCoordinator({
      matchId: this.matchId,
      commands: this.commands,
      repository: this.repository,
      capture: () => this.createCheckpoint(),
      cancelTimers: (checkpoint) => this.cancelCheckpointTimers(checkpoint),
      resume: (checkpoint) => this.resumeCheckpoint(checkpoint),
      flushJournal: () => this.eventJournal?.flush() ?? null,
    });
    this.snapshots = new SnapshotComposer({
      state: () => this.state,
      history: () => this.eventLog,
      players: () => this.players,
      seatSequences: () => this.seatSeq,
      spectatorSequence: () => this.spectatorSeq,
      handStartWall: () => this.handStartLiveWall,
      duplicateWallEventFields: () => this.duplicateWallEventFields(),
      computeSinking: () => this.computeSinking(),
      kernel: this.kernel,
      metadata: this.metadata,
      windows: this.actionWindows,
      bank: this.timeBank,
      timing: this.timing,
    });

    this.checkpoints = new CheckpointFactory({
      config: {
        matchId: this.matchId,
        seed: this.seed,
        debug: this.debug,
        ruleSetOverride: this.ruleSetOverride,
        presetId: this.presetId,
        mode: this.kernel.mode,
        spectatorDelayMs: this.minimumSpectatorDelayMs,
      },
      kernel: this.kernel,
      roster: this.roster,
      connections: this.connections,
      session: this.session,
      calls: this.calls,
      ready: this.ready,
      votes: this.votes,
      results: this.results,
      hand: this.hand,
      metadata: this.metadata,
      windows: this.actionWindows,
      bank: this.timeBank,
      timing: this.timing,
      runtime: this.runtime,
      isRelay: () => this.relayMode,
      delayedSpectators: () => this.delayedSpectators,
      history: () => this.eventLog,
      nextSequence: () => this.nextSeq,
      seatSequences: () => this.seatSeq,
      spectatorSequence: () => this.spectatorSeq,
      handStartWall: () => this.handStartLiveWall,
      lastEngineType: () => this.lastEngineEventType,
    });
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
    presetId = "tenhou-hanchan",
    mode: MatchModeConfig = normalMatchMode,
    spectatorDelayMs: SpectatorDelayMs = 0
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
      presetId,
      mode,
      spectatorDelayMs
    );
    for (let s = 0; s < 4; s++) {
      m.roster.replaceSeat(s as Seat, null);
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
    sourceGameId: string | null,
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
    m.session.startRelay();
    m.relaySourceGameId = sourceGameId;
    m.relayRuleSet = ruleSet;
    return m;
  }

  setRelayReplayIdentity(
    sourceGameId: string,
    sourceGameIdAliases: string[] = []
  ): void {
    if (!this.relayMode || this.session.snapshot().status !== "playing") {
      return;
    }
    this.relaySourceGameId = sourceGameId;
    this.relaySourceGameIdAliases = [...new Set(sourceGameIdAliases)];
  }

  /** Serialize durable state at a supported quiescent boundary. */
  createCheckpoint(): MatchCheckpoint {
    if (this.pausedCheckpoint !== null) {
      return parseMatchCheckpoint(
        JSON.parse(JSON.stringify(this.pausedCheckpoint))
      );
    }
    if (this.commands.recoveryRequired) {
      throw new Error(
        "MatchProcess.createCheckpoint: pending command must be recovered from durable pre-state"
      );
    }
    if (this.session.snapshot().status === "waiting") {
      return this.createWaitingRoomCheckpoint();
    }
    if (this.session.snapshot().status === "playing") {
      if (this.commands.automaticInFlight) {
        this.checkpointUnsupported("automatic default action is in flight");
      }
      if (this.barrier.kind !== null) {
        this.checkpointUnsupported(`transition ${this.barrier.kind}`);
      }
      if (this.results.snapshot().active) {
        return this.createPlayingResultTransitionCheckpoint();
      }
      if (this.votes.snapshot().active) {
        return this.createPlayingContinueVoteCheckpoint();
      }
      if (this.ready.snapshot().active) {
        return this.createPlayingReadyCheckpoint();
      }
      if (this.calls.snapshot().callWindows.some((window) => window !== null)) {
        return this.createPlayingCallCheckpoint();
      }
      return this.createPlayingActionCheckpoint();
    }
    throw new Error(
      `MatchProcess.createCheckpoint: status "${this.session.snapshot().status}" is not supported`
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
    return this.recovery.pause();
  }

  private freezeCheckpoint(checkpoint: MatchCheckpoint): void {
    this.recovery.freeze(checkpoint);
  }

  private cancelCheckpointTimers(checkpoint: MatchCheckpoint): void {
    if (checkpoint.status !== "playing") {
      return;
    }
    if (checkpoint.checkpointKind === "result_transition") {
      this.results.cancelTimer();
    } else if (checkpoint.checkpointKind === "continue_vote") {
      this.votes.cancelTimer();
    } else if (checkpoint.checkpointKind === "ready_check") {
      this.ready.cancelTimer();
    } else {
      const seats =
        checkpoint.checkpointKind === "action_window"
          ? [checkpoint.actionWindow.seat]
          : checkpoint.callWindows.flatMap((window, seat) =>
              window === null ? [] : [seat as Seat]
            );
      for (const seat of seats) {
        this.actionWindows.cancelTimer(seat);
      }
    }
  }

  private resumeCheckpoint(
    checkpoint: MatchCheckpoint,
    restoredContinuation = false
  ): void {
    this.recovery.clearPause();
    if (checkpoint.status === "playing") {
      if (checkpoint.checkpointKind === "action_window") {
        this.installCheckpointActionWindow(checkpoint);
      } else if (checkpoint.checkpointKind === "call_window") {
        this.installCheckpointCallWindows(checkpoint);
      } else if (checkpoint.checkpointKind === "ready_check") {
        this.installCheckpointReadyCheck(checkpoint, restoredContinuation);
      } else if (checkpoint.checkpointKind === "continue_vote") {
        this.installCheckpointContinueVote(checkpoint, restoredContinuation);
      } else {
        this.installCheckpointResultTransition(
          checkpoint,
          restoredContinuation
        );
      }
      if (checkpoint.decisionTiming) {
        this.timing.restore(checkpoint.decisionTiming, checkpoint.savedAt);
      }
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
    await match.restoreEventJournal();
    if (recovery.pendingCommand !== null) {
      await match.commands.restorePendingCommand(recovery.pendingCommand);
    }
    return match;
  }

  private openEventJournal(matchId: string, initialNextSeq: number): void {
    return this.publisher.openEventJournal(matchId, initialNextSeq);
  }

  private async restoreEventJournal(): Promise<void> {
    if (
      this.eventJournalStore === null ||
      this.session.snapshot().status !== "playing"
    ) {
      return;
    }
    const matchId = this.currentGameMongoId();
    const stored =
      await this.eventJournalStore.loadMatchEventJournalState(matchId);
    if (stored === null || stored.status !== "playing") {
      return;
    }
    if (
      stored.nextSeq < this.session.snapshot().gameStartLogIdx ||
      stored.nextSeq > this.nextSeq
    ) {
      throw new Error(
        `MatchProcess.restoreEventJournal: invalid durable seq ${stored.nextSeq}`
      );
    }
    this.openEventJournal(matchId, stored.nextSeq);
    for (let seq = stored.nextSeq; seq < this.nextSeq; seq += 1) {
      this.eventJournal?.record(seq);
    }
  }

  private async supersedeEventJournal(): Promise<void> {
    return this.publisher.supersedeEventJournal();
  }

  async flushEventJournal(): Promise<void> {
    return this.publisher.flushEventJournal();
  }

  async deleteSavedCheckpoint(): Promise<void> {
    await this.repository.deleteCheckpoint(this.matchId);
  }

  private checkpointPlayers(
    requireFull: true
  ): PlayingActionCheckpoint["seats"];
  private checkpointPlayers(requireFull: false): WaitingRoomCheckpoint["seats"];
  private checkpointPlayers(
    requireFull: boolean
  ): PlayingActionCheckpoint["seats"] | WaitingRoomCheckpoint["seats"] {
    return requireFull
      ? this.checkpoints.checkpointPlayers(true)
      : this.checkpoints.checkpointPlayers(false);
  }

  private createWaitingRoomCheckpoint(): WaitingRoomCheckpoint {
    return this.checkpoints.createWaitingRoomCheckpoint();
  }

  private checkpointUnsupported(reason: string): never {
    return this.checkpoints.checkpointUnsupported(reason);
  }

  private async runUncheckpointableTransition(
    transition: TransitionKind,
    delayMs: number
  ): Promise<void> {
    await this.barrier.run(transition, delayMs);
  }

  private assertCommonPlayingCheckpointState(
    allowReady = false,
    allowVote = false
  ): void {
    return this.checkpoints.assertCommonPlayingCheckpointState(
      allowReady,
      allowVote
    );
  }

  private playingCheckpointBase(savedAt: number) {
    return this.checkpoints.playingCheckpointBase(savedAt);
  }

  private createPlayingActionCheckpoint(): PlayingActionCheckpoint {
    return this.checkpoints.createPlayingActionCheckpoint();
  }

  private createPlayingCallCheckpoint(): PlayingCallCheckpoint {
    return this.checkpoints.createPlayingCallCheckpoint();
  }

  private createPlayingReadyCheckpoint(): PlayingReadyCheckpoint {
    return this.checkpoints.createPlayingReadyCheckpoint();
  }

  private createPlayingContinueVoteCheckpoint(): PlayingContinueVoteCheckpoint {
    return this.checkpoints.createPlayingContinueVoteCheckpoint();
  }

  private createPlayingResultTransitionCheckpoint(): PlayingResultTransitionCheckpoint {
    return this.checkpoints.createPlayingResultTransitionCheckpoint();
  }

  /** Restore validated state with every network attachment detached. */
  static restoreCheckpoint(
    input: unknown,
    dependencies: MatchProcessDependencies
  ): MatchProcess {
    const checkpoint = parseMatchCheckpoint(input);
    dependencies = {
      ...dependencies,
      timingMode: checkpoint.decisionTiming?.mode ?? "legacy",
    };
    if (checkpoint.status === "waiting") {
      const match = MatchProcess.createWaitingRoom(
        checkpoint.matchId,
        checkpoint.seed,
        dependencies,
        checkpoint.debug,
        checkpoint.ruleSet,
        checkpoint.presetId,
        checkpoint.mode,
        checkpoint.spectatorDelayMs
      );
      match.kernel.restoreDriver(checkpoint.driver, checkpoint.ruleSet);
      match.roster.restore(checkpoint.seats, checkpoint.ready);
      if (checkpoint.decisionTiming) {
        match.timing.restore(checkpoint.decisionTiming, checkpoint.savedAt);
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
      checkpoint.presetId,
      checkpoint.mode,
      checkpoint.spectatorDelayMs
    );
    const restoredAt = match.runtime.now();
    match.kernel.restore(checkpoint.state, checkpoint.driver);
    match.runtime.restoreRandomState(checkpoint.randomState);
    for (const entry of checkpoint.eventLog) {
      match.publisher.restoreEntry({
        seq: entry.seq,
        event: entry.event,
        emittedAt: restoredAt - entry.emittedAgoMs,
      });
      match.timing.restoreEvent(
        entry.event,
        entry.seq,
        restoredAt - entry.emittedAgoMs
      );
    }
    match.nextSeq = checkpoint.nextSeq;
    match.seatSeq = [...checkpoint.seatSeq];
    match.spectatorSeq = checkpoint.spectatorSeq;
    match.handStartLiveWall = checkpoint.handStartLiveWall
      ? [...checkpoint.handStartLiveWall]
      : null;
    match.session.restore({
      status: "playing",
      startedAt: new Date(restoredAt - checkpoint.startedAgoMs),
      finalized: false,
      gameIndex: checkpoint.gameIndex,
      gameStartLogIdx: checkpoint.gameStartLogIdx,
      sessionChips: [...checkpoint.sessionChips],
      gameStartChips: [...checkpoint.gameStartChips],
      sessionDabuken: [...checkpoint.sessionDabuken],
      sessionFinalized: false,
      pendingSessionEndReason: null,
    });
    match.metadata.restore({
      dice: [...checkpoint.dice],
      riichiTileIdx: [...checkpoint.riichiTileIdx],
    });
    match.kernel.restoreDebugQueues(
      checkpoint.humanDrawQueue,
      checkpoint.leftDiscardQueue
    );
    match.timeBank.restore(checkpoint.bufferMs);
    match.lastEngineEventType = checkpoint.lastEngineEventType;
    match.connections.restorePolicy(checkpoint.connectionPolicy);

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
    if (checkpoint.decisionTiming) {
      match.timing.restore(checkpoint.decisionTiming, checkpoint.savedAt);
    }
    return match;
  }

  private installCheckpointActionWindow(
    checkpoint: PlayingActionCheckpoint
  ): void {
    const restoredAt = this.runtime.now();
    const { actionWindow } = checkpoint;
    this.timeBank.restore(checkpoint.bufferMs);
    this.actionWindows.resetForRestore();
    this.actionWindows.restore(actionWindow.seat, actionWindow, restoredAt);
  }

  private installCheckpointCallWindows(
    checkpoint: PlayingCallCheckpoint
  ): void {
    const restoredAt = this.runtime.now();
    this.calls.restore(checkpoint);
    this.timeBank.restore(checkpoint.bufferMs);
    this.actionWindows.resetForRestore();
    for (let index = 0; index < 4; index++) {
      const timer = checkpoint.callTimers[index];
      if (timer !== null) {
        this.actionWindows.restore(
          index as Seat,
          { ...timer, kind: "turn" },
          restoredAt
        );
      }
    }
  }

  private installCheckpointReadyCheck(
    checkpoint: PlayingReadyCheckpoint,
    restored: boolean
  ): void {
    return this.ready.installCheckpointReadyCheck(checkpoint, restored);
  }

  private async resumeReadyContinuation(
    continuation: PlayingReadyCheckpoint["readyContinuation"]
  ): Promise<void> {
    return this.hand.resumeReadyContinuation(continuation);
  }

  private installCheckpointContinueVote(
    checkpoint: PlayingContinueVoteCheckpoint,
    restored: boolean
  ): void {
    return this.votes.installCheckpointContinueVote(checkpoint, restored);
  }

  private installCheckpointResultTransition(
    checkpoint: PlayingResultTransitionCheckpoint,
    restored: boolean
  ): void {
    return this.results.installCheckpointResultTransition(checkpoint, restored);
  }

  private async runResultTransition(
    transitionKind: PlayingResultTransitionCheckpoint["transitionKind"],
    delayMs: number,
    nextReadyMs: number
  ): Promise<void> {
    return this.results.runResultTransition(
      transitionKind,
      delayMs,
      nextReadyMs
    );
  }

  private finishResultTransition(): void {
    return this.results.finishResultTransition();
  }

  private async resumeResultTransition(
    transitionKind: PlayingResultTransitionCheckpoint["transitionKind"],
    nextReadyMs: number
  ): Promise<void> {
    return this.hand.resumeResultTransition(transitionKind, nextReadyMs);
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async start(): Promise<void> {
    return this.session.start();
  }

  private async beginInitialHandAfterReady(): Promise<void> {
    return this.hand.beginInitialHandAfterReady();
  }

  /**
   * Wait for the human to ack a ready check (pre-match or
   * between hands) — whichever comes first: every seat acked,
   * or `ms` milliseconds elapsed. Bots are pre-acked.
   * No-ops when `ms <= 0` (test path).
   */
  private async runReadyCheck(
    ms: number = legacyTiming.READY_CHECK_MS,
    continuation: PlayingReadyCheckpoint["readyContinuation"] | null = null
  ): Promise<void> {
    return this.ready.runReadyCheck(ms, continuation);
  }

  /**
   * Mark the given seat as acked. Resolves the pending ready
   * check immediately when all seats are acked. No-op when the
   * ready check has already finished.
   */
  async handleReady(seat: Seat): Promise<void> {
    return this.commands.handleReady(seat);
  }

  private finishReadyCheck(): void {
    return this.ready.finishReadyCheck();
  }

  private broadcastReadyCheck(): void {
    return this.ready.broadcastReadyCheck();
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
    livenessProbe?: () => Promise<boolean>,
    connection?: HumanConnectionOptions
  ): HumanAttachResult {
    const result = this.connections.attach(
      seat,
      send,
      livenessProbe,
      connection
    );
    if (this.ready.snapshot().deadline !== null) {
      this.broadcastReadyCheck();
    }
    this.broadcastRoomState();
    this.broadcastViewerState();
    return result;
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

  private duplicateWallState(): DuplicateWallState | undefined {
    const counts = this.kernel.duplicateQueueCounts();
    if (counts === null) {
      return undefined;
    }
    const forecast = estimateDuplicateExhaustion(counts.remaining, {
      phase: this.state.phase,
      turn: this.state.turn,
      pendingReplacementSeat: this.state.pendingShouminkan?.seat ?? null,
    });
    return {
      initial: [...counts.initial],
      remaining: [...counts.remaining],
      limitingSeat: forecast?.limitingSeat ?? null,
      estimatedDrawsRemaining: forecast?.estimatedDrawsRemaining ?? null,
    };
  }

  private duplicateWallEventFields():
    { duplicateWallState: DuplicateWallState } | Record<string, never> {
    const duplicateWallState = this.duplicateWallState();
    return duplicateWallState ? { duplicateWallState } : {};
  }

  private ryuukyokuPublicState(): {
    declarations: [
      boolean | null,
      boolean | null,
      boolean | null,
      boolean | null,
    ];
    tenpaiHands: [Tile[] | null, Tile[] | null, Tile[] | null, Tile[] | null];
  } | null {
    return this.snapshots.ryuukyokuPublicState();
  }

  private settledRyuukyokuResult(): Extract<
    GameEvent,
    { type: "hand_end" }
  > | null {
    return this.snapshots.settledRyuukyokuResult();
  }

  isHumanAttached(seat: Seat, send: Send): boolean {
    return this.connections.isAttached(seat, send);
  }

  humanSeatForUser(userId: string): Seat | null {
    return this.roster.humanSeatForUser(userId);
  }

  isHumanConnected(seat: Seat): boolean {
    return this.connections.isConnected(seat);
  }

  humanSeatFor(send: Send): Seat | null {
    return this.connections.seatFor(send);
  }

  detachHuman(seat: Seat, expectedSend?: Send): boolean {
    if (
      !this.connections.detach(
        seat,
        expectedSend,
        this.isPaused,
        this.session.snapshot().status === "playing"
      )
    ) {
      return false;
    }
    if (
      !this.isPaused &&
      this.session.snapshot().status === "playing" &&
      this.actionWindows.legals(seat).length > 0 &&
      this.actionWindows.view(seat).kind !== "ryuukyoku_declaration"
    ) {
      void this.handleDeadlineExpiry(seat);
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
    return this.roster
      .humanSeats()
      .some((seat) => this.connections.sender(seat) !== null);
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
    return this.roster.humanSeats().length > 0;
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
    return this.session.abortAbandoned();
  }

  /**
   * Apply the client's self-reported AFK status for `seat`.
   * `afk=true` flips the disconnect flag and immediately auto-
   * defaults any open window. `afk=false` clears the flag and
   * leaves the existing deadline timer in place (the player
   * just rejoined; their remaining buffer is whatever the timer
   * was already scheduled against).
   */
  async handleAfk(seat: Seat, afk: boolean): Promise<void> {
    return this.commands.handleAfk(seat, afk);
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
    if (this.spectatorDispatchDelayMs(0) > 0) {
      throw new Error(
        "This match requires delayed spectating; use attachDelayedSpectator."
      );
    }
    this.spectatorSockets.add(send);
    if (viewer) {
      this.spectatorViewers.set(send, {
        ...viewer,
        role: "spectator",
        delayMs: this.relayMode ? legacyTiming.TENHOU_RELAY_VIEWER_DELAY_MS : 0,
      });
    }
    send({
      type: "spectator_config",
      matchId: this.matchId,
      delayMs: this.spectatorDelayMs,
      ...(this.timingMode !== "legacy"
        ? {
            clock: this.timing.stamp(),
            presentationOffsetMs: 0,
          }
        : {}),
    });
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
    const effectiveDelayMs = this.spectatorDispatchDelayMs(delayMs);
    const session: DelayedSpectatorSession = {
      send,
      delayMs: effectiveDelayMs,
      nextCursor: 0,
      seq: 0,
      timer: null,
      closed: false,
    };
    this.delayedSpectators.add(session);
    if (viewer) {
      this.spectatorViewers.set(send, {
        ...viewer,
        role: "spectator",
        delayMs: this.relayMode ? this.spectatorDelayMs : effectiveDelayMs,
      });
    }
    send({
      type: "spectator_config",
      matchId: this.matchId,
      delayMs: this.relayMode ? this.spectatorDelayMs : effectiveDelayMs,
      ...(this.timingMode !== "legacy"
        ? {
            clock: this.timing.stamp(),
            presentationOffsetMs: this.relayMode ? 0 : effectiveDelayMs,
          }
        : {}),
    });
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
          ...this.timing.spectatorMetadata(
            entry.seq,
            seq,
            session.delayMs,
            this.relayMode
          ),
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
      if (entry.emittedAt + this.spectatorDispatchDelayMs(delayMs) > now) {
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
   * Reclaim an existing human seat (matches by `userId`), replace
   * the first bot, or claim the first empty waiting-room placeholder.
   * Returns the assigned `Seat`, or `null` when no replaceable seat
   * exists.
   *
   * Bot replacement is valid in `waiting` and `playing`; final winds
   * stay fixed during play. Reconnect-by-userId works in any status
   * so a human can rejoin after a transient disconnect.
   */
  claimSeat(userId: string, displayName: string): Seat | null {
    return this.roster.claimSeat(userId, displayName);
  }

  /**
   * Release a human seat (back to empty). Only valid in `waiting`
   * status; mid-match leaves are not supported (the seat is held
   * for reconnection). Detaches any live socket on that seat.
   */
  releaseSeat(seat: Seat): void {
    this.roster.releaseSeat(seat);
  }

  setWaitingRoomReady(seat: Seat, ready: boolean): void {
    this.roster.setReady(seat, ready);
  }

  canStartWaitingRoom(requestedBy: Seat): boolean {
    return this.roster.canStart(requestedBy);
  }

  async startWaitingRoom(requestedBy: Seat): Promise<void> {
    await this.roster.startWaitingRoom(
      requestedBy,
      waitingRoomSeatPermutation(this.seed)
    );
  }

  addWaitingRoomBot(requestedBy: Seat): Seat {
    return this.roster.addBot(requestedBy);
  }

  kickWaitingRoomSeat(requestedBy: Seat, target: Seat): void {
    this.roster.kickSeat(requestedBy, target);
  }

  /**
   * Fill every empty slot with a generic bot. Caller is expected
   * to invoke this immediately before `start()`; the bots' user
   * ids are stable (`bot:room:<seat>`) but not portal-resolvable
   * — they exist only inside the orchestrator + replay log.
   */
  fillBots(): void {
    this.roster.fillBots();
  }

  /**
   * Convenience: fill empty slots with bots, broadcast the
   * resulting `playing` room state, and start the match. Returns
   * the same promise as `start()`.
   */
  async fillBotsAndStart(): Promise<void> {
    await this.roster.fillBotsAndStart(waitingRoomSeatPermutation(this.seed));
  }

  /** Recipient-projected room state for `seat`, or `null` mySeat
   * for a spectator view. */
  buildRoomState(
    forSeat: Seat | null
  ): Extract<ServerMessage, { type: "room_state" }> {
    const seats: Array<{
      seat: Seat;
      occupant: RoomSeatOccupant;
      ready: boolean;
    }> = [];
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
            (this.connections.sender(seat) !== null &&
              !this.connections.view(seat).disconnected),
        };
      }
      const ready =
        p?.isBot === true ||
        (p !== null &&
          p !== undefined &&
          !p.isBot &&
          this.roster.readySnapshot()[seat] &&
          this.connections.sender(seat) !== null);
      seats.push({ seat, occupant, ready });
    }
    const hostSeat = this.roster.hostSeat();
    return {
      type: "room_state",
      matchId: this.matchId,
      ...(this.timingMode !== "legacy"
        ? { timingMode: this.timingMode, clock: this.timing.stamp() }
        : {}),
      mode: this.kernel.mode,
      spectatorDelayMs: this.spectatorDelayMs,
      ...(this.timingMode !== "legacy"
        ? { timingMode: this.timingMode, clock: this.timing.stamp() }
        : {}),
      status: this.session.snapshot().status,
      mySeat: forSeat,
      hostSeat,
      canStart: hostSeat !== null && this.canStartWaitingRoom(hostSeat),
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
      const send = this.connections.sender(seat);
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
    const seatedUserIds = new Set<string>();
    for (const player of this.players.values()) {
      if (player !== null && !player.isBot) {
        seatedUserIds.add(player.userId);
      }
    }
    const byUserId = new Map<string, ViewerPresence>();
    for (const viewer of this.spectatorViewers.values()) {
      if (seatedUserIds.has(viewer.userId)) {
        continue;
      }
      const current = byUserId.get(viewer.userId);
      const currentDelayMs = current?.delayMs ?? 0;
      const nextDelayMs = viewer.delayMs ?? 0;
      if (current === undefined || (currentDelayMs > 0 && nextDelayMs === 0)) {
        byUserId.set(viewer.userId, viewer);
      }
    }
    const viewers = [...byUserId.values()].sort((left, right) => {
      const leftDelayed = (left.delayMs ?? 0) > 0;
      const rightDelayed = (right.delayMs ?? 0) > 0;
      if (leftDelayed !== rightDelayed) {
        return leftDelayed ? 1 : -1;
      }
      return left.displayName.localeCompare(right.displayName);
    });
    return { type: "viewer_state", viewers };
  }

  /** Broadcast presence outside the event log to every live connection. */
  private broadcastViewerState(): void {
    const frame = this.buildViewerState();
    for (const send of this.connections.senders()) {
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
    return this.roster.humanSeats();
  }

  humanUserIds(): string[] {
    return this.roster.humanUserIds();
  }

  /** True iff `seat` is a human-controlled seat in this match.
   * False for both bot seats and empty (unclaimed) slots. */
  isHumanSeat(seat: Seat): boolean {
    return this.roster.isHumanSeat(seat);
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
    return this.snapshots.projectForSeat(event, recipient);
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
  buildSnapshotForSeat(
    seat: Seat
  ): Extract<ServerMessage, { type: "snapshot" }> {
    return this.snapshots.buildSnapshotForSeat(seat);
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
      ...this.snapshots.buildSpectatorSnapshot(),
      ...this.timing.spectatorMetadata(
        this.nextSeq - 1,
        this.spectatorSeq - 1,
        0,
        this.relayMode
      ),
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

  async handleAct(
    seat: Seat,
    actionId: string,
    receipt?: InputReceipt
  ): Promise<void> {
    if (this.timing.timingMode !== "legacy") {
      if (receipt === undefined) {
        throw new Error("An authoritative action receipt is required");
      }
      this.reserveAction(seat, actionId, receipt);
    }
    return this.commands.handleAct(seat, actionId);
  }

  private isAcceptedAction(seat: Seat, actionId: string): boolean {
    return this.actions.isAcceptedAction(seat, actionId);
  }

  private async persistLegacyCommandRecovery(): Promise<void> {
    if (
      !this.commands.legacyRecoveryInProgress ||
      this.session.snapshot().status === "finished"
    ) {
      return;
    }
    const checkpoint = this.createCheckpoint();
    this.freezeCheckpoint(checkpoint);
    try {
      await this.eventJournal?.flush();
      await this.repository.saveCheckpoint({
        matchId: this.matchId,
        checkpoint,
      });
      this.commands.clearLegacyRecovery();
      this.resumeCheckpoint(checkpoint);
    } catch (error) {
      this.resumeCheckpoint(checkpoint);
      throw error;
    }
  }

  private isAcceptedReady(seat: Seat): boolean {
    return this.ready.isAcceptedReady(seat);
  }

  private handleReadyDirect(seat: Seat): void {
    return this.ready.handleReadyDirect(seat);
  }

  private isAcceptedAfk(
    seat: Seat,
    afk: boolean,
    defaultActionId: string | null
  ): boolean {
    return this.actions.isAcceptedAfk(seat, afk, defaultActionId);
  }

  private async handleAfkDirect(
    seat: Seat,
    afk: boolean,
    defaultActionId: string | null
  ): Promise<void> {
    return this.actions.handleAfkDirect(seat, afk, defaultActionId);
  }

  private reportAutomaticAction(
    seat: Seat,
    actionId: string,
    reason: AutomaticActionContext["reason"]
  ): void {
    return this.decisions.reportAutomaticAction(seat, actionId, reason);
  }

  private isAcceptedContinueVote(seat: Seat, vote: "yes" | "no"): boolean {
    return this.votes.isAcceptedContinueVote(seat, vote);
  }

  private async handleVoteContinueDirect(
    seat: Seat,
    vote: "yes" | "no"
  ): Promise<void> {
    return this.votes.handleVoteContinueDirect(seat, vote);
  }

  private async handleActDirect(seat: Seat, actionId: string): Promise<void> {
    return this.actions.handleActDirect(seat, actionId);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async waitForWinReaction(
    triggerType: "draw" | "discard" | "call"
  ): Promise<void> {
    await this.waitForEventAge(
      triggerType,
      legacyTiming.WIN_REACTION_DELAY_MS,
      "win_reaction"
    );
  }

  private async waitForEventAge(
    triggerType: "draw" | "discard" | "call",
    minimumAgeMs: number,
    transition: TransitionKind
  ): Promise<void> {
    if (minimumAgeMs <= 0) {
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
        ? minimumAgeMs
        : remainingWinReactionDelayMs(
            triggerEmittedAt,
            this.runtime.now(),
            minimumAgeMs
          );
    if (remaining > 0) {
      await this.runUncheckpointableTransition(transition, remaining);
    }
  }

  private async advanceTurn(): Promise<void> {
    return this.turns.advanceTurn();
  }

  private async continueRyuukyokuDeclarations(): Promise<void> {
    return this.turns.continueRyuukyokuDeclarations();
  }

  private async continueDiscardTurn(): Promise<void> {
    return this.turns.continueDiscardTurn();
  }

  private async openHumanDiscardWindow(seat: Seat): Promise<boolean> {
    return this.turns.openHumanDiscardWindow(seat);
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
    return this.calls.afterDiscard();
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
    return this.callResolution.resolveRons(candidates);
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
    return this.callResolution.resolveBotCall(candidates);
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
    return this.calls.openChankanWindow();
  }

  /** True if `seat`'s 13-tile concealed hand wins on `winTile` as a chankan. */
  private canChankanRon(seat: Seat, winTile: Tile): boolean {
    return this.kernel.canChankanRon(seat, winTile);
  }

  private async dispatchChankanRons(candidates: Seat[]): Promise<void> {
    return this.callResolution.dispatchChankanRons(candidates);
  }

  /**
   * Close the chankan window with no robbing ron: complete the
   * shouminkan (rinshan draw + post-kan dora) and re-prompt the
   * declarer for their next discard.
   */
  private async completeShouminkanAndResume(): Promise<void> {
    return this.callResolution.completeShouminkanAndResume();
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
    return this.calls.openCallWindow(seat, options);
  }

  private buildCallLegals(options: CallOption[]): LegalAction[] {
    return buildCallLegals(options);
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
    return this.calls.resolveCallWindow(seat, action);
  }

  /**
   * Apply the winning call for the current discard. Reads and
   * clears `pendingHumanCallActions`, `pendingBotRons`,
   * `pendingBotCalls`, `pendingChankanBotRons`.
   */
  private async finalizeCallWindow(): Promise<void> {
    return this.calls.finalizeCallWindow();
  }

  /**
   * After a successful chi/pon/daiminkan, the engine puts the calling
   * seat into `awaiting_discard` (and for daiminkan also draws a
   * rinshan tile). If the caller is human, surface their discard
   * legals and wait.
   */
  private async afterCall(): Promise<void> {
    return this.turns.afterCall();
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
    return this.turns.maybeAutoRiichiDiscard();
  }

  private async applyEngineAction(
    action: KernelAction
  ): Promise<MatchStateView> {
    const result = this.kernel.applyAction(action);
    for (const event of result.events) {
      await this.emitEngineEvent(event);
    }
    await this.emitFuritenChanges(result.furitenChanges);
    return result.state;
  }

  private async applyDiscard(
    seat: Seat,
    tile: Tile,
    discardSource?: DiscardSource
  ): Promise<void> {
    const result = this.kernel.discard(seat, tile, discardSource);
    this.setSeatLegals(seat, []);
    for (const event of result.events) {
      await this.emitEngineEvent(event);
    }
    await this.emitFuritenChanges(result.furitenChanges);
  }

  private buildDiscardLegals(seat: Seat): LegalAction[] {
    return this.kernel.discardLegals(seat);
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
  private setSeatLegals(
    seat: Seat,
    actions: LegalAction[],
    kind: ActionWindowKind = "turn"
  ): void {
    if (
      !this.timing.open(
        seat,
        actions,
        kind,
        {
          baseMs: legacyTiming.BASE_ACTION_MS,
          graceMs: legacyTiming.ACTION_GRACE_MS,
          declarationMs: legacyTiming.RYUUKYOKU_DECLARATION_ACTION_MS,
          automatedMs: legacyTiming.DRAW_TO_DISCARD_DELAY_MS,
        },
        this.connections.view(seat).disconnected,
        this.calls.isOpen(seat)
      )
    ) {
      this.decisions.setSeatLegals(seat, actions, kind);
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
    if (!this.timing.consume(seat)) {
      this.decisions.consumeActionBuffer(seat);
    }
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
    return this.decisions.handleDeadlineExpiry(seat);
  }

  private pickDefaultActionId(seat: Seat): string | null {
    return this.decisions.pickDefaultActionId(seat);
  }

  private pickImmediateAfkDefaultActionId(seat: Seat): string | null {
    return this.decisions.pickImmediateAfkDefaultActionId(seat);
  }

  private flushLegalsToSeat(seat: Seat): void {
    const send = this.connections.sender(seat);
    if (!send) {
      return;
    }
    // Legals-only refresh — not a new event, so we don't advance
    // the seat's per-seat seq counter.
    const deadline = this.actionWindows.view(seat).deadline;
    send({
      ...this.timing.metadata(seat, this.seatSeq[seat] - 1),
      type: "event",
      seq: this.seatSeq[seat] - 1,
      events: [],
      legalActions: this.actionWindows.legals(seat),
      ...(deadline !== null ? { deadline } : {}),
      ...(this.actionWindows.view(seat).kind === "ryuukyoku_declaration"
        ? {}
        : { bufferMs: this.timeBank.balance(seat) }),
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
    return this.hand.afterHandEnd();
  }

  private async beginNextHandAfterReady(): Promise<void> {
    return this.hand.beginNextHandAfterReady();
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
    return this.session.endMatch(reason, opts);
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
    const gameEvents = this.eventLog.slice(
      this.session.snapshot().gameStartLogIdx
    );
    const replayEvents = compactRyuukyokuDeclarationsForReplay(
      gameEvents.map((entry) => entry.event)
    );
    const docId = this.currentGameMongoId();
    await this.supersedeEventJournal();
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
      const startedAt =
        this.session.snapshot().startedAt ?? new Date(this.runtime.now());
      await this.repository.archiveReplayLog({
        matchId: docId,
        startedAt,
        endedAt: new Date(this.runtime.now()),
        ruleSet: this.presetId,
        mode: this.kernel.mode,
        events: replayEvents,
        seats: finalScores.map((f) => {
          const player = this.players.get(f.seat);
          return {
            seat: f.seat,
            userDbId: player && !player.isBot ? player.userId : undefined,
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
    return this.session.currentGameMongoId();
  }

  /**
   * Open a Buu continue-vote window and resolve once every seat
   * has voted (unanimous yes → continue) or any seat votes no /
   * the deadline elapses → end session. Bots are auto-yes;
   * disconnected humans are auto-no. Resolves true to continue,
   * false to end.
   */
  private async runContinueVote(finalScores: FinalScore[]): Promise<boolean> {
    return this.votes.runContinueVote(finalScores);
  }

  /**
   * Public WS entry point for a seated human's continue-vote
   * frame. No-ops outside an open vote window. Voters may
   * change their mind freely (yes ↔ no) until the window
   * resolves.
   */
  async handleVoteContinue(seat: Seat, vote: "yes" | "no"): Promise<void> {
    return this.commands.handleVoteContinue(seat, vote);
  }

  private tallyContinueVote(): void {
    return this.votes.tallyContinueVote();
  }

  private finishContinueVote(cont: boolean): void {
    return this.votes.finishContinueVote(cont);
  }

  private async continueAfterVote(
    cont: boolean,
    finalScores: FinalScore[]
  ): Promise<void> {
    return this.session.continueAfterVote(cont, finalScores);
  }

  /**
   * Begin the next game of an ongoing Buu session. Seats are
   * permuted so the previous game's place-1 finisher takes East
   * (seat 0); the other three are randomized via a session-
   * deterministic RNG. Chips / dabuken are carried across,
   * permuted by the same seating; scores reset to the rule-set
   * starting value.
   */
  private async startNextGame(finalScores: FinalScore[]): Promise<void> {
    return this.session.startNextGame(finalScores);
  }

  /**
   * Finalize the whole session. Emits `session_end`, flips
   * status to `finished`, and prevents any further game-level
   * resumption.
   */
  private finalizeSession(
    reason: "vote_no" | "vote_timeout" | "single_game" | "server_abort"
  ): Promise<void> {
    return this.session.finalizeSession(reason);
  }

  private async persistTerminalAndFinalize(): Promise<void> {
    return this.session.persistTerminalAndFinalize();
  }

  async retryPendingFinalization(): Promise<boolean> {
    return this.session.retryPendingFinalization();
  }

  /**
   * Emit a wire `furiten` event for every per-seat transition the
   * engine flagged on the just-applied step. No-op when the step
   * didn't change anyone's furiten status. Always runs *after* the
   * step's own engine events so the client sees the indicator flip
   * immediately following the state change that caused it.
   */
  private async emitFuritenChanges(
    changes: readonly FuritenChange[] | undefined
  ): Promise<void> {
    return this.engineEvents.emitFuritenChanges(changes);
  }

  /**
   * Translate a pure engine event into the wire `GameEvent` and
   * persist + broadcast it. The two unions share field names so the
   * mapping is mostly structural.
   */
  private async emitEngineEvent(e: EngineEvent): Promise<void> {
    return this.engineEvents.emitEngineEvent(e);
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
    return this.publisher.emitEvent(event);
  }

  /**
   * Append an event from an external relay (e.g. Tenhou live spectating) and
   * fan it out to spectators. Bypasses the rules engine, per-seat projection,
   * timers, and bots. Events are expected to be pre-enriched (omniscient
   * `hand_start`), so no `enrichForArchive` pass runs. No-op unless this is a
   * relay match still in `playing` status.
   */
  injectRelayEvent(event: GameEvent): void {
    if (!this.relayMode || this.session.snapshot().status !== "playing") {
      return;
    }
    this.publisher.appendRelay(event);
    if (event.type === "match_start") {
      this.relaySeats = event.seats.map((s) => ({
        seat: s.seat,
        displayName: s.displayName,
      }));
      for (const s of event.seats) {
        this.roster.replaceSeat(s.seat, {
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
    if (!this.relayMode || this.session.snapshot().status !== "playing") {
      return;
    }
    this.session.finishRelay();
    if (!this.relaySourceGameId) {
      return;
    }
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
        sourceGameId: this.relaySourceGameId,
        sourceGameIdAliases: this.relaySourceGameIdAliases,
        insertOnly: true,
        startedAt:
          this.session.snapshot().startedAt ?? new Date(this.runtime.now()),
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
    const send = this.connections.sender(seat);
    if (!send) {
      return;
    }
    const projected = this.projectForSeat(event, seat);
    if (projected === null) {
      return;
    }
    const seq = this.publisher.claimSeatSequence(seat);
    const legals = this.actionWindows.legals(seat);
    const deadline = this.actionWindows.view(seat).deadline;
    send({
      ...this.timing.metadata(seat, seq),
      type: "event",
      seq,
      events: [projected],
      legalActions: legals,
      ...(deadline !== null ? { deadline } : {}),
      ...(this.actionWindows.view(seat).kind === "ryuukyoku_declaration"
        ? {}
        : { bufferMs: this.timeBank.balance(seat) }),
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
    const seq = this.publisher.claimSpectatorSequence();
    if (this.spectatorSockets.size === 0) {
      return;
    }
    for (const send of this.spectatorSockets) {
      send({
        type: "event",
        seq,
        events: [projected],
        legalActions: [],
        ...this.timing.spectatorMetadata(
          this.nextSeq - 1,
          seq,
          0,
          this.relayMode
        ),
      });
    }
  }

  /**
   * Attach server-side state needed by replay archival to a
   * wire-clean event. At `hand_start` this snapshots per-seat
   * starting hands plus the complete live and dead walls; the wire
   * event itself never carries these fields, eliminating the risk
   * of leaking private state through a future player send path. The result is what gets
   * pushed to `eventLog`; consumers that forward it to live
   * recipients (`sendToSeat`, future spectator / resync paths)
   * MUST project it through the redaction layer at their boundary.
   */
  private enrichForArchive(event: GameEvent): GameEvent {
    return this.archiveEvents.enrichForArchive(event);
  }
}
