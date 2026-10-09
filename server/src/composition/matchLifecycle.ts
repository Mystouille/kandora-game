import type { GameEvent } from "~/game/protocol/messages";
import type { ReadonlySeatValues } from "~/game/protocol/seat";
import type { Seat } from "~/game/protocol/messages";
import { seatValues } from "~/game/rules/seats";
import type { MatchRepository } from "../repository";
import type { MatchRuntime } from "../runtime";
import type { ActionWindowRegistry } from "../timing/actionWindows";
import type { TimeBank } from "../timing/timeBank";
import type { PromptTimingService } from "../timing/promptWindows";
import type { CommandCoordinator } from "../session/commandCoordinator";
import { ContinueVote } from "../session/continueVote";
import { EngineEventPresenter } from "../session/engineEventPresenter";
import type { GameplayEffects } from "../session/gameplayEffects";
import { HandLifecycle } from "../session/handLifecycle";
import type { HandMetadata } from "../session/handMetadata";
import { gameTiming } from "../session/timingPolicy";
import type { MatchKernel } from "../session/matchKernel";
import type { MatchViewDetails } from "../session/matchViewDetails";
import type { PlayerConnections } from "../session/playerConnections";
import { ReadyCheck } from "../session/readyCheck";
import { ResultTransition } from "../session/resultTransition";
import type { RoomRoster } from "../session/roomRoster";
import { SessionCoordinator } from "../session/sessionCoordinator";
import type { FinalScore, MatchConfiguration } from "../session/sessionTypes";
import type { TransitionKind } from "../session/transitionBarrier";

export interface LifecycleServices {
  readonly runtime: MatchRuntime;
  readonly repository: MatchRepository;
  readonly kernel: MatchKernel;
  readonly roster: RoomRoster;
  readonly connections: PlayerConnections;
  readonly commands: CommandCoordinator;
  readonly bank: TimeBank;
  readonly windows: ActionWindowRegistry;
  readonly metadata: HandMetadata;
  readonly details: MatchViewDetails;
  readonly effects: GameplayEffects;
  readonly promptTiming?: PromptTimingService;
}

export interface LifecycleCompositionPort {
  isPaused(): boolean;
  assertNotPaused(operation: string): void;
  emitEvent(event: GameEvent): Promise<void>;
  eventCount(): number;
  openEventJournal(gameId: string, seq: number): void;
  archiveCurrentGame(scores: FinalScore[]): Promise<void>;
  broadcastRoomState(): void;
  permuteSeats(permutation: ReadonlySeatValues<Seat>): void;
  advanceTurn(): Promise<void>;
  resetCallState(): void;
  runTransition(kind: TransitionKind, delayMs: number): Promise<void>;
}

/** Composition only: ready, results, votes, hand and session keep their state. */
export class MatchLifecycle {
  readonly ready: ReadyCheck;
  readonly results: ResultTransition;
  readonly votes: ContinueVote;
  readonly hand: HandLifecycle;
  readonly session: SessionCoordinator;
  readonly engineEvents: EngineEventPresenter;

