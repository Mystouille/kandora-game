import type { ReadonlySeatValues } from "~/game/protocol/seat";
import type { Seat } from "~/game/protocol/messages";
import { resolveRuleSet } from "~/game/rules";
import { mapSeatValues } from "~/game/rules/seats";
import {
  MATCH_CHECKPOINT_SCHEMA_VERSION,
  PlayingActionCheckpointSchema,
  PlayingCallCheckpointSchema,
  PlayingContinueVoteCheckpointSchema,
  PlayingReadyCheckpointSchema,
  PlayingResultTransitionCheckpointSchema,
  PlayingNukiCheckpointSchema,
  PlayingFlowerCheckpointSchema,
  WaitingRoomCheckpointSchema,
  type PlayingActionCheckpoint,
  type PlayingCallCheckpoint,
  type PlayingContinueVoteCheckpoint,
  type PlayingReadyCheckpoint,
  type PlayingResultTransitionCheckpoint,
  type WaitingRoomCheckpoint,
} from "../checkpoint";
import { gameTiming } from "../session/timingPolicy";
import type { MatchKernel } from "../session/matchKernel";
import type { RoomRoster } from "../session/roomRoster";
import type { PlayerConnections } from "../session/playerConnections";
import type { SessionCoordinator } from "../session/sessionCoordinator";
import type { CallCoordinator } from "../session/callCoordinator";
import type { ReadyCheck } from "../session/readyCheck";
import type { ContinueVote } from "../session/continueVote";
import type { ResultTransition } from "../session/resultTransition";
import type { HandLifecycle } from "../session/handLifecycle";
import type { HandMetadata } from "../session/handMetadata";
import type { ActionWindowRegistry } from "../timing/actionWindows";
import type { TimeBank } from "../timing/timeBank";
import type { DecisionTiming } from "../timing/decisionTiming";
import type { MatchRuntime } from "../runtime";
import type { MatchConfiguration } from "../session/sessionTypes";
import type { Tile, GameEvent } from "~/game/protocol/messages";
export interface CheckpointFactoryPort {
  readonly config: MatchConfiguration;
  readonly kernel: Pick<
    MatchKernel,
    "view" | "mode" | "driverSnapshot" | "debugQueues"
  >;
  readonly roster: Pick<RoomRoster, "players" | "readySnapshot">;
  readonly connections: Pick<PlayerConnections, "view" | "policySnapshot">;
  readonly session: Pick<
    SessionCoordinator,
    "snapshot" | "hasPendingFinalization"
  >;
  readonly calls: Pick<CallCoordinator, "snapshot">;
  readonly ready: Pick<ReadyCheck, "snapshot">;
  readonly votes: Pick<ContinueVote, "snapshot">;
  readonly results: Pick<ResultTransition, "snapshot">;
  readonly hand: Pick<HandLifecycle, "pendingRevealMs">;
  readonly metadata: Pick<HandMetadata, "snapshot">;
  readonly windows: Pick<
    ActionWindowRegistry,
    "view" | "timedView" | "legals" | "allLegals" | "hasTimers"
  >;
  readonly bank: Pick<TimeBank, "balance" | "snapshot">;
  readonly timing: Pick<DecisionTiming, "capture">;
  readonly runtime: Pick<MatchRuntime, "now" | "captureRandomState">;
  isRelay(): boolean;
  delayedSpectators(): ReadonlySet<unknown>;
  history(): readonly {
    seq: number;
    event: GameEvent;
    emittedAt: number;
    calendarAt?: number;
  }[];
  nextSequence(): number;
  seatSequences(): ReadonlySeatValues<number>;
  spectatorSequence(): number;
  handStartWall(): readonly Tile[] | null;
  lastEngineType(): import("~/game/rules").EngineEvent["type"] | null;
}

export class CheckpointFactory {
  constructor(private readonly port: CheckpointFactoryPort) {}

