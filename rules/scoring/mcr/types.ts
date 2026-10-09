import type { Seat, Tile, Wind } from "~/core/mahjong/rules/types";
import type { McrFanId } from "./fans";

export type { McrFanId } from "./fans";

export type McrWinMethod = "discard" | "self-draw";

/** A structural subset of Kandora's rules/state Meld accepted by the scorer. */
export interface McrMeldInput {
  readonly type: "chi" | "pon" | "daiminkan" | "ankan" | "shouminkan";
  readonly tiles: readonly Tile[];
  readonly claimedTile?: Tile | null;
  readonly from?: Seat | null;
}

export interface McrWinContext {
  readonly method: McrWinMethod;
  /** Kandora name for the prevalent wind. */
  readonly roundWind?: Wind;
  /** Explicit MCR synonym for roundWind. */
  readonly prevalentWind?: Wind;
  readonly seatWind?: Wind;
  readonly flowerCount?: number;
  /** 和绝张: the winning tile is the last physically available copy. */
  readonly lastCopy?: boolean;
  /** 妙手回春: self-draw of the final wall tile. */
  readonly lastTileDraw?: boolean;
  /** 海底捞月: claim of the final discard. */
  readonly lastTileClaim?: boolean;
  /** 杠上开花: self-draw from a kong replacement. */
  readonly replacementTile?: boolean;
  /** 抢杠和: discard win by robbing a promoted kong. */
  readonly robbingPromotedKong?: boolean;
}

export interface McrScoreInput {
  /** Concealed tiles before the separate winning tile. */
  readonly hand: readonly Tile[];
  readonly winTile: Tile;
  readonly melds?: readonly McrMeldInput[];
  readonly context: McrWinContext;
}

export interface McrAwardedFan {
  readonly id: McrFanId;
  readonly englishName: string;
  /** Green Book value for one occurrence. */
  readonly value: number;
  readonly count: number;
  /** Awarded subtotal after standard exceptions such as the mixed-kong pair. */
  readonly awardedPoints: number;
}

export interface McrNotWinningScore {
  readonly isWinningShape: false;
  readonly fans: readonly [];
  readonly totalFan: 0;
  readonly nonFlowerFan: 0;
  readonly meetsMinimum: false;
}

export interface McrWinningScore {
  readonly isWinningShape: true;
  readonly fans: readonly McrAwardedFan[];
  readonly totalFan: number;
  readonly nonFlowerFan: number;
  readonly meetsMinimum: boolean;
}

export type McrScoreResult = McrNotWinningScore | McrWinningScore;

export interface McrSettlementInput {
  readonly method: McrWinMethod;
  readonly winner: Seat;
  readonly discarder?: Seat;
  readonly totalFan: number;
  readonly nonFlowerFan: number;
}

export type McrSeatDeltas = readonly [number, number, number, number];
