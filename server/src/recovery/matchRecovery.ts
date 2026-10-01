import { parseMatchCheckpoint, type MatchCheckpoint } from "../checkpoint";
import type { MatchProcessDependencies } from "../composition/dependencies";
import type { MatchEventJournalStore, MatchRepository } from "../repository";
import { runtimeCalendarNow, type MatchRuntime } from "../runtime";
import type { ArchiveEventComposer } from "../session/archiveEventComposer";
import type { CallCoordinator } from "../session/callCoordinator";
import type { CommandCoordinator } from "../session/commandCoordinator";
import type { ContinueVote } from "../session/continueVote";
import type { EngineEventPresenter } from "../session/engineEventPresenter";
import type { MatchEventPublisher } from "../session/eventPublisher";
import type { HandMetadata } from "../session/handMetadata";
import type { MatchKernel } from "../session/matchKernel";
import type { PlayerConnections } from "../session/playerConnections";
import type { ReadyCheck } from "../session/readyCheck";
import { RecoveryCoordinator } from "../session/recoveryCoordinator";
import type { ResultTransition } from "../session/resultTransition";
import type { RoomRoster } from "../session/roomRoster";
import type { SessionCoordinator } from "../session/sessionCoordinator";
import type { TransitionBarrier } from "../session/transitionBarrier";
import type { DecisionTiming } from "../timing/decisionTiming";
import type { TimeBank } from "../timing/timeBank";
import type { CheckpointFactory } from "./checkpointFactory";
import type { CheckpointInstaller } from "./checkpointInstaller";

export interface MatchRecoveryPort {
  readonly matchId: string;
  readonly repository: MatchRepository;
  readonly runtime: Pick<
    MatchRuntime,
    "now" | "wallNow" | "restoreRandomState"
  >;
  readonly eventJournalStore: MatchEventJournalStore | null;
  readonly commands: CommandCoordinator;
  readonly checkpoints: CheckpointFactory;
  readonly installer: CheckpointInstaller;
  readonly kernel: Pick<
    MatchKernel,
    "restore" | "restoreDriver" | "restoreDebugQueues"
  >;
  readonly roster: Pick<RoomRoster, "restore">;
  readonly connections: Pick<PlayerConnections, "restorePolicy">;
  readonly session: Pick<
    SessionCoordinator,
    "snapshot" | "restore" | "currentGameMongoId"
  >;
  readonly metadata: Pick<HandMetadata, "restore">;
  readonly bank: Pick<TimeBank, "restore">;
  readonly timing: Pick<DecisionTiming, "restoreEvent"> & {
    restore(
      saved: ReturnType<DecisionTiming["capture"]>,
      savedAt: number,
      restoredAt?: number
    ): void;
  };
  readonly publisher: MatchEventPublisher;
  readonly archiveEvents: Pick<ArchiveEventComposer, "restoreWall">;
  readonly engineEvents: Pick<EngineEventPresenter, "restoreLastType">;
  readonly calls: Pick<CallCoordinator, "snapshot">;
  readonly ready: Pick<ReadyCheck, "snapshot">;
  readonly votes: Pick<ContinueVote, "snapshot">;
  readonly results: Pick<ResultTransition, "snapshot">;
  readonly barrier: Pick<TransitionBarrier, "kind">;
}

export class MatchRecovery {
  readonly coordinator: RecoveryCoordinator;

  constructor(private readonly port: MatchRecoveryPort) {
    this.coordinator = new RecoveryCoordinator({
      matchId: port.matchId,
      commands: port.commands,
      repository: port.repository,
      capture: () => this.createCheckpoint(),
      cancelTimers: (checkpoint) => port.installer.cancelTimers(checkpoint),
      resume: (checkpoint) => this.resumeCheckpoint(checkpoint),
      flushJournal: () => port.publisher.journal?.flush() ?? null,
    });
  }