  createPlayingReplacementCheckpoint(kind: "nuki" | "flower") {
    this.assertCommonPlayingCheckpointState();
    const input = {
      ...this.playingCheckpointBase(this.port.runtime.now()),
      checkpointKind:
        kind === "nuki"
          ? ("nuki_replacement" as const)
          : ("flower_replacement" as const),
    };
    return kind === "nuki"
      ? PlayingNukiCheckpointSchema.parse(input)
      : PlayingFlowerCheckpointSchema.parse(input);
  }
  private checkpointPlayers(): WaitingRoomCheckpoint["seats"] {
    return mapSeatValues([...this.port.roster.players().values()], (player) =>
      player === null ? null : { ...player }
    );
  }

  private playingPlayers(): PlayingActionCheckpoint["seats"] {
    return mapSeatValues(this.checkpointPlayers(), (player) => {
      if (player === null) {
        throw new Error(
          "MatchProcess.createCheckpoint: playing match has an empty seat"
        );
      }
      return player;
    });
  }

  createWaitingRoomCheckpoint(): WaitingRoomCheckpoint {
    return WaitingRoomCheckpointSchema.parse({
      decisionTiming: this.port.timing.capture(),
      schemaVersion: MATCH_CHECKPOINT_SCHEMA_VERSION,
      status: "waiting",
      savedAt: this.port.runtime.now(),
      matchId: this.port.config.matchId,
      seed: this.port.config.seed,
      presetId: this.port.config.presetId,
      spectatorDelayMs: this.port.config.spectatorDelayMs,
      mode: this.port.kernel.mode,
      driver: this.port.kernel.driverSnapshot(),
      ruleSet: resolveRuleSet(this.port.config.ruleSetOverride),
      debug: this.port.config.debug
        ? {
            ...(this.port.config.debug.humanHand
              ? { humanHand: [...this.port.config.debug.humanHand] }
              : {}),
            ...(this.port.config.debug.humanDraws
              ? { humanDraws: [...this.port.config.debug.humanDraws] }
              : {}),
            ...(this.port.config.debug.leftDiscards
              ? { leftDiscards: [...this.port.config.debug.leftDiscards] }
              : {}),
          }
        : undefined,
      seats: this.checkpointPlayers(),
      ready: [...this.port.roster.readySnapshot()],
    });
  }

  checkpointUnsupported(reason: string): never {
    throw new Error(
      `MatchProcess.createCheckpoint: playing state is not quiescent (${reason})`
    );
  }

  assertCommonPlayingCheckpointState(
    allowReady = false,
    allowVote = false
  ): void {
    if (this.port.isRelay()) {
      this.checkpointUnsupported("relay match");
    }
    if (
      !allowVote &&
      (this.port.votes.snapshot().active ||
        this.port.votes.snapshot().timerPending)
    ) {
      this.checkpointUnsupported("vote continuation");
    }
    if (
      !allowReady &&
      (this.port.ready.snapshot().active ||
        this.port.ready.snapshot().timerPending)
    ) {
      this.checkpointUnsupported("ready continuation");
    }
    if (this.port.delayedSpectators().size > 0) {
      this.checkpointUnsupported("delayed spectator work");
    }
    if (
      this.port.hand.pendingRevealMs !== 0 ||
      (!allowVote && this.port.session.snapshot().finalized) ||
      this.port.session.snapshot().sessionFinalized
    ) {
      this.checkpointUnsupported("result or finalization work");
    }
  }

