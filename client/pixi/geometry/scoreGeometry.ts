import type { Rect } from "../tableLayout";
import type { TableRendererPresentation } from "../scene/renderTypes";
import {
  RESULT_SCORE_BOX_HEIGHT,
  RESULT_SCORE_BOX_NAME_GAP,
  RESULT_SCORE_BOX_PAD_X,
  RESULT_SCORE_BOX_WIDTH,
} from "./renderConstants";

export function scoreCartridgeMetrics(center: Rect): {
  width: number;
  height: number;
  inset: number;
  bottomTop: number;
} {
  const width = Math.round(center.w * 0.5);
  const height = Math.round(center.h * 0.16);
  const inset = Math.round(center.h * 0.08);
  return {
    width,
    height,
    inset,
    bottomTop: center.y + center.h - inset - height,
  };
}

export function scoreCartridgeTextLayout(
  chipWidth: number,
  chipHeight: number,
  presentation: TableRendererPresentation = "standard"
): { scoreRightX: number; seatIndicatorLeftX: number } {
  const scoreRightMargin = Math.round(
    chipHeight * (presentation === "mobile" ? 0.12 : 0.35)
  );
  const seatIndicatorLeftMargin = Math.round(chipHeight * 0.12);
  return {
    scoreRightX: chipWidth / 2 - scoreRightMargin,
    seatIndicatorLeftX: -chipWidth / 2 + seatIndicatorLeftMargin,
  };
}

export function scoreCartridgeScoreScale(
  chipWidth: number,
  chipHeight: number,
  scoreWidth: number,
  seatIndicatorWidth: number
): number {
  if (scoreWidth <= 0) {
    return 1;
  }
  const { scoreRightX, seatIndicatorLeftX } = scoreCartridgeTextLayout(
    chipWidth,
    chipHeight,
    "mobile"
  );
  const contentGap = Math.max(1, Math.round(chipHeight * 0.06));
  const availableWidth = Math.max(
    0,
    scoreRightX - (seatIndicatorLeftX + seatIndicatorWidth + contentGap)
  );
  return Math.min(1, availableWidth / scoreWidth);
}

export function scoreCartridgeFontSize(
  chipHeight: number,
  presentation: TableRendererPresentation
): number {
  return Math.max(
    12,
    Math.round(chipHeight * (presentation === "mobile" ? 0.68 : 0.6))
  );
}

export function resultScoreBoxLayout(
  nameWidth: number,
  dealerWidth: number
): { width: number; height: number; nameScale: number } {
  const dealerGap = dealerWidth > 0 ? RESULT_SCORE_BOX_NAME_GAP : 0;
  const maxNameWidth = Math.max(
    0,
    RESULT_SCORE_BOX_WIDTH -
      RESULT_SCORE_BOX_PAD_X * 2 -
      dealerWidth -
      dealerGap
  );
  return {
    width: RESULT_SCORE_BOX_WIDTH,
    height: RESULT_SCORE_BOX_HEIGHT,
    nameScale:
      nameWidth > maxNameWidth && nameWidth > 0 ? maxNameWidth / nameWidth : 1,
  };
}