  createCheckpoint(): MatchCheckpoint {
    if (this.coordinator.paused !== null) {
      return parseMatchCheckpoint(
        JSON.parse(JSON.stringify(this.coordinator.paused))
      );
    }
    if (this.port.commands.recoveryRequired) {
      throw new Error(
        "MatchProcess.createCheckpoint: pending command must be recovered from durable pre-state"
      );
    }
    const status = this.port.session.snapshot().status;
    if (status === "waiting") {
      return this.port.checkpoints.createWaitingRoomCheckpoint();
    }
    if (status === "playing") {
      if (this.port.commands.automaticInFlight) {
        this.port.checkpoints.checkpointUnsupported(
          "automatic default action is in flight"
        );
      }
      if (this.port.barrier.kind !== null) {
        this.port.checkpoints.checkpointUnsupported(
          `transition ${this.port.barrier.kind}`
        );
      }
      if (this.port.results.snapshot().active) {
        return this.port.checkpoints.createPlayingResultTransitionCheckpoint();
      }
      if (this.port.votes.snapshot().active) {
        return this.port.checkpoints.createPlayingContinueVoteCheckpoint();
      }
      if (this.port.ready.snapshot().active) {
        return this.port.checkpoints.createPlayingReadyCheckpoint();
      }
      if (
        this.port.calls.snapshot().callWindows.some((window) => window !== null)
      ) {
        return this.port.checkpoints.createPlayingCallCheckpoint();
      }
      return this.port.checkpoints.createPlayingActionCheckpoint();
    }
    throw new Error(
      `MatchProcess.createCheckpoint: status "${status}" is not supported`
    );
  }

  resumeCheckpoint(
    checkpoint: MatchCheckpoint,
    restoredContinuation = false,
    restoredAt = this.port.runtime.now()
  ): void {
    this.coordinator.clearPause();
    if (checkpoint.status === "playing") {
      this.port.installer.install(checkpoint, restoredContinuation, restoredAt);
      this.restoreDecisionTiming(checkpoint, restoredAt);
    }
  }

  private restoreDecisionTiming(
    checkpoint: MatchCheckpoint,
    restoredAt: number
  ): void {
    const saved = checkpoint.decisionTiming;
    if (!saved) {
      return;
    }
    const fixedPromptsInstalled =
      checkpoint.status === "playing" &&
      (checkpoint.checkpointKind === "ready_check" ||
        checkpoint.checkpointKind === "continue_vote");
    this.port.timing.restore(
      fixedPromptsInstalled ? { ...saved, prompts: undefined } : saved,
      checkpoint.savedAt,
      restoredAt
    );
  }

  restoreCheckpoint(
    checkpoint: MatchCheckpoint,
    restoredAt = this.port.runtime.now()
  ): void {
    if (checkpoint.status === "waiting") {
      this.port.kernel.restoreDriver(checkpoint.driver, checkpoint.ruleSet);
      this.port.roster.restore(checkpoint.seats, checkpoint.ready);
      this.restoreDecisionTiming(checkpoint, restoredAt);
      return;
    }
    this.port.kernel.restore(checkpoint.state, checkpoint.driver);
    this.port.runtime.restoreRandomState(checkpoint.randomState);
    for (const entry of checkpoint.eventLog) {
      this.port.publisher.restoreEntry({
        seq: entry.seq,
        event: entry.event,
        emittedAt: restoredAt - entry.emittedAgoMs,
        ...(entry.calendarAt !== undefined
          ? { calendarAt: entry.calendarAt }
          : {}),
      });
      this.port.timing.restoreEvent(
        entry.event,
        entry.seq,
        restoredAt - entry.emittedAgoMs
      );
    }
    this.port.publisher.restoreNextSequence(checkpoint.nextSeq);
    this.port.publisher.restoreSeatSequences([...checkpoint.seatSeq]);
    this.port.publisher.restoreSpectatorSequence(checkpoint.spectatorSeq);
    this.port.archiveEvents.restoreWall(
      checkpoint.handStartLiveWall ? [...checkpoint.handStartLiveWall] : null
    );
    this.port.session.restore({
      status: "playing",
      startedAt: new Date(
        checkpoint.startedCalendarAt ??
          (this.port.runtime.wallNow === undefined
            ? restoredAt
            : runtimeCalendarNow(this.port.runtime)) - checkpoint.startedAgoMs
      ),
      startedReferenceAt: restoredAt - checkpoint.startedAgoMs,
      finalized: false,
      gameIndex: checkpoint.gameIndex,
      gameStartLogIdx: checkpoint.gameStartLogIdx,
      sessionChips: [...checkpoint.sessionChips],
      gameStartChips: [...checkpoint.gameStartChips],
      sessionDabuken: [...checkpoint.sessionDabuken],
      sessionFinalized: false,
      pendingSessionEndReason: null,
    });
    this.port.metadata.restore({
      dice: [...checkpoint.dice],
      riichiTileIdx: [...checkpoint.riichiTileIdx],
    });
    this.port.kernel.restoreDebugQueues(
      checkpoint.humanDrawQueue,
      checkpoint.leftDiscardQueue
    );
    this.port.bank.restore(checkpoint.bufferMs);
    this.port.engineEvents.restoreLastType(checkpoint.lastEngineEventType);
    this.port.connections.restorePolicy(checkpoint.connectionPolicy);
    this.port.installer.install(checkpoint, true, restoredAt);
    this.restoreDecisionTiming(checkpoint, restoredAt);
  }

