import type { Seat } from "~/game/protocol/messages";

import { MatchKernel } from "./matchKernel";

import { RoomRoster } from "./roomRoster";

import { PlayerConnections } from "./playerConnections";

import { ActionWindowRegistry } from "../timing/actionWindows";

import type { ActionExecutionPort } from "./workflowPorts";

export class ActionExecutor {
  constructor(
    private readonly kernel: MatchKernel,
    private readonly roster: RoomRoster,
    private readonly connections: PlayerConnections,
    private readonly windows: ActionWindowRegistry,
    private readonly port: ActionExecutionPort
  ) {}

  isAcceptedAction(seat: Seat, actionId: string): boolean {
    if (
      this.kernel.currentState().phase === "hand_ended" ||
      this.kernel.currentState().phase === "match_ended"
    ) {
      return false;
    }
    if (this.port.isCallOpen(seat)) {
      return this.windows.legals(seat).some((action) => action.id === actionId);
    }
    return (
      seat === this.kernel.currentState().turn &&
      this.windows.legals(seat).some((action) => action.id === actionId)
    );
  }

  async handleActDirect(seat: Seat, actionId: string): Promise<void> {
    if (this.port.isPaused()) {
      return;
    }
    if (
      this.kernel.currentState().phase === "hand_ended" ||
      this.kernel.currentState().phase === "match_ended"
    ) {
      return;
    }

    this.connections.recordAction(seat);

    if (this.port.isHumanSeat(seat)) {
      this.port.consumeActionBuffer(seat);
    }

    if (this.port.isCallOpen(seat)) {
      const action = this.windows.legals(seat).find((a) => a.id === actionId);
      if (!action) {
        return;
      }
      await this.port.resolveCallWindow(seat, action);
      return;
    }
    if (seat !== this.kernel.currentState().turn) {
      return;
    }
    const action = this.windows.legals(seat).find((a) => a.id === actionId);
    if (!action) {
      return;
    }
    if (action.type === "declare_tenpai" || action.type === "declare_noten") {
      this.port.setSeatLegals(seat, []);
      await this.port.applyEngineAction({
        type: "declare_ryuukyoku_status",
        seat,
        tenpai: action.type === "declare_tenpai",
      });
      await this.port.continueRyuukyokuDeclarations();
      return;
    }
    if (action.type === "discard" && action.tile) {
      await this.port.applyDiscard(seat, action.tile, action.discardSource);
      await this.port.afterDiscard();
      return;
    }

    if (
      action.type === "kan" &&
      action.kanKind === "ankan" &&
      action.tiles &&
      action.tiles[0]
    ) {
      this.port.setSeatLegals(seat, []);
      await this.port.applyEngineAction({
        type: "kan",
        seat,
        kind: "ankan",
        tile: action.tiles[0],
      });
      await this.port.afterCall();
      return;
    }
    if (
      action.type === "kan" &&
      action.kanKind === "shouminkan" &&
      action.tiles &&
      action.tiles[0]
    ) {
      this.port.setSeatLegals(seat, []);
      await this.port.applyEngineAction({
        type: "kan",
        seat,
        kind: "shouminkan",
        tile: action.tiles[0],
      });

      await this.port.openChankanWindow();
      return;
    }
    if (action.type === "tsumo") {
      await this.port.waitForWinReaction("draw");
      await this.port.applyEngineAction({ type: "tsumo", seat });
      await this.port.afterHandEnd();
      return;
    }
    if (action.type === "riichi" && action.tile) {
      this.port.setSeatLegals(seat, []);
      await this.port.applyEngineAction({
        type: "riichi",
        seat,
        tile: action.tile,
        discardSource: action.discardSource,
      });
      await this.port.afterDiscard();
      return;
    }
  }

  isAcceptedAfk(
    seat: Seat,
    afk: boolean,
    defaultActionId: string | null
  ): boolean {
    const player = this.roster.players().get(seat);
    if (
      this.port.status() !== "playing" ||
      player === null ||
      player === undefined ||
      player.isBot
    ) {
      return false;
    }
    const changesState = afk
      ? !this.connections.view(seat).disconnected ||
        !this.connections.view(seat).afkSelfReported
      : this.connections.view(seat).disconnected ||
        this.connections.view(seat).afkSelfReported;
    if (!changesState) {
      return false;
    }
    const expectedDefault = afk
      ? this.port.pickImmediateAfkDefaultActionId(seat)
      : null;
    return defaultActionId === expectedDefault;
  }

  async handleAfkDirect(
    seat: Seat,
    afk: boolean,
    defaultActionId: string | null
  ): Promise<void> {
    this.connections.setAfk(seat, afk);
    this.port.broadcastRoomState();
    if (defaultActionId !== null) {
      this.port.reportAutomaticAction(seat, defaultActionId, "afk");
      await this.handleActDirect(seat, defaultActionId);
    }
  }
}
