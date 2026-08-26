import {
  DEFAULT_LAYER_TIERS,
  type TableLayoutConfig,
} from "../tableLayout";
import { currentTableLayout } from "./currentTableLayout";

const hands = currentTableLayout.zones.hands;

export const compactWebTableLayout: TableLayoutConfig = {
  id: "compact-web",
  displayName: "Compact web (1000x926)",
  viewport: { w: 1000, h: 926 },
  felt: { x: 0, y: 0, w: 1000, h: 926 },
  zones: {
    center: { x: 350, y: 306, w: 300, h: 260 },
    hands: [
      { ...hands[0] },
      { ...hands[1] },
      { ...hands[2] },
      { ...hands[3] },
    ],
    discards: [
      { x: 350, y: 566, w: 300, h: 187 },
      { x: 650, y: 306, w: 182, h: 260 },
      { x: 350, y: 119, w: 300, h: 187 },
      { x: 168, y: 306, w: 182, h: 260 },
    ],
    walls: [
      { x: 350, y: 787, w: 300, h: 1 },
      { x: 943, y: 306, w: 1, h: 260 },
      { x: 350, y: 65, w: 300, h: 1 },
      { x: 56, y: 306, w: 1, h: 260 },
    ],
    playerInfo: [
      { x: 650, y: 566, w: 0, h: 180 },
      { x: 650, y: 126, w: 0, h: 180 },
      { x: 350, y: 126, w: 0, h: 180 },
      { x: 350, y: 566, w: 0, h: 180 },
    ],
  },
  layers: DEFAULT_LAYER_TIERS,
};