  async restoreEventJournal(): Promise<void> {
    if (
      this.port.eventJournalStore === null ||
      this.port.session.snapshot().status !== "playing"
    ) {
      return;
    }
    const matchId = this.port.session.currentGameMongoId();
    const stored =
      await this.port.eventJournalStore.loadMatchEventJournalState(matchId);
    if (stored === null || stored.status !== "playing") {
      return;
    }
    if (
      stored.nextSeq < this.port.session.snapshot().gameStartLogIdx ||
      stored.nextSeq > this.port.publisher.nextSequence
    ) {
      throw new Error(
        `MatchProcess.restoreEventJournal: invalid durable seq ${stored.nextSeq}`
      );
    }
    this.port.publisher.openEventJournal(matchId, stored.nextSeq);
    for (
      let seq = stored.nextSeq;
      seq < this.port.publisher.nextSequence;
      seq += 1
    ) {
      this.port.publisher.journal?.record(seq);
    }
  }

  async persistLegacyCommandRecovery(): Promise<void> {
    if (
      !this.port.commands.legacyRecoveryInProgress ||
      this.port.session.snapshot().status === "finished"
    ) {
      return;
    }
    const checkpoint = this.createCheckpoint();
    this.coordinator.freeze(checkpoint);
    try {
      await this.port.publisher.journal?.flush();
      await this.port.repository.saveCheckpoint({
        matchId: this.port.matchId,
        checkpoint,
      });
      this.port.commands.clearLegacyRecovery();
      this.resumeCheckpoint(checkpoint);
    } catch (error) {
      this.resumeCheckpoint(checkpoint);
      throw error;
    }
  }
}

interface RestoredMatch {
  readonly owners: {
    readonly recovery: Pick<MatchRecovery, "restoreEventJournal">;
    readonly commands: Pick<CommandCoordinator, "restorePendingCommand">;
  };
}

export async function restoreSavedMatch<Match extends RestoredMatch>(
  matchId: string,
  dependencies: MatchProcessDependencies,
  restore: (
    checkpoint: MatchCheckpoint,
    dependencies: MatchProcessDependencies
  ) => Match
): Promise<Match | null> {
  const recovery = await dependencies.repository.loadRecoveryRecord(matchId);
  if (recovery === null) {
    return null;
  }
  if (recovery.checkpoint.matchId !== matchId) {
    throw new Error(
      `MatchProcess.restoreSavedCheckpoint: expected ${matchId}, got ${recovery.checkpoint.matchId}`
    );
  }
  const match = restore(recovery.checkpoint, dependencies);
  await match.owners.recovery.restoreEventJournal();
  if (recovery.pendingCommand !== null) {
    await match.owners.commands.restorePendingCommand(recovery.pendingCommand);
  }
  return match;
}
