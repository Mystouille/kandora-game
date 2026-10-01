import type { MatchModeConfig } from "~/game/protocol/matchMode";
import type {
  RoomSeatOccupant,
  Seat,
  ServerMessage,
} from "~/game/protocol/messages";
import type { SpectatorDelayMs } from "~/game/protocol/spectatorDelay";
import type { DecisionTiming } from "../timing/decisionTiming";
import type { MatchKernel } from "./matchKernel";
import type { PlayerConnections } from "./playerConnections";
import type { RoomRoster } from "./roomRoster";
import type { MatchConfiguration } from "./sessionTypes";
import type { SessionSnapshot } from "./sessionCoordinator";

export interface RoomViewPort {
  status(): SessionSnapshot["status"];
  isRelay(): boolean;
  relayRuleSet(): string;
  spectatorDelayMs(): SpectatorDelayMs;
}

export class MatchRoomViews {
  constructor(
    private readonly config: MatchConfiguration,
    private readonly roster: RoomRoster,
    private readonly connections: PlayerConnections,
    private readonly kernel: MatchKernel,
    private readonly timing: DecisionTiming,
    private readonly port: RoomViewPort
  ) {}

  summary(): {
    matchId: string;
    status: SessionSnapshot["status"];
    presetId: string;
    mode: MatchModeConfig;
    spectatorDelayMs: SpectatorDelayMs;
    buuMode: boolean;
    seats: Array<{ name: string | null; isBot: boolean } | null>;
  } {
    const players = this.roster.players();
    const seats: Array<{ name: string | null; isBot: boolean } | null> = [
      null,
      null,
      null,
      null,
    ];
    for (const seat of [0, 1, 2, 3] as const) {
      const player = players.get(seat) ?? null;
      seats[seat] =
        player === null
          ? null
          : { name: player.displayName, isBot: player.isBot };
    }
    const buuMode =
      this.port.status() === "waiting"
        ? (this.config.ruleSetOverride?.buuMode ?? false)
        : (this.kernel.view?.ruleSet.buuMode ?? false);
    return {
      matchId: this.config.matchId,
      status: this.port.status(),
      presetId: this.port.isRelay()
        ? this.port.relayRuleSet()
        : this.config.presetId,
      mode: this.kernel.mode,
      spectatorDelayMs: this.port.spectatorDelayMs(),
      buuMode,
      seats,
    };
  }

  buildRoomState(
    forSeat: Seat | null
  ): Extract<ServerMessage, { type: "room_state" }> {
    const players = this.roster.players();
    const seats: Array<{
      seat: Seat;
      occupant: RoomSeatOccupant;
      ready: boolean;
    }> = [];
    for (const seat of [0, 1, 2, 3] as const) {
      const player = players.get(seat) ?? null;
      let occupant: RoomSeatOccupant;
      if (player === null) {
        occupant = { kind: "empty" };
      } else if (player.isBot) {
        occupant = {
          kind: "bot",
          userId: player.userId,
          displayName: player.displayName,
        };
      } else {
        occupant = {
          kind: "human",
          userId: player.userId,
          displayName: player.displayName,
          connected:
            this.port.isRelay() ||
            (this.connections.sender(seat) !== null &&
              !this.connections.view(seat).disconnected),
        };
      }
      const ready =
        player?.isBot === true ||
        (player !== null &&
          !player.isBot &&
          this.roster.readySnapshot()[seat] &&
          this.connections.sender(seat) !== null);
      seats.push({ seat, occupant, ready });
    }
    const hostSeat = this.roster.hostSeat();
    return {
      type: "room_state",
      matchId: this.config.matchId,
      clock: this.timing.stamp(),
      mode: this.kernel.mode,
      spectatorDelayMs: this.port.spectatorDelayMs(),
      status: this.port.status(),
      mySeat: forSeat,
      hostSeat,
      canStart: hostSeat !== null && this.roster.canStart(hostSeat),
      seats,
    };
  }
}
