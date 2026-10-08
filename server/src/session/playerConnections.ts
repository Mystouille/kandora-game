import type { ReadonlySeatValues } from "~/game/protocol/seat";
import { type SeatValues } from "~/game/protocol/seat";
import type { Seat, ServerMessage } from "~/game/protocol/messages";
import type { MatchPlayerInit } from "./roomRoster";
import {
  activeSeats,
  isActiveSeat,
  mapSeatValues,
  seatValues,
  type PlayerCount,
} from "~/game/rules/seats";

export type Send = (message: ServerMessage) => void;

export interface HumanConnectionOptions {
  clientSessionId: string;
  takeover?: boolean;
}

export interface HumanAttachResult {
  previousSend: Send | null;
  previousClientSessionId: string | null;
  tookOver: boolean;
}

export class HumanSessionTakeoverRequiredError extends Error {
  constructor(readonly seat: Seat) {
    super("This seat is active on another device.");
    this.name = "HumanSessionTakeoverRequiredError";
  }
}

export interface ConnectionPolicySnapshot {
  disconnected: SeatValues<boolean>;
  afkSelfReported: SeatValues<boolean>;
  livenessProbeMisses: SeatValues<number>;
}

interface SeatConnection {
  send: Send | null;
  clientSessionId: string | null;
  generation: number;
  probe: (() => Promise<boolean>) | null;
  disconnected: boolean;
  afkSelfReported: boolean;
  probeMisses: number;
  probeInflight: boolean;
}

export interface PlayerConnectionView {
  readonly disconnected: boolean;
  readonly afkSelfReported: boolean;
  readonly generation: number;
}

function emptyConnection(): SeatConnection {
  return {
    send: null,
    clientSessionId: null,
    generation: 0,
    probe: null,
    disconnected: false,
    afkSelfReported: false,
    probeMisses: 0,
    probeInflight: false,
  };
}

/** Socket ownership, absence policy and liveness generations move with the occupant. */
export class PlayerConnections {
  private seats: SeatValues<SeatConnection>;

  constructor(
    private readonly player: (seat: Seat) => Readonly<MatchPlayerInit> | null,
    private readonly onLivenessDisconnect: () => void,
    readonly playerCount: PlayerCount = 4
  ) {
    this.seats = seatValues(playerCount, emptyConnection);
  }

  view(seat: Seat): PlayerConnectionView {
    const connection = this.seats[seat];
    return {
      disconnected: connection.disconnected,
      afkSelfReported: connection.afkSelfReported,
      generation: connection.generation,
    };
  }

  sender(seat: Seat): Send | null {
    return this.seats[seat].send;
  }

  senders(): Array<Send | null> {
    return this.seats.map((connection) => connection.send);
  }

  isAttached(seat: Seat, send: Send): boolean {
    return this.seats[seat].send === send;
  }

  isConnected(seat: Seat): boolean {
    const connection = this.seats[seat];
    return (
      connection.send !== null &&
      !connection.disconnected &&
      !connection.afkSelfReported
    );
  }

  seatFor(send: Send): Seat | null {
    for (const seat of activeSeats(this.playerCount)) {
      if (this.seats[seat].send === send) {
        return seat;
      }
    }
    return null;
  }

  attach(
    seat: Seat,
    send: Send,
    probe?: () => Promise<boolean>,
    options?: HumanConnectionOptions
  ): HumanAttachResult {
    const player = this.player(seat);
    if (player === null) {
      throw new Error(
        `attachHuman: seat ${seat} is unclaimed; call claimSeat() first`
      );
    }
    if (player.isBot) {
      throw new Error(
        `attachHuman: seat ${seat} is a bot; cannot attach a human socket`
      );
    }
    const connection = this.seats[seat];
    const previousSend = connection.send;
    const previousClientSessionId = connection.clientSessionId;
    const nextClientSessionId =
      options?.clientSessionId ?? previousClientSessionId;
    const tookOver =
      previousClientSessionId !== null &&
      nextClientSessionId !== null &&
      previousClientSessionId !== nextClientSessionId;
    if (tookOver && options?.takeover !== true) {
      throw new HumanSessionTakeoverRequiredError(seat);
    }
    connection.generation += 1;
    connection.send = send;
    connection.clientSessionId = nextClientSessionId;
    connection.probe = probe ?? null;
    connection.probeMisses = 0;
    connection.probeInflight = false;
    if (options?.takeover === true) {
      connection.disconnected = false;
      connection.afkSelfReported = false;
    } else if (connection.disconnected && !connection.afkSelfReported) {
      connection.disconnected = false;
    }
    return { previousSend, previousClientSessionId, tookOver };
  }