  constructor(
    config: MatchConfiguration,
    services: LifecycleServices,
    port: LifecycleCompositionPort
  ) {
    const {
      runtime,
      repository,
      kernel,
      roster,
      connections,
      commands,
      bank,
      windows,
      metadata,
      details,
      effects,
      promptTiming,
    } = services;
    this.ready = new ReadyCheck(
      runtime,
      roster,
      commands,
      {
        isPaused: () => port.isPaused(),
        humanSeats: () => roster.humanSeats(),
        sender: (seat) => connections.sender(seat),
        resumeReadyContinuation: (kind) =>
          this.hand.resumeReadyContinuation(kind),
      },
      promptTiming
    );
    this.results = new ResultTransition(runtime, commands, {
      isPaused: () => port.isPaused(),
      resumeResultTransition: (kind, nextReadyMs) =>
        this.hand.resumeResultTransition(kind, nextReadyMs),
    });
    this.votes = new ContinueVote(
      runtime,
      roster,
      connections,
      commands,
      {
        isPaused: () => port.isPaused(),
        emitEvent: (event) => port.emitEvent(event),
        gameIndex: () => this.session.snapshot().gameIndex,
        gameFinalized: () => this.session.markGameFinalized(),
        continueAfterVote: (cont, scores) =>
          this.session.continueAfterVote(cont, scores),
      },
      promptTiming
    );
    this.hand = new HandLifecycle(kernel, {
      applyEngineAction: (action) => effects.applyEngineAction(action),
      emitEvent: (event) => port.emitEvent(event),
      emitEngineEvent: (event) => this.engineEvents.emitEngineEvent(event),
      emitFuritenChanges: (changes) =>
        this.engineEvents.emitFuritenChanges(changes),
      advanceTurn: () => port.advanceTurn(),
      endMatch: (reason, options) => this.session.endMatch(reason, options),
      gameIndex: () => this.session.snapshot().gameIndex,
      gameFinalized: () => this.session.snapshot().finalized,
      resetCallState: () => port.resetCallState(),
      clearLegals: (seat) => effects.setSeatLegals(seat, []),
      runReadyCheck: (ms, kind) => this.ready.runReadyCheck(ms, kind),
      runResultTransition: (kind, delay, nextReadyMs) =>
        this.results.runResultTransition(kind, delay, nextReadyMs),
      computeSinking: () => details.computeSinking(),
      rollDice: () => metadata.rollDice(),
      duplicateWallEventFields: () => details.duplicateWallEventFields(),
    });
    this.session = new SessionCoordinator(
      config,
      runtime,
      repository,
      kernel,
      roster,
      {
        assertNotPaused: (operation) => port.assertNotPaused(operation),
        isPaused: () => port.isPaused(),
        emitEvent: (event) => port.emitEvent(event),
        eventCount: () => port.eventCount(),
        openEventJournal: (gameId, seq) => port.openEventJournal(gameId, seq),
        broadcastRoomState: () => port.broadcastRoomState(),
        archiveCurrentGame: (scores) => port.archiveCurrentGame(scores),
        runReadyCheck: (ms, kind) => this.ready.runReadyCheck(ms, kind),
        beginInitialHandAfterReady: () =>
          this.hand.beginInitialHandAfterReady(),
        runContinueVote: (scores) => this.votes.runContinueVote(scores),
        lastVoteReason: () => this.votes.snapshot().lastVoteReason,
        runUncheckpointableTransition: (kind, delay) =>
          port.runTransition(kind, delay),
        resetCallState: () => port.resetCallState(),
        resetRiichiTiles: () => metadata.resetRiichiTiles(),
        refillBank: () => bank.refill(gameTiming.INITIAL_BUFFER_MS),
        clearLegals: (seat) => effects.setSeatLegals(seat, []),
        cancelReadyTimer: () => this.ready.cancelTimer(),
        cancelActionTimers: () => windows.cancelAllTimers(),
        hasContinueVote: () => this.votes.snapshot().active,
        finishContinueVote: (cont) => this.votes.finishContinueVote(cont),
      }
    );
    this.engineEvents = new EngineEventPresenter({
      state: () => kernel.view,
      metadata,
      hand: this.hand,
      bank,
      emitEvent: (event) => port.emitEvent(event),
      waitForEventAge: (trigger, age, transition) =>
        effects.waitForEventAge(trigger, age, transition),
      runReadyCheck: (ms) => this.ready.runReadyCheck(ms),
      runUncheckpointableTransition: (kind, delay) =>
        port.runTransition(kind, delay),
      duplicateWallEventFields: () => details.duplicateWallEventFields(),
      computeSinking: () => details.computeSinking(),
      permuteSeats: (permutation) => port.permuteSeats(permutation),
      seatNames: () =>
        seatValues(
          roster.playerCount,
          (seat) => roster.player(seat)?.displayName ?? ""
        ),
      rollDice: () => metadata.rollDice(),
      endMatch: (reason, options) => this.session.endMatch(reason, options),
    });
  }
}
