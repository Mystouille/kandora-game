import type { MatchView } from "../../store";
import { sortYakuRecord } from "~/game/protocol/yakuOrder";
import type { Seat } from "../tableGeometry";
import type { HandResult } from "../scene/renderTypes";
import {
  RESULT_SCORE_REVEAL_WITHOUT_URA_MS,
  RESULT_URA_REVEAL_AFTER_LAST_YAKU_MS,
  RESULT_YAKU_REVEAL_INTERVAL_MS,
} from "./renderConstants";

export function activePlayerIndicatorSeat(
  view: Pick<MatchView, "hands" | "melds" | "lastHandResult" | "matchEnded">
): Seat | null {
  if (view.lastHandResult || view.matchEnded) {
    return null;
  }
  for (let seat = 0; seat < 4; seat++) {
    const structuralHandSize =
      (view.hands[seat]?.length ?? 0) + (view.melds[seat]?.length ?? 0) * 3;
    if (structuralHandSize === 14) {
      return seat as Seat;
    }
  }
  return null;
}

export function advanceMatchEndRevealSound(
  playedForCurrentMatchEnd: boolean,
  matchEnded: boolean,
  screenRendered: boolean
): { play: boolean; nextPlayed: boolean } {
  if (!matchEnded) {
    return { play: false, nextPlayed: false };
  }
  if (screenRendered && !playedForCurrentMatchEnd) {
    return { play: true, nextPlayed: true };
  }
  return { play: false, nextPlayed: playedForCurrentMatchEnd };
}

export function formatTableScore(
  score: number,
  focusedScore: number,
  relative: boolean
): string {
  if (!relative) {
    return `${score}`;
  }
  const difference = score - focusedScore;
  return difference > 0 ? `+${difference}` : `${difference}`;
}

export function shouldStageWinReveal(
  stagedRevealEnabled: boolean,
  hasHandResultOverride: boolean
): boolean {
  return stagedRevealEnabled && !hasHandResultOverride;
}

export function handResultDealerSeat(
  result: HandResult,
  currentDealer: Seat
): Seat {
  return result.dealer ?? currentDealer;
}

export function shouldRevealWinScoreSummary(
  stageReveal: boolean,
  revealElapsedMs: number,
  visibleYakuCount: number,
  hasUraYaku: boolean,
  uraDoraEnabled = true
): boolean {
  if (!stageReveal) {
    return true;
  }
  const regularYakuCount = Math.max(0, visibleYakuCount - (hasUraYaku ? 1 : 0));
  const lastRegularYakuRevealAtMs =
    regularYakuCount * RESULT_YAKU_REVEAL_INTERVAL_MS;
  const summaryRevealAtMs = uraDoraEnabled
    ? lastRegularYakuRevealAtMs + RESULT_URA_REVEAL_AFTER_LAST_YAKU_MS
    : lastRegularYakuRevealAtMs + RESULT_SCORE_REVEAL_WITHOUT_URA_MS;
  return revealElapsedMs >= summaryRevealAtMs;
}

export function uraDoraRevealAtMs(
  visibleYakuCount: number,
  hasUraYaku: boolean
): number {
  const regularYakuCount = Math.max(0, visibleYakuCount - (hasUraYaku ? 1 : 0));
  return (
    regularYakuCount * RESULT_YAKU_REVEAL_INTERVAL_MS +
    RESULT_URA_REVEAL_AFTER_LAST_YAKU_MS
  );
}

export function shouldRevealWinScoreDelta(
  stageReveal: boolean,
  revealElapsedMs: number,
  visibleYakuCount: number,
  hasUraYaku = false,
  uraDoraEnabled = true
): boolean {
  return shouldRevealWinScoreSummary(
    stageReveal,
    revealElapsedMs,
    visibleYakuCount,
    hasUraYaku,
    uraDoraEnabled
  );
}

export function winResultRevealKey(
  view: Pick<MatchView, "roundWind" | "roundNumber" | "honba" | "dealer">,
  result: HandResult
): string {
  return `${view.roundWind}:${view.roundNumber}:${view.honba}:${view.dealer}:${JSON.stringify(result)}`;
}

export function buildResultYakuEntries(
  yaku: Record<string, string> | undefined,
  doraCount: number | undefined,
  uraDoraCount: number | undefined,
  reserveUraRow: boolean,
  uraDoraEnabled = true
): Array<{ name: string; value: string; alwaysHidden: boolean }> {
  const entries = Object.entries(sortYakuRecord(yaku ?? {}))
    .filter(([name]) => uraDoraEnabled || name !== "Ura Dora")
    .map(([name, value]) => ({
      name,
      value,
      alwaysHidden: false,
    }));
  const setCount = (name: string, count: number, keepZero: boolean): void => {
    const index = entries.findIndex((entry) => entry.name === name);
    if (count === 0 && !keepZero) {
      if (index >= 0) {
        entries.splice(index, 1);
      }
      return;
    }
    const entry = {
      name,
      value: `${count}飜`,
      alwaysHidden: count === 0,
    };
    if (index >= 0) {
      entries[index] = entry;
    } else {
      entries.push(entry);
    }
  };

  if (doraCount !== undefined) {
    setCount("Dora", doraCount, false);
  }
  if (uraDoraEnabled && (uraDoraCount !== undefined || reserveUraRow)) {
    setCount("Ura Dora", uraDoraCount ?? 0, true);
  }
  const filtered = entries.filter((entry) => {
    const count = parseInt(entry.value, 10);
    if (Number.isFinite(count) && count === 0) {
      return entry.name === "Ura Dora";
    }
    return true;
  });
  const uraIndex = filtered.findIndex((entry) => entry.name === "Ura Dora");
  if (uraIndex >= 0 && uraIndex !== filtered.length - 1) {
    const [ura] = filtered.splice(uraIndex, 1);
    filtered.push(ura);
  }
  return filtered;
}

export function resultUraDoraIndicators(
  uraDoraEnabled: boolean,
  wins: NonNullable<HandResult["wins"]>
): string[] {
  if (!uraDoraEnabled) {
    return [];
  }
  return (
    wins.find(
      (win) =>
        win.uraDoraIndicators !== undefined && win.uraDoraIndicators.length > 0
    )?.uraDoraIndicators ?? []
  );
}
