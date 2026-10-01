import type { Seat } from "~/game/protocol/messages";

import type { MatchRuntime } from "../runtime";

export interface HandMetadataSnapshot {
  readonly dice: [number, number];
  readonly riichiTileIdx: [
    number | null,
    number | null,
    number | null,
    number | null,
  ];
}

export class HandMetadata {
  private riichiTileIdx: [
    number | null,
    number | null,
    number | null,
    number | null,
  ] = [null, null, null, null];
  private dice: [number, number] = [1, 1];

  constructor(private readonly runtime: MatchRuntime) {}
  snapshot(): HandMetadataSnapshot {
    return { dice: [...this.dice], riichiTileIdx: [...this.riichiTileIdx] };
  }
  restore(snapshot: HandMetadataSnapshot): void {
    this.dice = [...snapshot.dice];
    this.riichiTileIdx = [...snapshot.riichiTileIdx];
  }
  resetRiichiTiles(): void {
    this.riichiTileIdx = [null, null, null, null];
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
