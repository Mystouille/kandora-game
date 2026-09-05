import {
  DEFAULT_LAYER_TIERS,
  type TableLayout,
  type TableLayoutConfig,
} from "../tableLayout";
import {
  discardScaleForTargetSpan,
  type DiscardLayoutOptions,
} from "../tileAreaLayout";
import type { TileDesign } from "../tiles/tileDesign";

export const MOBILE_PLAY_AREA_INSET = 102;
export const MOBILE_DISCARD_PANEL_PADDING = 0;

const CENTER_X = 512;
const CENTER_Y = 225;
const CENTER_WIDTH = 256;
const CENTER_HEIGHT = 200;
const HORIZONTAL_DISCARD_DEPTH = 120;
const SIDE_DISCARD_DEPTH = 190;
const FOCUSED_HAND_Y = 585;

export function mobileDiscardLayoutOptions(
  design: TileDesign,
  layout: TableLayout
): DiscardLayoutOptions {
  return {
    scale: discardScaleForTargetSpan(
      design,
      0,
      layout.center.w,
      18
    ),
  };
}

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
    center: {
      x: CENTER_X,
      y: CENTER_Y,
      w: CENTER_WIDTH,
      h: CENTER_HEIGHT,
    },
    hands: [
      { x: 0, y: FOCUSED_HAND_Y, w: 1280, h: 720 - FOCUSED_HAND_Y },
      { x: 1280 - MOBILE_PLAY_AREA_INSET - 56, y: 65, w: 56, h: 517 },
      { x: 200, y: 0, w: 880, h: 65 },
      { x: MOBILE_PLAY_AREA_INSET, y: 65, w: 56, h: 517 },
    ],
    discards: [
      {
        x: CENTER_X,
        y: CENTER_Y + CENTER_HEIGHT,
        w: CENTER_WIDTH,
        h: HORIZONTAL_DISCARD_DEPTH,
      },
      {
        x: CENTER_X + CENTER_WIDTH,
        y: CENTER_Y,
        w: SIDE_DISCARD_DEPTH,
        h: CENTER_HEIGHT,
      },
      {
        x: CENTER_X,
        y: CENTER_Y - HORIZONTAL_DISCARD_DEPTH,
        w: CENTER_WIDTH,
        h: HORIZONTAL_DISCARD_DEPTH,
      },
      {
        x: CENTER_X - SIDE_DISCARD_DEPTH,
        y: CENTER_Y,
        w: SIDE_DISCARD_DEPTH,
        h: CENTER_HEIGHT,
      },
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
      {
        x: CENTER_X + CENTER_WIDTH,
        y: CENTER_Y + CENTER_HEIGHT,
        w: SIDE_DISCARD_DEPTH,
        h: HORIZONTAL_DISCARD_DEPTH,
      },
      {
        x: CENTER_X + CENTER_WIDTH,
        y: CENTER_Y - HORIZONTAL_DISCARD_DEPTH,
        w: SIDE_DISCARD_DEPTH,
        h: HORIZONTAL_DISCARD_DEPTH,
      },
      {
        x: CENTER_X - SIDE_DISCARD_DEPTH,
        y: CENTER_Y - HORIZONTAL_DISCARD_DEPTH,
        w: SIDE_DISCARD_DEPTH,
        h: HORIZONTAL_DISCARD_DEPTH,
      },
      {
        x: CENTER_X - SIDE_DISCARD_DEPTH,
        y: CENTER_Y + CENTER_HEIGHT,
        w: SIDE_DISCARD_DEPTH,
        h: HORIZONTAL_DISCARD_DEPTH,
      },
    ],
  },
  layers: DEFAULT_LAYER_TIERS,
};