import { activeSeats } from "~/game/rules/seats";
import type { GameEvent, Seat, ServerMessage } from "~/game/protocol/messages";
import type { PersistedMatchEvent } from "../repository";
import type { ActionWindowRegistry } from "../timing/actionWindows";
import type { DecisionTiming } from "../timing/decisionTiming";
import type { TimeBank } from "../timing/timeBank";
import { replayProjectedEvents } from "./eventReplay";
import type { PlayerConnections } from "./playerConnections";
import type { SpectatorStreams } from "./spectatorStreams";

export interface MatchBroadcastPort {
  projectForSeat(event: GameEvent, seat: Seat): GameEvent | null;
  claimSeatSequence(seat: Seat): number;
  seatSequence(seat: Seat): number;
  history(): readonly PersistedMatchEvent[];
  buildRoomState(
    seat: Seat | null
  ): Extract<ServerMessage, { type: "room_state" }>;
  buildViewerState(): Extract<ServerMessage, { type: "viewer_state" }>;
}

export class MatchBroadcast {
  constructor(
    private readonly connections: PlayerConnections,
    private readonly windows: ActionWindowRegistry,
    private readonly bank: TimeBank,
    private readonly timing: DecisionTiming,
    private readonly spectators: SpectatorStreams,
    private readonly port: MatchBroadcastPort
  ) {}

  sendToSeat(seat: Seat, event: GameEvent): void {
    const send = this.connections.sender(seat);
    if (!send) {
      return;
    }
    const projected = this.port.projectForSeat(event, seat);
    if (projected === null) {
      return;
    }
    const seq = this.port.claimSeatSequence(seat);
    const legals = this.windows.legals(seat);
    const deadline = this.windows.view(seat).deadline;
    send({
      ...this.timing.metadata(seat, seq),
      type: "event",
      seq,
      events: [projected],
      legalActions: legals,
      ...(deadline !== null ? { deadline } : {}),
      ...(this.windows.view(seat).kind === "ryuukyoku_declaration"
        ? {}
        : { bufferMs: this.bank.balance(seat) }),
    });
  }

  flushLegalsToSeat(seat: Seat): void {
    const send = this.connections.sender(seat);
    if (!send) {
      return;
    }
    const deadline = this.windows.view(seat).deadline;
    send({
      ...this.timing.metadata(seat, this.port.seatSequence(seat) - 1),
      type: "event",
      seq: this.port.seatSequence(seat) - 1,
      events: [],
      legalActions: this.windows.legals(seat),
      ...(deadline !== null ? { deadline } : {}),
      ...(this.windows.view(seat).kind === "ryuukyoku_declaration"
        ? {}
        : { bufferMs: this.bank.balance(seat) }),
    });
  }

  broadcastRoomState(): void {
    for (const seat of activeSeats(this.connections.playerCount)) {
      const send = this.connections.sender(seat);
      if (send !== null) {
        send(this.port.buildRoomState(seat));
      }
    }
    if (this.spectators.hasLive) {
      this.spectators.broadcastLive(this.port.buildRoomState(null));
    }
  }

  broadcastViewerState(): void {
    const frame = this.port.buildViewerState();
    for (const send of this.connections.senders()) {
      send?.(frame);
    }
    this.spectators.broadcastPresence(frame);
  }

  replayFromBuffer(
    fromSeq: number,
    recipient: Seat = 0
  ): Array<{ seq: number; event: GameEvent }> {
    return replayProjectedEvents(this.port.history(), fromSeq, (event) =>
      this.port.projectForSeat(event, recipient)
    );
  }
}
