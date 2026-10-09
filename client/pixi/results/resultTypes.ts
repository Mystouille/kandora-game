import type { Container } from "pixi.js";
import type { Meld } from "~/game/protocol/messages";
import type { HandResult } from "../scene/renderTypes";

export type MeldSheetKey =
  | "ownHand"
  | "bottomSmall"
  | "topSmall"
  | "leftSmall"
  | "rightSmall"
  | "sideHandL"
  | "sideHandR";

export interface MeldDrawingPort {
  drawMeld(
    meld: Meld,
    seat: number,
    shouminkanOffsetY?: number,
    revealAnkan?: boolean
  ): {
    node: Container;
    width: number;
    boxes: Array<{
      cx: number;
      cy: number;
      w: number;
      h: number;
      isolated?: boolean;
    }>;
  };
  drawMeldTile(
    tile: string | null,
    seat: number,
    sheetOverride?: MeldSheetKey
  ): {
    node: Container;
    offX: number;
    offY: number;
    footW: number;
    footH: number;
  };
}

export interface ResultLabels {
  exhaustiveDraw: string;
  abortTitle: string;
  abortKinds: {
    kyuushuu: string;
    suufonRenda: string;
    suuchaRiichi: string;
    sanchahou: string;
    unknown: string;
  };
  chomboTitle: string;
  chomboReasons: {
    sinkingWinNotFloating: string;
    gameEndingWinNotFirst: string;
    gameEndingChinmai: string;
  };
}

export const DEFAULT_RESULT_LABELS: ResultLabels = {
  exhaustiveDraw: "Exhaustive draw",
  abortTitle: "Abort: {kind}",
  abortKinds: {
    kyuushuu: "Nine Terminals",
    suufonRenda: "Four Winds Discarded",
    suuchaRiichi: "Four Players Riichi",
    sanchahou: "Triple Ron",
    unknown: "Unknown",
  },
  chomboTitle: "Chombo: {reason}",
  chomboReasons: {
    sinkingWinNotFloating: "sinking win without tenpai",
    gameEndingWinNotFirst: "game-ending win not in first",
    gameEndingChinmai: "game-ending chinmai",
  },
};

export type ResultRow =
  | { kind: "yaku"; name: string; value: string; hidden?: boolean }
  | {
      kind: "yaku2";
      left: { name: string; value: string };
      right: { name: string; value: string } | null;
      leftHidden?: boolean;
      rightHidden?: boolean;
    }
  | { kind: "title"; text: string; size: number }
  | { kind: "label"; text: string; size: number; color?: number }
  | {
      kind: "scoreRow";
      han: string;
      pts: string | null;
      ptsColor?: number;
      hidden?: boolean;
    }
  | { kind: "tiles"; tiles: (string | null)[] }
  | {
      kind: "hand";
      concealed: string[];
      winTile?: string;
      melds?: Meld[];
      revealConcealedKongs?: boolean;
    }
  | { kind: "divider" };

export interface ResultRowPlan {
  readonly rows: readonly ResultRow[];
  readonly revealedYakuCount: number;
  readonly hasUraYaku: boolean;
  readonly uraIndicatorsRevealed: boolean;
  readonly scoreSummaryRevealed: boolean;
  readonly scoreDeltaRevealed: boolean;
}

export type ResultWin = NonNullable<HandResult["wins"]>[number];
