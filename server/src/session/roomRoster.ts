import type { Seat, ServerMessage } from "~/game/protocol/messages";

export interface MatchPlayerInit {
  userId: string;
  displayName: string;
  isBot: boolean;
}

export interface RoomRosterPort {
  status(): "waiting" | "playing" | "finished";
  assertNotPaused(operation: string): void;
  hasSender(seat: Seat): boolean;
  send(seat: Seat, message: ServerMessage): void;
  clearConnection(seat: Seat): void;
  permuteConnections(permutation: readonly [Seat, Seat, Seat, Seat]): void;
  onPlayingHumanClaimed(seat: Seat): void;
  broadcastRoom(): void;
  broadcastViewers(): void;
  start(): Promise<void>;
}

/** Sole owner of occupant identity, waiting-room host order and waiting readiness. */
export class RoomRoster {
  private readonly occupants = new Map<Seat, MatchPlayerInit | null>();
  private waitingReady: [boolean, boolean, boolean, boolean] = [
    false,
    false,
    false,
    false,
  ];

  constructor(
    private readonly matchId: string,
    players: readonly MatchPlayerInit[],
    private readonly port: RoomRosterPort
  ) {
    if (players.length !== 4) {
      throw new Error("MatchProcess requires exactly 4 players");
    }
    for (const seat of [0, 1, 2, 3] as const) {
      this.occupants.set(seat, { ...players[seat] });
    }
  }

  player(seat: Seat): Readonly<MatchPlayerInit> | null {
    const player = this.occupants.get(seat);
    return player ? { ...player } : null;
  }

  players(): ReadonlyMap<Seat, Readonly<MatchPlayerInit> | null> {
    return new Map(
      [...this.occupants].map(([seat, player]) => [
        seat,
        player === null ? null : { ...player },
      ])
    );
  }

  readySnapshot(): [boolean, boolean, boolean, boolean] {
    return [...this.waitingReady];
  }

  empty(): void {
    for (const seat of [0, 1, 2, 3] as const) {
      this.occupants.set(seat, null);
    }
  }

  restore(
    players: readonly (MatchPlayerInit | null)[],
    ready?: readonly [boolean, boolean, boolean, boolean]
  ): void {
    for (const seat of [0, 1, 2, 3] as const) {
      this.replaceSeat(seat, players[seat]);
    }
    if (ready !== undefined) {
      this.waitingReady = [...ready];
    }
  }

  replaceSeat(seat: Seat, player: MatchPlayerInit | null): void {
    this.occupants.set(seat, player === null ? null : { ...player });
  }

  claimSeat(userId: string, displayName: string): Seat | null {
    this.port.assertNotPaused("claimSeat");
    const existing = this.humanSeatForUser(userId);
    if (existing !== null) {
      return existing;
    }
    const status = this.port.status();
    if (status === "waiting" || status === "playing") {
      for (const [seat, player] of this.occupants) {
        if (player?.isBot) {
          this.occupants.set(seat, { userId, displayName, isBot: false });
          this.waitingReady[seat] = false;
          if (status === "waiting") {
            this.compact();
          } else {
            this.port.onPlayingHumanClaimed(seat);
          }
          const assigned = this.humanSeatForUser(userId);
          if (assigned === null) {
            throw new Error(
              "claimSeat: replacement player disappeared during compaction"
            );
          }
          this.port.broadcastRoom();
          return assigned;
        }
      }
    }
    if (status !== "waiting") {
      return null;
    }
    const empty = [...this.occupants].find(([, player]) => player === null);
    if (empty === undefined) {
      return null;
    }
    const pick = empty[0];
    this.occupants.set(pick, { userId, displayName, isBot: false });
    this.waitingReady[pick] = false;
    this.compact();
    const assigned = this.humanSeatForUser(userId);
    if (assigned === null) {
      throw new Error(
        "claimSeat: assigned player disappeared during compaction"
      );
    }
    this.port.broadcastRoom();
    return assigned;
  }

  releaseSeat(seat: Seat): void {
    this.port.assertNotPaused("releaseSeat");
    const status = this.port.status();
    if (status !== "waiting") {
      throw new Error(`releaseSeat: cannot release seat in status "${status}"`);
    }
    const player = this.occupants.get(seat);
    if (!player || player.isBot) {
      return;
    }
    this.clearSeat(seat);
    this.compact();
    this.port.broadcastRoom();
    this.port.broadcastViewers();
  }

  hostSeat(): Seat | null {
    for (const seat of [0, 1, 2, 3] as const) {
      if (this.isHumanSeat(seat)) {
        return seat;
      }
    }
    return null;
  }

  assertHost(requestedBy: Seat, action: string): void {
    const status = this.port.status();
    if (status !== "waiting") {
      throw new Error(`${action}: cannot manage room in status "${status}"`);
    }
    if (this.hostSeat() !== requestedBy) {
      throw new Error(`${action}: only the waiting-room host may do that`);
    }
  }

  setReady(seat: Seat, ready: boolean): void {
    this.port.assertNotPaused("setWaitingRoomReady");
    const status = this.port.status();
    if (status !== "waiting") {
      throw new Error(
        `setWaitingRoomReady: cannot update readiness in status "${status}"`
      );
    }
    if (!this.isHumanSeat(seat)) {
      throw new Error("setWaitingRoomReady: only a seated human can be ready");
    }
    this.waitingReady[seat] = ready;
    this.port.broadcastRoom();
  }