  detach(
    seat: Seat,
    expectedSend: Send | undefined,
    paused: boolean,
    playing: boolean
  ): boolean {
    const connection = this.seats[seat];
    if (
      connection.send === null ||
      (expectedSend !== undefined && connection.send !== expectedSend)
    ) {
      return false;
    }
    connection.generation += 1;
    connection.send = null;
    connection.probe = null;
    connection.probeInflight = false;
    if (!paused && playing) {
      connection.disconnected = true;
    }
    return true;
  }

  setAfk(seat: Seat, afk: boolean): void {
    const connection = this.seats[seat];
    connection.disconnected = afk;
    connection.afkSelfReported = afk;
    if (!afk) {
      connection.probeMisses = 0;
    }
  }

  recordAction(seat: Seat): void {
    this.seats[seat].probeMisses = 0;
  }

  canProbe(seat: Seat): boolean {
    const connection = this.seats[seat];
    return (
      connection.probe !== null &&
      !connection.disconnected &&
      !connection.probeInflight
    );
  }

  async probe(seat: Seat): Promise<void> {
    const connection = this.seats[seat];
    const probe = connection.probe;
    if (probe === null || !this.canProbe(seat)) {
      return;
    }
    const generation = connection.generation;
    connection.probeInflight = true;
    try {
      const alive = await probe();
      const current = this.seats[seat];
      if (current.generation !== generation || current.probe !== probe) {
        return;
      }
      if (alive) {
        current.probeMisses = 0;
      } else if (!current.disconnected) {
        current.probeMisses += 1;
        if (current.probeMisses >= 2) {
          current.disconnected = true;
          this.onLivenessDisconnect();
        }
      }
    } finally {
      const current = this.seats[seat];
      if (current.generation === generation && current.probe === probe) {
        current.probeInflight = false;
      }
    }
  }

  clearSeat(seat: Seat): void {
    const generation = this.seats[seat].generation + 1;
    this.seats[seat] = { ...emptyConnection(), generation };
  }

  permute(permutation: ReadonlySeatValues<Seat>): void {
    if (
      permutation.length !== this.playerCount ||
      new Set(permutation).size !== this.playerCount ||
      permutation.some((seat) => !isActiveSeat(seat, this.playerCount))
    ) {
      throw new Error("PlayerConnections: invalid active-seat permutation");
    }
    const previous = this.seats;
    this.seats = mapSeatValues(permutation, (source) =>
      this.movedConnection(previous[source])
    );
  }

  policySnapshot(): ConnectionPolicySnapshot {
    return {
      disconnected: mapSeatValues(
        this.seats,
        (connection) => connection.disconnected
      ),
      afkSelfReported: mapSeatValues(
        this.seats,
        (connection) => connection.afkSelfReported
      ),
      livenessProbeMisses: mapSeatValues(
        this.seats,
        (connection) => connection.probeMisses
      ),
    };
  }

  restorePolicy(policy: ConnectionPolicySnapshot): void {
    if (
      Object.values(policy).some((values) => values.length !== this.playerCount)
    ) {
      throw new Error(
        "PlayerConnections: restored participant count does not match"
      );
    }
    for (const seat of activeSeats(this.playerCount)) {
      const connection = this.seats[seat];
      connection.disconnected = policy.disconnected[seat];
      connection.afkSelfReported = policy.afkSelfReported[seat];
      connection.probeMisses = policy.livenessProbeMisses[seat];
    }
  }

  private movedConnection(connection: SeatConnection): SeatConnection {
    return {
      ...connection,
      probeInflight: false,
      generation: connection.generation + 1,
    };
  }
}
