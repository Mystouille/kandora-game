import { copySeatValues } from "~/game/rules/seats";
import { MatchModeConfigSchema } from "~/game/protocol/matchMode";
import { SpectatorDelayMsSchema } from "~/game/protocol/spectatorDelay";
import { CheckpointFactory } from "../recovery/checkpointFactory";
import { CheckpointInstaller } from "../recovery/checkpointInstaller";
import { MatchRecovery } from "../recovery/matchRecovery";
import { RelayMatch } from "../relay/relayMatch";
import { createSystemMatchRuntime, type MatchRuntime } from "../runtime";
import type { MatchRepository } from "../repository";
import { duplicateMatchSeed } from "../match-drivers/duplicatePlan";
import { ArchiveEventComposer } from "../session/archiveEventComposer";
import { CommandCoordinator } from "../session/commandCoordinator";
import { MatchEventPublisher } from "../session/eventPublisher";
import { GameArchive } from "../session/gameArchive";
import { HandMetadata } from "../session/handMetadata";
import { gameTiming } from "../session/timingPolicy";
import { MatchBroadcast } from "../session/matchBroadcast";
import { MatchKernel } from "../session/matchKernel";
import { MatchViewDetails } from "../session/matchViewDetails";
import { PlayerConnections } from "../session/playerConnections";
import { RoomRoster, type MatchPlayerInit } from "../session/roomRoster";
import { MatchRoomViews } from "../session/roomViews";
import { SnapshotComposer } from "../session/snapshotComposer";
import { SpectatorStreams } from "../session/spectatorStreams";
import { TransitionBarrier } from "../session/transitionBarrier";
import { MatchViewerPresence } from "../session/viewerPresence";
import type { MatchConfiguration } from "../session/sessionTypes";
import { ActionWindowRegistry } from "../timing/actionWindows";
import { DecisionTiming } from "../timing/decisionTiming";
import { TimeBank } from "../timing/timeBank";
import type { MatchProcessDependencies } from "./dependencies";
import { MatchGameplay } from "./matchGameplay";
import { MatchLifecycle } from "./matchLifecycle";
import { resolveRuleSet } from "~/game/rules/ruleSet";
import { debugSeedValidationError } from "~/game/rules/debugSeed";

/** Readonly owner references, never a replacement bag of match state. */
export class MatchComposition {
  readonly config: MatchConfiguration;
  readonly runtime: MatchRuntime;
  readonly repository: MatchRepository;
  readonly roster: RoomRoster;
  readonly connections: PlayerConnections;
  readonly kernel: MatchKernel;
  readonly timeBank: TimeBank;
  readonly actionWindows: ActionWindowRegistry;
  readonly timing: DecisionTiming;
  readonly commands: CommandCoordinator;
  readonly barrier: TransitionBarrier;
  readonly metadata: HandMetadata;
  readonly details: MatchViewDetails;
  readonly gameplay: MatchGameplay;
  readonly lifecycle: MatchLifecycle;
  readonly archiveEvents: ArchiveEventComposer;
  readonly publisher: MatchEventPublisher;
  readonly relay: RelayMatch;
  readonly presence: MatchViewerPresence;
  readonly roomViews: MatchRoomViews;
  readonly spectators: SpectatorStreams;
  readonly broadcast: MatchBroadcast;
  readonly snapshots: SnapshotComposer;
  readonly archive: GameArchive;
  readonly checkpoints: CheckpointFactory;
  readonly installer: CheckpointInstaller;
  readonly recovery: MatchRecovery;