  canStart(requestedBy: Seat): boolean {
    if (this.port.status() !== "waiting" || this.hostSeat() !== requestedBy) {
      return false;
    }
    const humans = this.humanSeats();
    return (
      humans.length > 0 &&
      humans.every(
        (seat) => this.waitingReady[seat] && this.port.hasSender(seat)
      )
    );
  }

  async startWaitingRoom(
    requestedBy: Seat,
    permutation: readonly [Seat, Seat, Seat, Seat]
  ): Promise<void> {
    this.assertHost(requestedBy, "startWaitingRoom");
    if (!this.canStart(requestedBy)) {
      throw new Error(
        "startWaitingRoom: every seated human must be connected and ready"
      );
    }
    await this.fillBotsAndStart(permutation);
  }

  addBot(requestedBy: Seat): Seat {
    this.port.assertNotPaused("addWaitingRoomBot");
    this.assertHost(requestedBy, "addWaitingRoomBot");
    for (const seat of [0, 1, 2, 3] as const) {
      if (this.occupants.get(seat) === null) {
        const botCount = [...this.occupants.values()].filter(
          (player) => player?.isBot
        ).length;
        this.occupants.set(seat, this.nextBot(`Bot ${botCount + 1}`));
        this.waitingReady[seat] = true;
        this.port.broadcastRoom();
        return seat;
      }
    }
    throw new Error("addWaitingRoomBot: the waiting room is full");
  }

  kickSeat(requestedBy: Seat, target: Seat): void {
    this.port.assertNotPaused("kickWaitingRoomSeat");
    this.assertHost(requestedBy, "kickWaitingRoomSeat");
    if (target === requestedBy) {
      throw new Error("kickWaitingRoomSeat: the host must leave normally");
    }
    const player = this.occupants.get(target);
    if (!player) {
      throw new Error("kickWaitingRoomSeat: that seat is empty");
    }
    if (!player.isBot) {
      this.port.send(target, { type: "room_kicked", matchId: this.matchId });
    }
    this.clearSeat(target);
    this.compact();
    this.port.broadcastRoom();
    this.port.broadcastViewers();
  }

  fillBots(): void {
    this.port.assertNotPaused("fillBots");
    const status = this.port.status();
    if (status !== "waiting") {
      throw new Error(`fillBots: cannot fill bots in status "${status}"`);
    }
    const names = ["Bot East", "Bot South", "Bot West", "Bot North"];
    for (const [seat, player] of this.occupants) {
      if (player === null) {
        this.occupants.set(seat, this.nextBot(names[seat]));
        this.waitingReady[seat] = true;
      }
    }
  }

  async fillBotsAndStart(
    permutation: readonly [Seat, Seat, Seat, Seat]
  ): Promise<void> {
    this.port.assertNotPaused("fillBotsAndStart");
    const status = this.port.status();
    if (status !== "waiting") {
      throw new Error(`fillBotsAndStart: cannot start from status "${status}"`);
    }
    this.permute(permutation);
    this.fillBots();
    this.port.broadcastRoom();
    await this.port.start();
  }

  permute(permutation: readonly [Seat, Seat, Seat, Seat]): void {
    const players = new Map(this.occupants);
    const ready = [...this.waitingReady];
    for (const seat of [0, 1, 2, 3] as const) {
      const source = permutation[seat];
      this.occupants.set(seat, players.get(source) ?? null);
      this.waitingReady[seat] = ready[source];
    }
    this.port.permuteConnections(permutation);
  }

  humanSeatForUser(userId: string): Seat | null {
    for (const [seat, player] of this.occupants) {
      if (player && !player.isBot && player.userId === userId) {
        return seat;
      }
    }
    return null;
  }

  humanSeats(): Seat[] {
    return [...this.occupants]
      .filter(([, player]) => player !== null && !player.isBot)
      .map(([seat]) => seat);
  }

  humanUserIds(): string[] {
    return this.humanSeats().map((seat) => {
      const player = this.occupants.get(seat);
      if (!player) {
        throw new Error(`RoomRoster: human seat ${seat} disappeared`);
      }
      return player.userId;
    });
  }

  isHumanSeat(seat: Seat): boolean {
    const player = this.occupants.get(seat);
    return player !== null && player !== undefined && !player.isBot;
  }

  private clearSeat(seat: Seat): void {
    this.port.clearConnection(seat);
    this.waitingReady[seat] = false;
    this.occupants.set(seat, null);
  }

  private compact(): void {
    const humans: Seat[] = [];
    const bots: Seat[] = [];
    const empty: Seat[] = [];
    for (const seat of [0, 1, 2, 3] as const) {
      const player = this.occupants.get(seat);
      if (player === null) {
        empty.push(seat);
      } else if (player?.isBot) {
        bots.push(seat);
      } else {
        humans.push(seat);
      }
    }
    const permutation = [...humans, ...bots, ...empty];
    this.permute([
      permutation[0],
      permutation[1],
      permutation[2],
      permutation[3],
    ]);
  }

  private nextBot(displayName: string): MatchPlayerInit {
    let botNumber = 1;
    while (
      [...this.occupants.values()].some(
        (player) => player?.userId === `bot:room:${botNumber}`
      )
    ) {
      botNumber++;
    }
    return { userId: `bot:room:${botNumber}`, displayName, isBot: true };
  }
}
