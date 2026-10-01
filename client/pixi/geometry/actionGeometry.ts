import type { ColorSource } from "pixi.js";
import type { LegalAction } from "~/game/protocol/messages";
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

export function labelForAction(action: LegalAction): string {
  if (action.type === "chi" && action.tiles) {
    const a = action.tiles[0];
    const b = action.tiles[1];
    return `Chi ${tileNum(a)}·${tileNum(b)}`;
  }
  if (action.type === "kan") {
    if (action.kanKind === "ankan") {
      const t = action.tiles?.[0];
      return t ? `Ankan ${tileNum(t)}` : "Ankan";
    }
    if (action.kanKind === "shouminkan") {
      const t = action.tiles?.[0];
      return t ? `Shouminkan ${tileNum(t)}` : "Shouminkan";
    }
    return "Kan";
  }
  if (action.type === "pon") {
    return "Pon";
  }
  if (action.type === "ron") {
    return "Ron";
  }
  if (action.type === "tsumo") {
    return "Tsumo";
  }
  if (action.type === "pass") {
    return "Pass";
  }
  if (action.type === "riichi") {
    return "Riichi";
  }
  if (action.type === "win") {
    return "Win";
  }
  if (action.type === "declare_tenpai") {
    return "Tenpai";
  }
  if (action.type === "declare_noten") {
    return "Noten";
  }
  return action.type;
}

export function actionButtonLabel(action: LegalAction): string {
  return action.type === "pass" ? "Skip" : labelForAction(action);
}

export function actionButtonColor(action: LegalAction): ColorSource {
  const palette: Record<string, ColorSource> = {
    chi: 0x4a7fb4,
    pon: 0xb47f3a,
    kan: 0x7a4ab4,
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
