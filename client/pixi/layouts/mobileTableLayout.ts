import {
  DEFAULT_LAYER_TIERS,
  type TableLayoutConfig,
} from "../tableLayout";

export const MOBILE_PLAY_AREA_INSET = 102;

export const mobileTableLayout: TableLayoutConfig = {
  id: "mobile",
  displayName: "Mobile landscape (1280x720)",
  viewport: { w: 1280, h: 720 },
  felt: {
    x: MOBILE_PLAY_AREA_INSET,
    y: 0,
    w: 1280 - MOBILE_PLAY_AREA_INSET * 2,
    h: 720,
  },
  zones: {
    center: { x: 508, y: 225, w: 264, h: 220 },
    hands: [
      { x: 0, y: 605, w: 1280, h: 115 },
      { x: 1280 - MOBILE_PLAY_AREA_INSET - 56, y: 65, w: 56, h: 517 },
      { x: 200, y: 0, w: 880, h: 65 },
      { x: MOBILE_PLAY_AREA_INSET, y: 65, w: 56, h: 517 },
    ],
    discards: [
      { x: 508, y: 445, w: 264, h: 120 },
      { x: 772, y: 225, w: 190, h: 220 },
      { x: 508, y: 105, w: 264, h: 120 },
      { x: 318, y: 225, w: 190, h: 220 },
    ],
    walls: [
      { x: 300, y: 572, w: 680, h: 10 },
      {
        x: 1280 - MOBILE_PLAY_AREA_INSET - 56 - 10,
        y: 65,
        w: 10,
        h: 517,
      },
      { x: 300, y: 55, w: 680, h: 10 },
      { x: MOBILE_PLAY_AREA_INSET + 56, y: 65, w: 10, h: 517 },
    ],
    playerInfo: [
      { x: 772, y: 445, w: 190, h: 120 },
      { x: 772, y: 105, w: 190, h: 120 },
      { x: 318, y: 105, w: 190, h: 120 },
      { x: 318, y: 445, w: 190, h: 120 },
    ],
  },
  layers: DEFAULT_LAYER_TIERS,
};