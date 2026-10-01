import type { LegalAction, Seat, Tile } from "~/game/protocol/messages";
import type { DiscardSource } from "~/game/rules";
import type { ActionWindowKind } from "../timing/actionWindows";
import type { KernelAction, MatchStateView } from "./matchKernel";
import type { TransitionKind } from "./transitionBarrier";

export interface KernelEffectsPort {
  applyEngineAction(action: KernelAction): Promise<MatchStateView>;
  applyDiscard(seat: Seat, tile: Tile, source?: DiscardSource): Promise<void>;
}

export interface DecisionEffectsPort {
  isHumanSeat(seat: Seat): boolean;
  setSeatLegals(
    seat: Seat,
    actions: LegalAction[],
    kind?: ActionWindowKind
  ): void;
  flushLegalsToSeat(seat: Seat): void;
}

export interface CallResolutionPort extends Pick<
  KernelEffectsPort,
  "applyEngineAction"
> {
  waitForWinReaction(trigger: "draw" | "discard" | "call"): Promise<void>;
  advanceTurn(): Promise<void>;
  afterHandEnd(): Promise<void>;
  afterCall(): Promise<void>;
}

export interface CallWorkflowPort
  extends DecisionEffectsPort, CallResolutionPort {}

export interface TurnWorkflowPort
  extends KernelEffectsPort, DecisionEffectsPort {
  emitEngineEvent(event: import("~/game/rules").EngineEvent): Promise<void>;
  emitFuritenChanges(
    changes: readonly import("~/game/rules").FuritenChange[] | undefined
  ): Promise<void>;
  afterDiscard(): Promise<void>;
  openChankanWindow(): Promise<void>;
  afterHandEnd(): Promise<void>;
  runUncheckpointableTransition(
    kind: TransitionKind,
    delayMs: number
  ): Promise<void>;
}

export interface ActionExecutionPort
  extends KernelEffectsPort, DecisionEffectsPort {
  isPaused(): boolean;
  isCallOpen(seat: Seat): boolean;
  status(): "waiting" | "playing" | "finished";
  consumeActionBuffer(seat: Seat): void;
  resolveCallWindow(seat: Seat, action: LegalAction): Promise<void>;
  continueRyuukyokuDeclarations(): Promise<void>;
  afterDiscard(): Promise<void>;
  afterCall(): Promise<void>;
  openChankanWindow(): Promise<void>;
  afterHandEnd(): Promise<void>;
  waitForWinReaction(trigger: "draw" | "discard" | "call"): Promise<void>;
  pickImmediateAfkDefaultActionId(seat: Seat): string | null;
  reportAutomaticAction(
    seat: Seat,
    actionId: string,
    reason: "deadline" | "disconnected" | "afk"
  ): void;
  broadcastRoomState(): void;
}
