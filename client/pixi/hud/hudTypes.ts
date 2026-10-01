import type { Container } from "pixi.js";
import type { Rect } from "../tableLayout";

export interface CenterLabels {
  repeat: string;
  riichi: string;
  tiles: string;
  remainingDraws: string;
}

export const DEFAULT_CENTER_LABELS: CenterLabels = {
  repeat: "Repeat",
  riichi: "Riichi",
  tiles: "Tiles",
  remainingDraws: "Remaining draws",
};

export type DiscardPanelRects = readonly [
  Readonly<Rect>,
  Readonly<Rect>,
  Readonly<Rect>,
  Readonly<Rect>,
];

export interface TimerHost {
  readonly stage: Container;
  readonly screen: { readonly width: number; readonly height: number };
  readonly ticker: {
    add(callback: () => void): unknown;
    remove(callback: () => void): unknown;
  };
}

export interface TimerAnchor {
  readonly x: number;
  readonly y: number;
}
