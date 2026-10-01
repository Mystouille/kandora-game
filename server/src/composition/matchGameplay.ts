import type { LegalAction, Seat } from "~/game/protocol/messages";
import type {
  DiscardSource,
  EngineEvent,
  FuritenChange,
  Tile,
} from "~/game/rules";
import type { PersistedMatchEvent } from "../repository";
import type { MatchRuntime } from "../runtime";
import type {
  ActionWindowKind,
  ActionWindowRegistry,
} from "../timing/actionWindows";
import type { DecisionTiming } from "../timing/decisionTiming";
import type { TimeBank } from "../timing/timeBank";
import { ActionExecutor } from "../session/actionExecutor";
import { CallCoordinator } from "../session/callCoordinator";
import { CallResolution } from "../session/callResolution";
import type { CommandCoordinator } from "../session/commandCoordinator";
import { GameplayEffects } from "../session/gameplayEffects";
import { LegacyDecisions } from "../session/legacyDecisions";
import type { KernelAction, MatchKernel } from "../session/matchKernel";
import type { PlayerConnections } from "../session/playerConnections";
import type { RoomRoster } from "../session/roomRoster";
import type { AutomaticActionContext } from "../session/sessionTypes";
import type { SessionSnapshot } from "../session/sessionCoordinator";
import type { TransitionBarrier } from "../session/transitionBarrier";
import { TurnCoordinator } from "../session/turnCoordinator";

export interface GameplayServices {
  readonly runtime: MatchRuntime;
  readonly kernel: MatchKernel;
  readonly roster: RoomRoster;
  readonly connections: PlayerConnections;
  readonly windows: ActionWindowRegistry;
  readonly bank: TimeBank;
  readonly timing: DecisionTiming;
  readonly commands: CommandCoordinator;
  readonly barrier: TransitionBarrier;
}

export interface GameplayCompositionPort {
  isPaused(): boolean;
  status(): SessionSnapshot["status"];
  history(): readonly PersistedMatchEvent[];
  nextSequence(): number;
  currentGameMongoId(): string;
  emitEngineEvent(event: EngineEvent): Promise<void>;
  emitFuritenChanges(
    changes: readonly FuritenChange[] | undefined
  ): Promise<void>;
  afterHandEnd(): Promise<void>;
  flushLegalsToSeat(seat: Seat): void;
  broadcastRoomState(): void;
  onAutomaticAction?: (context: AutomaticActionContext) => void;
}

/** Wires turn/call/action owners without duplicating their mutable decision state. */
export class MatchGameplay {
  readonly effects: GameplayEffects;
  readonly calls: CallCoordinator;
  readonly callResolution: CallResolution;
  readonly turns: TurnCoordinator;
  readonly actions: ActionExecutor;
  readonly decisions: LegacyDecisions;

  constructor(
    matchId: string,
    services: GameplayServices,
    port: GameplayCompositionPort
  ) {
    const {
      runtime,
      kernel,
      roster,
      connections,
      windows,
      bank,
      timing,
      commands,
      barrier,
    } = services;
    this.effects = new GameplayEffects(kernel, timing, connections, barrier, {
      history: () => port.history(),
      now: () => runtime.now(),
      isCallOpen: (seat) => this.calls.isOpen(seat),
      setLegacyLegals: (seat, actions, kind) =>
        this.decisions.setSeatLegals(seat, actions, kind),
      consumeLegacyBuffer: (seat) => this.decisions.consumeActionBuffer(seat),
      emitEngineEvent: (event) => port.emitEngineEvent(event),
      emitFuritenChanges: (changes) => port.emitFuritenChanges(changes),
    });
    const kernelEffects = {
      applyEngineAction: (action: KernelAction) =>
        this.effects.applyEngineAction(action),
      applyDiscard: (seat: Seat, tile: Tile, source?: DiscardSource) =>
        this.effects.applyDiscard(seat, tile, source),
    };
    const decisionEffects = {
      isHumanSeat: (seat: Seat) => roster.isHumanSeat(seat),
      setSeatLegals: (
        seat: Seat,
        actions: LegalAction[],
        kind?: ActionWindowKind
      ) => this.effects.setSeatLegals(seat, actions, kind),
      flushLegalsToSeat: (seat: Seat) => port.flushLegalsToSeat(seat),
    };
    const callEffects = {
      ...decisionEffects,
      applyEngineAction: kernelEffects.applyEngineAction,
      waitForWinReaction: (trigger: "draw" | "discard" | "call") =>
        this.effects.waitForWinReaction(trigger),
      advanceTurn: () => this.turns.advanceTurn(),
      afterHandEnd: () => port.afterHandEnd(),
      afterCall: () => this.turns.afterCall(),
    };
    this.calls = new CallCoordinator(kernel, callEffects);
    this.callResolution = new CallResolution(kernel, callEffects);
    this.turns = new TurnCoordinator(kernel, windows, {
      ...kernelEffects,
      ...decisionEffects,
      emitEngineEvent: (event) => port.emitEngineEvent(event),
      emitFuritenChanges: (changes) => port.emitFuritenChanges(changes),
      afterDiscard: () => this.calls.afterDiscard(),
      openChankanWindow: () => this.calls.openChankanWindow(),
      afterHandEnd: () => port.afterHandEnd(),
      runUncheckpointableTransition: (kind, delay) => barrier.run(kind, delay),
    });
    this.actions = new ActionExecutor(kernel, roster, connections, windows, {
      ...kernelEffects,
      ...decisionEffects,
      isPaused: () => port.isPaused(),
      isCallOpen: (seat) => this.calls.isOpen(seat),
      status: () => port.status(),
      consumeActionBuffer: (seat) => this.effects.consumeActionBuffer(seat),
      resolveCallWindow: (seat, action) =>
        this.calls.resolveCallWindow(seat, action),
      continueRyuukyokuDeclarations: () =>
        this.turns.continueRyuukyokuDeclarations(),
      afterDiscard: () => this.calls.afterDiscard(),
      afterCall: () => this.turns.afterCall(),
      openChankanWindow: () => this.calls.openChankanWindow(),
      afterHandEnd: () => port.afterHandEnd(),
      waitForWinReaction: (trigger) => this.effects.waitForWinReaction(trigger),
      pickImmediateAfkDefaultActionId: (seat) =>
        this.decisions.pickImmediateAfkDefaultActionId(seat),
      reportAutomaticAction: (seat, action, reason) =>
        this.decisions.reportAutomaticAction(seat, action, reason),
      broadcastRoomState: () => port.broadcastRoomState(),
    });
    this.decisions = new LegacyDecisions(
      matchId,
      runtime,
      windows,
      bank,
      connections,
      commands,
      {
        state: () => kernel.currentState(),
        isPaused: () => port.isPaused(),
        isHumanSeat: decisionEffects.isHumanSeat,
        isCallOpen: (seat) => this.calls.isOpen(seat),
        currentGameMongoId: () => port.currentGameMongoId(),
        nextSequence: () => port.nextSequence(),
        handleActDirect: (seat, action) =>
          this.actions.handleActDirect(seat, action),
        runUncheckpointableTransition: (kind, delay) =>
          barrier.run(kind, delay),
        onAutomaticAction: port.onAutomaticAction,
      }
    );
  }
}