  playingCheckpointBase(savedAt: number) {
    const startingWall = this.port.handStartWall();
    return {
      decisionTiming: this.port.timing.capture(),
      schemaVersion: MATCH_CHECKPOINT_SCHEMA_VERSION,
      status: "playing" as const,
      savedAt,
      matchId: this.port.config.matchId,
      seed: this.port.config.seed,
      presetId: this.port.config.presetId,
      spectatorDelayMs: this.port.config.spectatorDelayMs,
      mode: this.port.kernel.mode,
      driver: this.port.kernel.driverSnapshot(),
      seats: this.playingPlayers(),
      state: this.port.kernel.view,
      startedAgoMs: Math.max(
        0,
        savedAt -
          (this.port.session.snapshot().startedReferenceAt ??
            this.port.session.snapshot().startedAt?.getTime() ??
            savedAt)
      ),
      ...(this.port.session.snapshot().startedAt
        ? {
            startedCalendarAt: this.port.session
              .snapshot()
              .startedAt?.getTime(),
          }
        : {}),
      randomState: this.port.runtime.captureRandomState(),
      eventLog: this.port.history().map((entry) => ({
        seq: entry.seq,
        event: entry.event,
        emittedAgoMs: Math.max(0, savedAt - entry.emittedAt),
        ...(entry.calendarAt !== undefined
          ? { calendarAt: entry.calendarAt }
          : {}),
      })),
      nextSeq: this.port.nextSequence(),
      seatSeq: [...this.port.seatSequences()],
      spectatorSeq: this.port.spectatorSequence(),
      handStartLiveWall: startingWall ? [...startingWall] : null,
      gameStartLogIdx: this.port.session.snapshot().gameStartLogIdx,
      gameIndex: this.port.session.snapshot().gameIndex,
      sessionChips: [...this.port.session.snapshot().sessionChips],
      gameStartChips: [...this.port.session.snapshot().gameStartChips],
      sessionDabuken: [...this.port.session.snapshot().sessionDabuken],
      dice: [...this.port.metadata.snapshot().dice],
      riichiTileIdx: [...this.port.metadata.snapshot().riichiTileIdx],
      humanDrawQueue: [...this.port.kernel.debugQueues().humanDraws],
      leftDiscardQueue: [...this.port.kernel.debugQueues().leftDiscards],
      bufferMs: [...this.port.bank.snapshot()],
      connectionPolicy: this.port.connections.policySnapshot(),
      lastEngineEventType: this.port.lastEngineType(),
    };
  }

  createPlayingActionCheckpoint(): PlayingActionCheckpoint {
    this.assertCommonPlayingCheckpointState();
    const seat = this.port.kernel.view.turn;
    const windowKind = this.port.windows.view(seat).kind;
    const expectedPhase =
      windowKind === "ryuukyoku_declaration"
        ? "awaiting_ryuukyoku_declarations"
        : "awaiting_discard";
    if (windowKind === null || this.port.kernel.view.phase !== expectedPhase) {
      this.checkpointUnsupported(`engine phase ${this.port.kernel.view.phase}`);
    }
    if (
      this.port.calls
        .snapshot()
        .callWindows.some((window) => window !== null) ||
      this.port.calls
        .snapshot()
        .pendingHumanCallActions.some((action) => action !== null) ||
      this.port.calls.snapshot().pendingBotRons.length > 0 ||
      this.port.calls.snapshot().pendingBotCalls.length > 0 ||
      this.port.calls.snapshot().pendingChankanBotRons.length > 0
    ) {
      this.checkpointUnsupported("call resolution");
    }

    const player = this.port.roster.players().get(seat);
    if (!player || player.isBot) {
      this.checkpointUnsupported("active seat is not human");
    }
    const legalActions = this.port.windows.legals(seat);
    if (
      legalActions.length === 0 ||
      this.port.windows
        .allLegals()
        .some((actions, candidate) => candidate !== seat && actions.length > 0)
    ) {
      this.checkpointUnsupported("expected exactly one legal-action window");
    }
    const actionStartedAt = this.port.windows.view(seat).startedAt;
    const visibleDeadline = this.port.windows.view(seat).deadline;
    if (
      actionStartedAt === null ||
      visibleDeadline === null ||
      !this.port.windows.view(seat).timerPending
    ) {
      this.checkpointUnsupported("action timer is not active");
    }

    const savedAt = this.port.runtime.now();
    const elapsedMs = Math.max(0, savedAt - actionStartedAt);
    const expiryDurationMs =
      windowKind === "ryuukyoku_declaration"
        ? gameTiming.RYUUKYOKU_DECLARATION_ACTION_MS
        : this.port.connections.view(seat).disconnected
          ? gameTiming.DRAW_TO_DISCARD_DELAY_MS
          : gameTiming.BASE_ACTION_MS +
            this.port.bank.balance(seat) +
            gameTiming.ACTION_GRACE_MS;
    const timed = this.port.windows.timedView(seat);
    const expiryRemainingMs = Math.max(
      0,
      timed ? timed.expiresAt - savedAt : expiryDurationMs - elapsedMs
    );
    return PlayingActionCheckpointSchema.parse({
      ...this.playingCheckpointBase(savedAt),
      checkpointKind: "action_window",
      actionWindow: {
        kind: windowKind,
        seat,
        legalActions,
        elapsedMs,
        visibleRemainingMs: Math.max(0, visibleDeadline - savedAt),
        expiryRemainingMs,
      },
    });
  }