  constructor(
    config: MatchConfiguration,
    players: MatchPlayerInit[],
    dependencies: MatchProcessDependencies
  ) {
    const rules = resolveRuleSet(config.ruleSetOverride);
    const playerCount = rules.playerCount;
    if (players.length !== playerCount) {
      throw new Error(`MatchProcess requires exactly ${playerCount} players`);
    }
    const debugError = debugSeedValidationError(config.debug, rules);
    if (debugError !== null) {
      throw new Error(`MatchProcess: ${debugError}`);
    }
    this.roster = new RoomRoster(config.matchId, players, {
      status: () => this.lifecycle.session.snapshot().status,
      assertNotPaused: (operation) => this.assertNotPaused(operation),
      hasSender: (seat) => this.connections.sender(seat) !== null,
      send: (seat, message) => this.connections.sender(seat)?.(message),
      clearConnection: (seat) => this.connections.clearSeat(seat),
      permuteConnections: (permutation) =>
        this.connections.permute(permutation),
      onPlayingHumanClaimed: (seat) => this.lifecycle.ready.unackHuman(seat),
      broadcastRoom: () => this.broadcast.broadcastRoomState(),
      broadcastViewers: () => this.broadcast.broadcastViewerState(),
      start: () => this.lifecycle.session.start(),
    });
    this.connections = new PlayerConnections(
      (seat) => this.roster.player(seat),
      () => this.broadcast.broadcastRoomState(),
      playerCount
    );
    const mode = MatchModeConfigSchema.parse(config.mode);
    if (mode.type === "duplicate" && config.debug !== undefined) {
      throw new Error(
        "MatchProcess: debug overrides are unavailable in duplicate mode"
      );
    }
    if (mode.type === "duplicate" && config.seed !== duplicateMatchSeed(mode)) {
      throw new Error(
        "MatchProcess: duplicate seed does not match public mode seed"
      );
    }
    this.config = {
      ...config,
      mode,
      spectatorDelayMs: SpectatorDelayMsSchema.parse(config.spectatorDelayMs),
    };
    this.runtime =
      dependencies.runtime ??
      createSystemMatchRuntime(config.seed, dependencies.authorityClock);
    this.repository = dependencies.repository;
    const eventJournalStore = dependencies.eventJournalStore ?? null;
    this.kernel = new MatchKernel(
      mode,
      config.presetId,
      this.runtime,
      playerCount
    );
    this.timeBank = new TimeBank(gameTiming.INITIAL_BUFFER_MS, playerCount);
    this.actionWindows = new ActionWindowRegistry(
      this.runtime,
      (seat) => {
        void this.gameplay.decisions.handleDeadlineExpiry(seat);
      },
      () => this.isPaused,
      playerCount
    );
    this.timing = new DecisionTiming(
      this.runtime.clockEpoch ?? `match-${config.matchId}`,
      config.matchId,
      this.runtime,
      this.actionWindows,
      this.timeBank,
      dependencies.onTimingDiagnostic
    );
    this.commands = new CommandCoordinator(this.actionWindows, {
      sequence: () => this.publisher.nextSequence,
      decisionId: (command) => {
        if (command.type === "act") {
          return this.actionWindows.timedView(command.seat)?.id ?? null;
        }
        if (command.type === "ready" || command.type === "vote_continue") {
          return this.timing.promptTiming?.view(command.seat)?.id ?? null;
        }
        return null;
      },
      status: () => this.lifecycle.session.snapshot().status,
      isPaused: () => this.isPaused,
      pendingCheckpointSave: () => this.recovery.coordinator.saving,
      afkDefaultAction: (seat) =>
        this.gameplay.decisions.pickImmediateAfkDefaultActionId(seat),
      persistRecovery: () => this.recovery.persistLegacyCommandRecovery(),
      accept: (command) => {
        if (command.type === "act") {
          return this.gameplay.actions.isAcceptedAction(
            command.seat,
            command.actionId
          );
        }
        if (command.type === "ready") {
          return this.lifecycle.ready.isAcceptedReady(command.seat);
        }
        if (command.type === "afk") {
          return this.gameplay.actions.isAcceptedAfk(
            command.seat,
            command.afk,
            command.defaultActionId
          );
        }
        return this.lifecycle.votes.isAcceptedContinueVote(
          command.seat,
          command.vote
        );
      },
      execute: async (command) => {
        if (command.type === "act") {
          await this.gameplay.actions.handleActDirect(
            command.seat,
            command.actionId
          );
        } else if (command.type === "ready") {
          this.lifecycle.ready.handleReadyDirect(command.seat);
        } else if (command.type === "afk") {
          await this.gameplay.actions.handleAfkDirect(
            command.seat,
            command.afk,
            command.defaultActionId
          );
        } else {
          await this.lifecycle.votes.handleVoteContinueDirect(
            command.seat,
            command.vote
          );
        }
      },
    });
    this.barrier = new TransitionBarrier(this.runtime);
    this.metadata = new HandMetadata(this.runtime, playerCount);
    this.details = new MatchViewDetails(this.kernel);
    this.gameplay = new MatchGameplay(
      config.matchId,
      {
        runtime: this.runtime,
        kernel: this.kernel,
        roster: this.roster,
        connections: this.connections,
        windows: this.actionWindows,
        bank: this.timeBank,
        timing: this.timing,
        commands: this.commands,
        barrier: this.barrier,
      },
      {
        isPaused: () => this.isPaused,
        status: () => this.lifecycle.session.snapshot().status,
        history: () => this.publisher.history(),
        nextSequence: () => this.publisher.nextSequence,
        currentGameMongoId: () => this.lifecycle.session.currentGameMongoId(),
        emitEngineEvent: (event) =>
          this.lifecycle.engineEvents.emitEngineEvent(event),
        emitFuritenChanges: (changes) =>
          this.lifecycle.engineEvents.emitFuritenChanges(changes),
        afterHandEnd: () => this.lifecycle.hand.afterHandEnd(),
        flushLegalsToSeat: (seat) => this.broadcast.flushLegalsToSeat(seat),
        broadcastRoomState: () => this.broadcast.broadcastRoomState(),
        onAutomaticAction: dependencies.onAutomaticAction,
      }
    );
    this.lifecycle = new MatchLifecycle(
      this.config,
      {
        runtime: this.runtime,
        repository: this.repository,
        kernel: this.kernel,
        roster: this.roster,
        connections: this.connections,
        commands: this.commands,
        bank: this.timeBank,
        windows: this.actionWindows,
        metadata: this.metadata,
        details: this.details,
        effects: this.gameplay.effects,
        promptTiming: this.timing.promptTiming,
      },
      {
        isPaused: () => this.isPaused,
        assertNotPaused: (operation) => this.assertNotPaused(operation),
        emitEvent: (event) => this.publisher.emitEvent(event),
        eventCount: () => this.publisher.history().length,
        openEventJournal: (gameId, seq) =>
          this.publisher.openEventJournal(gameId, seq),
        archiveCurrentGame: (scores) => this.archive.archiveCurrentGame(scores),
        broadcastRoomState: () => this.broadcast.broadcastRoomState(),
        advanceTurn: () => this.gameplay.turns.advanceTurn(),
        resetCallState: () => this.gameplay.calls.resetHand(),
        runTransition: (kind, delay) => this.barrier.run(kind, delay),
      }
    );
    this.archiveEvents = new ArchiveEventComposer({
      state: () => this.kernel.view,
      kernel: this.kernel,
    });
    this.publisher = new MatchEventPublisher({
      playerCount,
      runtime: this.runtime,
      timing: this.timing,
      eventJournalStore,
      onEventJournalError: dependencies.onEventJournalError,
      enrichForArchive: (event) => this.archiveEvents.enrichForArchive(event),
      humanSeats: () => this.roster.humanSeats(),
      sendToSeat: (seat, event) => this.broadcast.sendToSeat(seat, event),
      sendToSpectators: (event) => this.spectators.sendToSpectators(event),
      notifyDelayedSpectators: () => this.spectators.notifyDelayedSpectators(),
    });
    this.relay = new RelayMatch(
      config.matchId,
      this.config.spectatorDelayMs,
      this.runtime,
      this.repository,
      this.roster,
      {
        sessionSnapshot: () => this.lifecycle.session.snapshot(),
        startRelay: () => this.lifecycle.session.startRelay(),
        finishRelay: () => this.lifecycle.session.finishRelay(),
        history: () => this.publisher.history(),
        appendRelay: (event) => this.publisher.appendRelay(event),
        sendToSpectators: (event) => this.spectators.sendToSpectators(event),
        notifyDelayedSpectators: () =>
          this.spectators.notifyDelayedSpectators(),
      }
    );
    this.presence = new MatchViewerPresence();
    this.roomViews = new MatchRoomViews(
      this.config,
      this.roster,
      this.connections,
      this.kernel,
      this.timing,
      {
        status: () => this.lifecycle.session.snapshot().status,
        isRelay: () => this.relay.isRelay,
        relayRuleSet: () => this.relay.presetId,
        spectatorDelayMs: () => this.relay.spectatorDelayMs,
      }
    );
    this.spectators = new SpectatorStreams(this.presence, {
      matchId: config.matchId,
      runtime: this.runtime,
      timing: this.timing,
      isRelay: () => this.relay.isRelay,
      spectatorDelayMs: () => this.relay.spectatorDelayMs,
      spectatorDispatchDelayMs: (delay) =>
        this.relay.spectatorDispatchDelayMs(delay),
      history: () => this.publisher.history(),
      nextSequence: () => this.publisher.nextSequence,
      claimSpectatorSequence: () => this.publisher.claimSpectatorSequence(),
      buildRoomState: () => this.roomViews.buildRoomState(null),
      broadcastViewerState: () => this.broadcast.broadcastViewerState(),
    });
    this.broadcast = new MatchBroadcast(
      this.connections,
      this.actionWindows,
      this.timeBank,
      this.timing,
      this.spectators,
      {
        projectForSeat: (event, seat) =>
          this.snapshots.projectForSeat(event, seat),
        claimSeatSequence: (seat) => this.publisher.claimSeatSequence(seat),
        seatSequence: (seat) => this.publisher.seatSequences()[seat],
        history: () => this.publisher.history(),
        buildRoomState: (seat) => this.roomViews.buildRoomState(seat),
        buildViewerState: () => this.presence.build(this.roster.players()),
      }
    );
    this.snapshots = new SnapshotComposer({
      state: () => this.kernel.view,
      history: () => this.publisher.history(),
      players: () => this.roster.players(),
      seatSequences: () => this.publisher.seatSequences(),
      spectatorSequence: () => this.publisher.spectatorSequence,
      handStartWall: () => this.archiveEvents.wall(),
      duplicateWallEventFields: () => this.details.duplicateWallEventFields(),
      computeSinking: () => this.details.computeSinking(),
      sessionVote: () => {
        const snapshot = this.lifecycle.votes.snapshot();
        if (!snapshot.active || snapshot.deadline === null) {
          return null;
        }
        return {
          deadline: snapshot.deadline,
          votes: copySeatValues(snapshot.votes),
          gameIndex: this.lifecycle.session.snapshot().gameIndex,
        };
      },
      kernel: this.kernel,
      metadata: this.metadata,
      windows: this.actionWindows,
      bank: this.timeBank,
      timing: this.timing,
    });
    this.archive = new GameArchive(
      config.presetId,
      this.runtime,
      this.repository,
      this.kernel,
      this.roster,
      {
        history: () => this.publisher.history(),
        sessionSnapshot: () => this.lifecycle.session.snapshot(),
        currentGameMongoId: () => this.lifecycle.session.currentGameMongoId(),
        supersedeEventJournal: () => this.publisher.supersedeEventJournal(),
      }
    );
    this.checkpoints = new CheckpointFactory({
      config: this.config,
      kernel: this.kernel,
      roster: this.roster,
      connections: this.connections,
      session: this.lifecycle.session,
      calls: this.gameplay.calls,
      ready: this.lifecycle.ready,
      votes: this.lifecycle.votes,
      results: this.lifecycle.results,
      hand: this.lifecycle.hand,
      metadata: this.metadata,
      windows: this.actionWindows,
      bank: this.timeBank,
      timing: this.timing,
      runtime: this.runtime,
      isRelay: () => this.relay.isRelay,
      delayedSpectators: () => this.spectators.delayedSessions(),
      history: () => this.publisher.history(),
      nextSequence: () => this.publisher.nextSequence,
      seatSequences: () => this.publisher.seatSequences(),
      spectatorSequence: () => this.publisher.spectatorSequence,
      handStartWall: () => this.archiveEvents.wall(),
      lastEngineType: () => this.lifecycle.engineEvents.lastType,
    });
    this.installer = new CheckpointInstaller({
      runtime: this.runtime,
      calls: this.gameplay.calls,
      bank: this.timeBank,
      windows: this.actionWindows,
      ready: this.lifecycle.ready,
      votes: this.lifecycle.votes,
      results: this.lifecycle.results,
    });
    this.recovery = new MatchRecovery({
      resumeAutomaticNuki: (opening) => this.gameplay.turns.resumeNuki(opening),
      reportResumeError: (error) => {
        console.error("[game-server] automatic nuki recovery failed", error);
        for (const seat of this.roster.humanSeats()) {
          this.connections.sender(seat)?.({
            type: "error",
            code: "nuki_recovery_failed",
            message:
              "The saved replacement could not be resumed. Reconnect to retry.",
          });
        }
      },
      matchId: config.matchId,
      repository: this.repository,
      runtime: this.runtime,
      eventJournalStore,
      commands: this.commands,
      checkpoints: this.checkpoints,
      installer: this.installer,
      kernel: this.kernel,
      roster: this.roster,
      connections: this.connections,
      session: this.lifecycle.session,
      metadata: this.metadata,
      bank: this.timeBank,
      timing: this.timing,
      publisher: this.publisher,
      archiveEvents: this.archiveEvents,
      engineEvents: this.lifecycle.engineEvents,
      calls: this.gameplay.calls,
      ready: this.lifecycle.ready,
      votes: this.lifecycle.votes,
      results: this.lifecycle.results,
      barrier: this.barrier,
    });
  }

  get isPaused(): boolean {
    return (
      this.recovery.coordinator.paused !== null ||
      this.commands.recoveryRequired
    );
  }

  assertNotPaused(operation: string): void {
    if (this.isPaused || this.recovery.coordinator.saving !== null) {
      throw new Error(`MatchProcess.${operation}: match is paused`);
    }
  }
}
