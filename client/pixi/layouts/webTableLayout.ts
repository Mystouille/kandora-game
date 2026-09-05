import type { TableLayout, TableLayoutConfig } from "../tableLayout";
import {
  discardScaleForTargetSpan,
  type DiscardLayoutOptions,
} from "../tileAreaLayout";
import type { TileDesign } from "../tiles/tileDesign";
import { compactWebTableLayout } from "./compactWebTableLayout";
import { currentTableLayout } from "./currentTableLayout";

export type WebTableLayoutMode = "standard" | "compact";

export const COMPACT_DISCARD_PANEL_PADDING = 4;

const WEB_TABLE_LAYOUTS: Record<WebTableLayoutMode, TableLayoutConfig> = {
  standard: currentTableLayout,
  compact: compactWebTableLayout,
};

export function webTableLayoutConfig(
  mode: WebTableLayoutMode
): TableLayoutConfig {
  return WEB_TABLE_LAYOUTS[mode];
}

export function webDiscardLayoutOptions(
  mode: WebTableLayoutMode,
  design: TileDesign,
  layout: TableLayout
): DiscardLayoutOptions | undefined {
  if (mode !== "compact") {
    return undefined;
  }
  return {
    scale: discardScaleForTargetSpan(
      design,
      0,
      layout.center.w - COMPACT_DISCARD_PANEL_PADDING * 2,
      18
    ),
    offsetX: COMPACT_DISCARD_PANEL_PADDING,
    offsetY: COMPACT_DISCARD_PANEL_PADDING,
  };
}