  createPlayingCallCheckpoint(): PlayingCallCheckpoint {
    this.assertCommonPlayingCheckpointState();
    if (
      this.port.kernel.view.phase !== "awaiting_draw" &&
      this.port.kernel.view.phase !== "awaiting_chankan"
    ) {
      this.checkpointUnsupported(`engine phase ${this.port.kernel.view.phase}`);
    }
    const savedAt = this.port.runtime.now();
    const callTimers = this.port.calls
      .snapshot()
      .callWindows.map((options, seatIndex) => {
        if (options === null) {
          if (
            this.port.windows.view(seatIndex as Seat).timerPending ||
            this.port.windows.view(seatIndex as Seat).startedAt !== null ||
            this.port.windows.view(seatIndex as Seat).deadline !== null ||
            this.port.windows.legals(seatIndex as Seat).length > 0
          ) {
            this.checkpointUnsupported(
              "closed call window retains action state"
            );
          }
          return null;
        }
        const seat = seatIndex as Seat;
        const startedAt = this.port.windows.view(seat).startedAt;
        const deadline = this.port.windows.view(seat).deadline;
        if (
          startedAt === null ||
          deadline === null ||
          !this.port.windows.view(seat).timerPending ||
          this.port.windows.legals(seat).length === 0
        ) {
          this.checkpointUnsupported("open call window timer is incomplete");
        }
        const elapsedMs = Math.max(0, savedAt - startedAt);
        const expiryDurationMs = this.port.connections.view(seat).disconnected
          ? gameTiming.DRAW_TO_DISCARD_DELAY_MS
          : gameTiming.BASE_ACTION_MS +
            this.port.bank.balance(seat) +
            gameTiming.ACTION_GRACE_MS;
        return {
          legalActions: this.port.windows.legals(seat),
          elapsedMs,
          visibleRemainingMs: Math.max(0, deadline - savedAt),
          expiryRemainingMs: Math.max(
            0,
            this.port.windows.timedView(seat)
              ? (this.port.windows.timedView(seat)?.expiresAt ?? savedAt) -
                  savedAt
              : expiryDurationMs - elapsedMs
          ),
        };
      });
    return PlayingCallCheckpointSchema.parse({
      ...this.playingCheckpointBase(savedAt),
      checkpointKind: "call_window",
      callWindows: this.port.calls.snapshot().callWindows,
      pendingHumanCallActions:
        this.port.calls.snapshot().pendingHumanCallActions,
      pendingBotRons: [...this.port.calls.snapshot().pendingBotRons],
      pendingBotCalls: this.port.calls.snapshot().pendingBotCalls,
      pendingChankanBotRons: [
        ...this.port.calls.snapshot().pendingChankanBotRons,
      ],
      callTimers,
    });
  }

