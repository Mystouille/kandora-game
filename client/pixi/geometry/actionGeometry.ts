import type { ColorSource } from "pixi.js";
import type { LegalAction } from "~/game/protocol/messages";
import type { RulesFamily } from "~/game/protocol/rulesFamily";
import type { Rect } from "../tableLayout";
import type { TableRendererPresentation } from "../scene/renderTypes";
import { tileNum } from "./tileOrder";

export interface ActionButtonStyle {
  height: number;
  gap: number;
  rightInset: number;
  bottomOffset: number;
  optionGap: number;
  optionRowGap: number;
  minActionWidth: number;
  minGroupWidth: number;
  minRiichiWidth: number;
  horizontalPadding: number;
  optionPadding: number;
  optionTileInset: number;
  radius: number;
  fillAlpha: number;
  optionFillAlpha: number;
  borderAlpha: number;
}

const STANDARD_ACTION_BUTTON_STYLE: ActionButtonStyle = {
  height: 64,
  gap: 14,
  rightInset: 16,
  bottomOffset: 240,
  optionGap: 12,
  optionRowGap: 14,
  minActionWidth: 110,
  minGroupWidth: 120,
  minRiichiWidth: 110,
  horizontalPadding: 22,
  optionPadding: 12,
  optionTileInset: 12,
  radius: 10,
  fillAlpha: 1,
  optionFillAlpha: 1,
  borderAlpha: 0,
};

const MOBILE_ACTION_BUTTON_STYLE: ActionButtonStyle = {
  height: 96,
  gap: 10,
  rightInset: 12,
  bottomOffset: 240,
  optionGap: 10,
  optionRowGap: 12,
  minActionWidth: 165,
  minGroupWidth: 180,
  minRiichiWidth: 165,
  horizontalPadding: 33,
  optionPadding: 18,
  optionTileInset: 18,
  radius: 8,
  fillAlpha: 0.72,
  optionFillAlpha: 0.82,
  borderAlpha: 0.28,
};

export function actionButtonStyle(
  presentation: TableRendererPresentation
): Readonly<ActionButtonStyle> {
  return presentation === "mobile"
    ? MOBILE_ACTION_BUTTON_STYLE
    : STANDARD_ACTION_BUTTON_STYLE;
}

export interface ActionButtonPlacement extends Rect {
  row: number;
}

export function layoutActionButtonRows(
  widths: readonly number[],
  leftEdge: number,
  rightEdge: number,
  bottomEdge: number,
  height: number,
  gap: number,
  rowGap: number
): { placements: ActionButtonPlacement[]; rowCount: number } {
  if (widths.length === 0) {
    return { placements: [], rowCount: 0 };
  }
  const placements = new Array<ActionButtonPlacement>(widths.length);
  let row = 0;
  let cursor = rightEdge;
  for (let index = widths.length - 1; index >= 0; index -= 1) {
    const width = widths[index];
    if (cursor < rightEdge && cursor - width < leftEdge) {
      row += 1;
      cursor = rightEdge;
    }
    const x = Math.max(leftEdge, cursor - width);
    placements[index] = {
      x,
      y: bottomEdge - height - row * (height + rowGap),
      w: width,
      h: height,
      row,
    };
    cursor = x - gap;
  }
  return { placements, rowCount: row + 1 };
}

const CALL_LABELS = {
  riichi: {
    chi: "Chi",
    pon: "Pon",
    kan: "Kan",
    ron: "Ron",
    tsumo: "Tsumo",
    win: "Win",
  },
  mcr: {
    chi: "Chow",
    pon: "Pung",
    kan: "Kong",
    ron: "Mahjong",
    tsumo: "Mahjong",
    win: "Mahjong",
  },
} as const;

export function callLabel(
  type: keyof typeof CALL_LABELS.riichi,
  rulesFamily: RulesFamily = "riichi"
) {
  return CALL_LABELS[rulesFamily][type];
}

export function labelForAction(
  action: LegalAction,
  rulesFamily: RulesFamily = "riichi"
): string {
  if (action.type === "chi") {
    const label = callLabel("chi", rulesFamily);
    if (action.tiles) {
      const a = action.tiles[0];
      const b = action.tiles[1];
      return `${label} ${tileNum(a)}·${tileNum(b)}`;
    }
    return label;
  }
  if (action.type === "kan") {
    if (rulesFamily === "mcr") {
      return callLabel("kan", rulesFamily);
    }
    if (action.kanKind === "ankan") {
      const t = action.tiles?.[0];
      return t ? `Ankan ${tileNum(t)}` : "Ankan";
    }
    if (action.kanKind === "shouminkan") {
      const t = action.tiles?.[0];
      return t ? `Shouminkan ${tileNum(t)}` : "Shouminkan";
    }
    return callLabel("kan", rulesFamily);
  }
  if (action.type === "pon") {
    return callLabel("pon", rulesFamily);
  }
  if (action.type === "nuki") {
    return "Nuki 北";
  }
  if (action.type === "ron") {
    return callLabel("ron", rulesFamily);
  }
  if (action.type === "tsumo") {
    return callLabel("tsumo", rulesFamily);
  }
  if (action.type === "pass") {
    return "Pass";
  }
  if (action.type === "riichi") {
    return "Riichi";
  }
  if (action.type === "win") {
    return callLabel("win", rulesFamily);
  }
  if (action.type === "declare_tenpai") {
    return "Tenpai";
  }
  if (action.type === "declare_noten") {
    return "Noten";
  }
  return action.type;
}

export function actionButtonLabel(
  action: LegalAction,
  rulesFamily: RulesFamily = "riichi"
): string {
  return action.type === "pass" ? "Skip" : labelForAction(action, rulesFamily);
}

export function actionButtonColor(action: LegalAction): ColorSource {
  const palette: Record<string, ColorSource> = {
    chi: 0x4a7fb4,
    pon: 0xb47f3a,
    kan: 0x7a4ab4,
    nuki: 0x3a8b91,
    ron: 0xc04040,
    tsumo: 0x40a060,
    pass: 0x444444,
    win: 0x40a060,
    riichi: 0xc0a040,
    declare_tenpai: 0x40a060,
    declare_noten: 0x5c6470,
  };
  return palette[action.type] ?? 0x666666;
}

export function orderedRyuukyokuDeclarationActions(
  actions: readonly LegalAction[]
): LegalAction[] {
  const noten = actions.filter((action) => action.type === "declare_noten");
  const tenpai = actions.filter((action) => action.type === "declare_tenpai");
  return [...noten, ...tenpai];
}
