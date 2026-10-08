import type { Seat } from "~/game/protocol/messages";

import type { MatchRuntime } from "../runtime";
import {
  copySeatValues,
  seatValues,
  type PlayerCount,
  type SeatValues,
} from "~/game/rules/seats";

export interface HandMetadataSnapshot {
  readonly dice: [number, number];
  readonly riichiTileIdx: SeatValues<number | null>;
}

export class HandMetadata {
  private riichiTileIdx: SeatValues<number | null>;
  private dice: [number, number] = [1, 1];

  constructor(
    private readonly runtime: MatchRuntime,
    private readonly playerCount: PlayerCount = 4
  ) {
    this.riichiTileIdx = seatValues(playerCount, () => null);
  }
  snapshot(): HandMetadataSnapshot {
    return {
      dice: [...this.dice],
      riichiTileIdx: copySeatValues(this.riichiTileIdx),
    };
  }
  restore(snapshot: HandMetadataSnapshot): void {
    this.dice = [...snapshot.dice];
    if (snapshot.riichiTileIdx.length !== this.playerCount) {
      throw new Error(
        "HandMetadata: restored participant count does not match"
      );
    }
    this.riichiTileIdx = copySeatValues(snapshot.riichiTileIdx);
  }
  resetRiichiTiles(): void {
    this.riichiTileIdx = seatValues(this.playerCount, () => null);
  }
  recordRiichiTile(seat: Seat, index: number): void {
    this.riichiTileIdx[seat] = index;
  }

  rollDice(): [number, number] {
    const a = 1 + Math.floor(this.runtime.random() * 6);
    const b = 1 + Math.floor(this.runtime.random() * 6);
    this.dice = [a, b];
    return [a, b];
  }
}
