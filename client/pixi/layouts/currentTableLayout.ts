/**
 * The sole production layout preset. Its zone rectangles are derived
 * from the legacy `computeTableLayout()` so they are byte-identical to
 * what the renderer draws today; a test asserts this equality. When
 * the renderer is switched to consume configs (Phase 5), this becomes
 * the single geometry source and `computeTableLayout` can retire.
 */
import {
  computeTableLayout,
  DEFAULT_LAYER_TIERS,
  type TableLayoutConfig,
} from "../tableLayout";

const legacy = computeTableLayout();

export const currentTableLayout: TableLayoutConfig = {
  id: "current",
  displayName: "Current (1000×926)",
  viewport: { w: legacy.table.w, h: legacy.table.h },
  zones: {
    center: legacy.center,
    hands: legacy.hands,
    discards: legacy.discards,
    walls: legacy.wall,
    playerInfo: legacy.playerInfo,
  },
  layers: DEFAULT_LAYER_TIERS,
};
