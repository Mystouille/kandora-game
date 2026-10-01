import type { Seat } from "~/game/protocol/messages";

import { ActionWindowRegistry } from "../timing/actionWindows";

import { TimeBank } from "../timing/timeBank";

import type { MatchRuntime } from "../runtime";

import { PlayerConnections } from "./playerConnections";

import { CommandCoordinator } from "./commandCoordinator";

import type { MatchStateView } from "./matchKernel";

import type { TransitionKind } from "./transitionBarrier";

import type { AutomaticActionContext } from "./sessionTypes";

import { gameTiming } from "./timingPolicy";

export interface MatchDecisionPort {
  state(): MatchStateView;
  isPaused(): boolean;
  isHumanSeat(seat: Seat): boolean;
  isCallOpen(seat: Seat): boolean;
  currentGameMongoId(): string;
  nextSequence(): number;
  handleActDirect(seat: Seat, actionId: string): Promise<void>;
  runUncheckpointableTransition(
    kind: TransitionKind,
    delayMs: number
  ): Promise<void>;
  onAutomaticAction?: (context: AutomaticActionContext) => void;
}

export class MatchDecisions {
  constructor(
    private readonly matchId: string,
    private readonly runtime: MatchRuntime,
    private readonly actionWindows: ActionWindowRegistry,
    private readonly timeBank: TimeBank,
    private readonly connections: PlayerConnections,
    private readonly commands: CommandCoordinator,
    private readonly port: MatchDecisionPort
  ) {}

  async handleDeadlineExpiry(
    seat: Seat,
    generation = this.actionWindows.view(seat).generation
  ): Promise<void> {
    if (
      this.actionWindows.view(seat).generation !== generation ||
      this.actionWindows.hasReservedInput(seat)
    ) {
      return;
    }
    const activeTransaction = this.commands.transaction;
    if (activeTransaction !== null) {
      try {
        await activeTransaction;
      } catch {}
      if (!this.port.isPaused()) {
        await this.handleDeadlineExpiry(seat, generation);
      }
      return;
    }
    const activeAutomaticDefault = this.commands.automatic;
    if (activeAutomaticDefault !== null) {
      try {
        await activeAutomaticDefault;
      } catch {}
      if (!this.port.isPaused()) {
        await this.handleDeadlineExpiry(seat, generation);
      }
      return;
    }
    if (this.port.isPaused()) {
      return;
    }

    const isRyuukyokuDeclaration =
      this.actionWindows.view(seat).kind === "ryuukyoku_declaration";
    const isHuman = this.port.isHumanSeat(seat);
    if (
      !isRyuukyokuDeclaration &&
      isHuman &&
      this.timeBank.balance(seat) === 0 &&
      this.connections.canProbe(seat)
    ) {
      await this.connections.probe(seat);
    }
    if (this.port.isPaused()) {
      return;
    }
    const automaticAfterProbe = this.commands.automatic;
    if (automaticAfterProbe !== null) {
      try {
        await automaticAfterProbe;
      } catch {}
      if (!this.port.isPaused()) {
        await this.handleDeadlineExpiry(seat, generation);
      }
      return;
    }
    if (
      this.actionWindows.view(seat).generation !== generation ||
      this.actionWindows.hasReservedInput(seat)
    ) {
      return;
    }
    const actionId = this.pickDefaultActionId(seat);
    if (actionId === null) {
      return;
    }
    this.reportAutomaticAction(
      seat,
      actionId,
      this.connections.view(seat).disconnected ? "disconnected" : "deadline"
    );
    await this.commands.runAutomaticDefault(async () => {
      if (
        isRyuukyokuDeclaration &&
        gameTiming.RYUUKYOKU_AUTOMATIC_DECLARATION_DELAY_MS > 0
      ) {
        await this.port.runUncheckpointableTransition(
          "ryuukyoku_declaration_pacing",
          gameTiming.RYUUKYOKU_AUTOMATIC_DECLARATION_DELAY_MS
        );
      }
      await this.port.handleActDirect(seat, actionId);
    });
  }

  pickDefaultActionId(seat: Seat): string | null {
    const legals = this.actionWindows.legals(seat);
    if (legals.length === 0) {
      return null;
    }
    if (this.port.isCallOpen(seat)) {
      const pass = legals.find((a) => a.type === "pass");
      return pass ? pass.id : null;
    }
    if (this.actionWindows.view(seat).kind === "ryuukyoku_declaration") {
      return (
        legals.find((action) => action.type === "declare_tenpai")?.id ?? null
      );
    }
    const drawn = this.port.state().lastDrawn[seat];
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

  pickImmediateAfkDefaultActionId(seat: Seat): string | null {
    if (this.actionWindows.view(seat).kind === "ryuukyoku_declaration") {
      return null;
    }
    return this.pickDefaultActionId(seat);
  }

  reportAutomaticAction(
    seat: Seat,
    actionId: string,
    reason: AutomaticActionContext["reason"]
  ): void {
    const actionStartedAt = this.actionWindows.view(seat).startedAt;
    this.port.onAutomaticAction?.({
      matchId: this.matchId,
      gameId: this.port.currentGameMongoId(),
      seat,
      actionId,
      reason,
      nextSeq: this.port.nextSequence(),
      bufferMs: this.timeBank.balance(seat),
      actionWindowElapsedMs:
        actionStartedAt === null
          ? null
          : Math.max(0, this.runtime.now() - actionStartedAt),
    });
  }
}
