import type { MatchView } from "../../store";

export const SMALL_TILE_SRC = { w: 86, h: 130 } as const;
export const SMALL_TILE_SCALE = 0.5 * (1 - 0.094);
export const SMALL_TILE_W = SMALL_TILE_SRC.w * SMALL_TILE_SCALE;
export const SMALL_TILE_H = SMALL_TILE_SRC.h * SMALL_TILE_SCALE;
export const SIDE_TILE_SRC = { w: 116, h: 107 } as const;
export const SIDE_TILE_SCALE = 0.5 * (1 - 0.094);
export const SIDE_TILE_W = SIDE_TILE_SRC.w * SIDE_TILE_SCALE;
export const SIDE_TILE_H = SIDE_TILE_SRC.h * SIDE_TILE_SCALE;
export const BIG_TILE_SRC = { w: 131, h: 198 } as const;
export const BIG_TILE_SCALE = 0.491;
export const BIG_TILE_W = BIG_TILE_SRC.w * BIG_TILE_SCALE;
export const BIG_TILE_H = BIG_TILE_SRC.h * BIG_TILE_SCALE;
export const DISCARD_ROW_OVERLAP_HORIZ = 14.5;
export const TSUMO_GAP = 8;
export const TSUMOGIRI_FRESH_TINT = 0xc8c8c8;
export const TSUMOGIRI_FRESH_WINDOW = 3;
export const SEAT_CONTAINER_ROT = [
  0,
  -Math.PI / 2,
  Math.PI,
  Math.PI / 2,
] as const;
export const SHADOW_LAYER_Z = -1_000_000;
export const DISCARD_SHADOW_Z_INDEX = -5;
export const RIICHI_STICK_Z_INDEX = 0;
export const BG_COLOR = 0x2a2a2a;
export const FELT_COLOR = 0x007f0e;
export const HAND_PANEL_RADIUS = 4;
export const HAND_PANEL_ALPHA = 0.16;
export const PLAYER_PANEL_SIZE = 120;
export const PLAYER_PANEL_GAP = 26;
export const PLAYER_PANEL_LINK_WIDTH = 28;
export const PLAYER_PANEL_ALPHA = 0.28;
export const PLAYER_PANEL_CONTENT_Z = -9;
export const TEAM_LOGO_Z_INDEX = -9;
export const RELATIVE_SCORE_DISPLAY_MS = 4_000;
export const HAND_HOVER_TINT = 0xffaaaa;
export const RIICHI_UNAVAILABLE_TINT = 0xb0b0b0;
export const DRAG_DISCARD_READY_DARKEN_FACTOR = 0.78;
export const RESULT_SCORE_BOX_WIDTH = 220;
export const RESULT_SCORE_BOX_HEIGHT = 88;
export const RESULT_SCORE_BOX_PAD_X = 18;
export const RESULT_SCORE_BOX_NAME_GAP = 8;
export const RESULT_YAKU_REVEAL_INTERVAL_MS = 750;
export const RESULT_URA_REVEAL_AFTER_LAST_YAKU_MS = 2000;
export const RESULT_SCORE_REVEAL_WITHOUT_URA_MS = 750;
export const CALL_EFFECT_GAP_FRACTION = 0.42;
export const CALL_EFFECT_Z_INDEX = 900;
export const DISCARD_LAYER_BASE_Z = 3;
export const WIND_KANJI = ["東", "南", "西", "北"] as const;
export const ROUND_WIND_KANJI: Record<MatchView["roundWind"], string> = {
  E: "東",
  S: "南",
  W: "西",
  N: "北",
};
export const KANJI_FONT_FAMILY =
  '"Yuji Syuku", "Yu Mincho", "Hiragino Mincho ProN", serif';
