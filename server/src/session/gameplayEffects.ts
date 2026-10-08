import type { LegalAction, Seat } from "~/game/protocol/messages";
import type {
  DiscardSource,
  EngineEvent,
  FuritenChange,
  Tile,
} from "~/game/rules";
import type { PersistedMatchEvent } from "../repository";
import type { ActionWindowKind } from "../timing/actionWindows";
import type { DecisionTiming } from "../timing/decisionTiming";
import { gameTiming, remainingWinReactionDelayMs } from "./timingPolicy";
import type { KernelAction, MatchKernel, MatchStateView } from "./matchKernel";
import type { PlayerConnections } from "./playerConnections";
import type { TransitionBarrier, TransitionKind } from "./transitionBarrier";

export interface GameplayEffectsPort {
  history(): readonly PersistedMatchEvent[];
  now(): number;
  isCallOpen(seat: Seat): boolean;
  emitEngineEvent(event: EngineEvent): Promise<void>;
  emitFuritenChanges(
    changes: readonly FuritenChange[] | undefined
  ): Promise<void>;
}

/** Orders kernel effects and decision policy; state remains in the existing owners. */
export class GameplayEffects {
  constructor(
    private readonly kernel: MatchKernel,
    private readonly timing: DecisionTiming,
    private readonly connections: PlayerConnections,
    private readonly barrier: TransitionBarrier,
    private readonly port: GameplayEffectsPort
  ) {}

  async applyEngineAction(action: KernelAction): Promise<MatchStateView> {
    const result = this.kernel.applyAction(action);
    for (const event of result.events) {
      await this.port.emitEngineEvent(event);
    }
    await this.port.emitFuritenChanges(result.furitenChanges);
    return result.state;
  }

  async applyDiscard(
    seat: Seat,
    tile: Tile,
    source?: DiscardSource
  ): Promise<void> {
    const result = this.kernel.discard(seat, tile, source);
    this.setSeatLegals(seat, []);
    for (const event of result.events) {
      await this.port.emitEngineEvent(event);
    }
    await this.port.emitFuritenChanges(result.furitenChanges);
  }

  setSeatLegals(
    seat: Seat,
    actions: LegalAction[],
    kind: ActionWindowKind = "turn"
  ): void {
    this.timing.open(
      seat,
      actions,
      kind,
      {
        baseMs: gameTiming.BASE_ACTION_MS,
        graceMs: gameTiming.ACTION_GRACE_MS,
        declarationMs: gameTiming.RYUUKYOKU_DECLARATION_ACTION_MS,
        automatedMs: gameTiming.DRAW_TO_DISCARD_DELAY_MS,
      },
      this.connections.view(seat).disconnected,
      this.port.isCallOpen(seat)
    );
  }

  consumeActionBuffer(seat: Seat): void {
    this.timing.consume(seat);
  }

  async waitForWinReaction(
    trigger: "draw" | "discard" | "call"
  ): Promise<void> {
    await this.waitForEventAge(
      trigger,
      gameTiming.WIN_REACTION_DELAY_MS,
      "win_reaction"
    );
  }

  async waitForEventAge(
    trigger: "draw" | "discard" | "call",
    minimumAgeMs: number,
    transition: TransitionKind
  ): Promise<void> {
    if (minimumAgeMs <= 0) {
      return;
    }
    const history = this.port.history();
    let triggerEmittedAt: number | null = null;
    for (let index = history.length - 1; index >= 0; index--) {
      const entry = history[index];
      if (
        entry.event.type === trigger ||
        (trigger === "call" &&
          entry.event.type === "nuki" &&
          (entry.event.stage === "declared" || entry.event.tile !== "4z"))
      ) {
        triggerEmittedAt = entry.emittedAt;
        break;
      }
    }
    const remaining =
      triggerEmittedAt === null
        ? minimumAgeMs
        : remainingWinReactionDelayMs(
            triggerEmittedAt,
            this.port.now(),
            minimumAgeMs
          );
    if (remaining > 0) {
      await this.barrier.run(transition, remaining);
    }
  }
}