  createPlayingReadyCheckpoint(): PlayingReadyCheckpoint {
    this.assertCommonPlayingCheckpointState(true);
    if (
      !this.port.ready.snapshot().active ||
      this.port.ready.snapshot().deadline === null ||
      !this.port.ready.snapshot().timerPending
    ) {
      this.checkpointUnsupported("ready timer is incomplete");
    }
    if (this.port.ready.snapshot().continuation === null) {
      this.checkpointUnsupported("unsupported ready continuation");
    }
    if (
      this.port.calls
        .snapshot()
        .callWindows.some((window) => window !== null) ||
      this.port.calls
        .snapshot()
        .pendingHumanCallActions.some((action) => action !== null) ||
      this.port.calls.snapshot().pendingBotRons.length > 0 ||
      this.port.calls.snapshot().pendingBotCalls.length > 0 ||
      this.port.calls.snapshot().pendingChankanBotRons.length > 0 ||
      this.port.windows.allLegals().some((actions) => actions.length > 0) ||
      this.port.windows.hasTimers
    ) {
      this.checkpointUnsupported("ready check retains action state");
    }
    const ready = this.port.ready.snapshot();
    if (ready.deadline === null) {
      this.checkpointUnsupported("ready check has no deadline");
    }
    const savedAt = this.port.runtime.now();
    return PlayingReadyCheckpointSchema.parse({
      ...this.playingCheckpointBase(savedAt),
      checkpointKind: "ready_check",
      readyContinuation: this.port.ready.snapshot().continuation,
      readyAcked: [...this.port.ready.snapshot().acked],
      readyRemainingMs: Math.max(0, ready.deadline - savedAt),
    });
  }

  createPlayingContinueVoteCheckpoint(): PlayingContinueVoteCheckpoint {
    this.assertCommonPlayingCheckpointState(false, true);
    if (
      !this.port.votes.snapshot().active ||
      this.port.votes.snapshot().deadline === null ||
      this.port.votes.snapshot().finalScores === null
    ) {
      this.checkpointUnsupported("continue vote is incomplete");
    }
    if (
      this.port.ready.snapshot().active ||
      this.port.ready.snapshot().timerPending ||
      this.port.calls
        .snapshot()
        .callWindows.some((window) => window !== null) ||
      this.port.windows.allLegals().some((actions) => actions.length > 0) ||
      this.port.windows.hasTimers
    ) {
      this.checkpointUnsupported("continue vote retains action state");
    }
    const vote = this.port.votes.snapshot();
    if (vote.deadline === null) {
      this.checkpointUnsupported("continue vote has no deadline");
    }
    const savedAt = this.port.runtime.now();
    const resolutionPending =
      vote.votes.some((value) => value === "no") ||
      vote.votes.every((value) => value === "yes");
    return PlayingContinueVoteCheckpointSchema.parse({
      ...this.playingCheckpointBase(savedAt),
      checkpointKind: "continue_vote",
      votes: [...this.port.votes.snapshot().votes],
      voteRemainingMs: Math.max(0, vote.deadline - savedAt),
      timeoutArmed:
        !resolutionPending && this.port.votes.snapshot().timerPending,
      finalScores: this.port.votes.snapshot().finalScores,
    });
  }

  createPlayingResultTransitionCheckpoint(): PlayingResultTransitionCheckpoint {
    this.assertCommonPlayingCheckpointState();
    if (
      !this.port.results.snapshot().active ||
      !this.port.results.snapshot().timerPending ||
      this.port.results.snapshot().deadline === null ||
      this.port.results.snapshot().kind === null
    ) {
      this.checkpointUnsupported("result transition is incomplete");
    }
    if (
      this.port.ready.snapshot().active ||
      this.port.votes.snapshot().active ||
      this.port.calls
        .snapshot()
        .callWindows.some((window) => window !== null) ||
      this.port.windows.allLegals().some((actions) => actions.length > 0) ||
      this.port.windows.hasTimers
    ) {
      this.checkpointUnsupported("result transition retains input state");
    }
    const result = this.port.results.snapshot();
    if (result.deadline === null) {
      this.checkpointUnsupported("result transition has no deadline");
    }
    const savedAt = this.port.runtime.now();
    return PlayingResultTransitionCheckpointSchema.parse({
      ...this.playingCheckpointBase(savedAt),
      checkpointKind: "result_transition",
      transitionKind: this.port.results.snapshot().kind,
      transitionRemainingMs: Math.max(0, result.deadline - savedAt),
      nextReadyMs: this.port.results.snapshot().nextReadyMs,
    });
  }
}
