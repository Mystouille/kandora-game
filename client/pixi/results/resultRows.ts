import type { MatchView } from "../../store";
import type { HandResult } from "../scene/renderTypes";
import {
  buildResultYakuEntries,
  resultUraDoraIndicators,
  shouldRevealWinScoreDelta,
  shouldRevealWinScoreSummary,
  uraDoraRevealAtMs,
} from "../geometry/resultReveal";
import { RESULT_YAKU_REVEAL_INTERVAL_MS } from "../geometry/renderConstants";
import { sortHand } from "../geometry/tileOrder";
import { splitWinningHandForDisplay } from "../winningHand";
import type {
  ResultLabels,
  ResultRow,
  ResultRowPlan,
  ResultWin,
} from "./resultTypes";

function scoreSummaryLabel(
  win: ResultWin,
  scoreCap: MatchView["scoreCap"],
  hanOnly: boolean
): string {
  const han = win.han ?? 0;
  const fu = win.fu ?? 0;
  const ym = win.yakumanCount ?? 0;
  const capMinHan = {
    mangan: 5,
    haneman: 6,
    baiman: 8,
    sanbaiman: 11,
  } as const;
  const capLabel = {
    mangan: "Mangan",
    haneman: "Haneman",
    baiman: "Baiman",
    sanbaiman: "Sanbaiman",
  } as const;
  const isCapped = scoreCap !== null && (ym > 0 || han >= capMinHan[scoreCap]);
  return isCapped
    ? capLabel[scoreCap]
    : ym > 0
      ? ym > 1
        ? `${ym}× Yakuman`
        : "Yakuman"
      : hanOnly || han >= 5
        ? `${han} han`
        : `${han} han ${fu} fu`;
}

function appendYakuRows(
  rows: ResultRow[],
  entries: ReturnType<typeof buildResultYakuEntries>,
  revealedCount: number
): void {
  // Measure the complete list even while it is hidden so reveal never reflows.
  if (entries.length <= 4) {
    entries.forEach((entry, index) => {
      rows.push({
        kind: "yaku",
        name: entry.name,
        value: entry.value,
        hidden: entry.alwaysHidden || index >= revealedCount,
      });
    });
  } else {
    const half = Math.ceil(entries.length / 2);
    for (let index = 0; index < half; index++) {
      const left = entries[index] ?? null;
      const rightIndex = index + half;
      const right = entries[rightIndex] ?? null;
      if (left === null && right === null) {
        continue;
      }
      rows.push({
        kind: "yaku2",
        left: left ?? { name: "", value: "" },
        right,
        leftHidden:
          left !== null && (left.alwaysHidden || index >= revealedCount),
        rightHidden:
          right !== null && (right.alwaysHidden || rightIndex >= revealedCount),
      });
    }
  }
}

export function buildWinResultRows(
  result: HandResult & { wins: NonNullable<HandResult["wins"]> },
  pageIndex: number,
  stageReveal: boolean,
  revealElapsedMs: number,
  scoreCap: MatchView["scoreCap"],
  uraDoraEnabled: boolean,
  hanOnly: boolean = false
): ResultRowPlan {
  const rows: ResultRow[] = [];
  const total = result.wins.length;
  const win = result.wins[pageIndex];
  if (total > 1) {
    rows.push({
      kind: "label",
      text: `${pageIndex + 1} / ${total}`,
      size: 18,
      color: 0xcbd5e1,
    });
  }
  if (result.reason === "tsumo") {
    rows.push({ kind: "title", text: "Tsumo", size: 36 });
  } else if (result.reason === "ron") {
    rows.push({ kind: "title", text: "Ron", size: 36 });
  }
  const yakuNames = Object.keys(win.yaku ?? {});
  const hasRiichiYaku = yakuNames.some(
    (name) =>
      name === "Riichi" ||
      name === "Double Riichi" ||
      name === "Daburu Riichi" ||
      name === "立直" ||
      name === "ダブル立直" ||
      name === "両立直"
  );
  const reserveUraRow =
    uraDoraEnabled &&
    ((win.uraDoraIndicators?.length ?? 0) > 0 ||
      (win.uraDoraCount !== undefined && hasRiichiYaku));
  const visibleYaku = buildResultYakuEntries(
    win.yaku,
    win.doraCount,
    win.uraDoraCount,
    reserveUraRow,
    uraDoraEnabled
  );
  const revealableYakuCount = visibleYaku.filter(
    (entry) => !entry.alwaysHidden
  ).length;
  const hasUraYaku = visibleYaku.some(
    (entry) => entry.name === "Ura Dora" && !entry.alwaysHidden
  );
  const regularYakuCount = Math.max(
    0,
    revealableYakuCount - (hasUraYaku ? 1 : 0)
  );
  const regularRevealedCount = stageReveal
    ? Math.max(
        0,
        Math.min(
          regularYakuCount,
          Math.floor(revealElapsedMs / RESULT_YAKU_REVEAL_INTERVAL_MS)
        )
      )
    : regularYakuCount;
  const uraRevealed =
    !stageReveal ||
    revealElapsedMs >= uraDoraRevealAtMs(revealableYakuCount, hasUraYaku);
  const revealedYakuCount =
    regularRevealedCount + (hasUraYaku && uraRevealed ? 1 : 0);
  const scoreSummaryRevealed = shouldRevealWinScoreSummary(
    stageReveal,
    revealElapsedMs,
    revealableYakuCount,
    hasUraYaku,
    uraDoraEnabled
  );
  const scoreDeltaRevealed = shouldRevealWinScoreDelta(
    stageReveal,
    revealElapsedMs,
    revealableYakuCount,
    hasUraYaku,
    uraDoraEnabled
  );
  appendYakuRows(rows, visibleYaku, revealedYakuCount);
  rows.push({
    kind: "scoreRow",
    han: scoreSummaryLabel(win, scoreCap, hanOnly),
    pts: typeof win.ten === "number" ? `${win.ten}pts` : null,
    ptsColor: 0xfde68a,
    hidden: !scoreSummaryRevealed,
  });
  if (win.hand && win.hand.length > 0) {
    const { concealed: rawConcealed, agari } = splitWinningHandForDisplay(
      win.hand,
      win.winTile
    );
    const concealed = sortHand(rawConcealed, false) as string[];
    const melds = win.melds
      ?.filter((meld) => meld.tiles.length > 0)
      .map((meld) => ({
        ...meld,
        from:
          meld.from === null
            ? null
            : (((meld.from - win.seat + 4) % 4) as 0 | 1 | 2 | 3),
      }));
    rows.push({ kind: "hand", concealed, winTile: agari, melds });
  }
  const sharedDora =
    result.wins.find((candidate) => candidate.doraIndicators?.length)
      ?.doraIndicators ?? [];
  rows.push({
    kind: "tiles",
    tiles: Array.from({ length: 5 }, (_, index) =>
      index < sharedDora.length ? (sharedDora[index] ?? null) : null
    ),
  });
  const sharedUra = resultUraDoraIndicators(uraDoraEnabled, result.wins);
  let uraIndicatorsRevealed = false;
  if (sharedUra.length > 0) {
    uraIndicatorsRevealed =
      !stageReveal ||
      (revealedYakuCount >= revealableYakuCount &&
        revealElapsedMs >= uraDoraRevealAtMs(revealableYakuCount, hasUraYaku));
    rows.push({
      kind: "tiles",
      tiles: uraIndicatorsRevealed
        ? Array.from({ length: 5 }, (_, index) =>
            index < sharedUra.length ? (sharedUra[index] ?? null) : null
          )
        : Array.from({ length: 5 }, () => null),
    });
  }
  return {
    rows,
    revealedYakuCount,
    hasUraYaku,
    uraIndicatorsRevealed,
    scoreSummaryRevealed,
    scoreDeltaRevealed,
  };
}

export function buildNonWinResultRows(
  result: HandResult,
  seatNames: MatchView["seatNames"],
  labels: ResultLabels
): ResultRow[] {
  const rows: ResultRow[] = [];
  if (result.buuChombo) {
    const reasonLabel =
      result.buuChombo.reason === "sinking_win_not_floating"
        ? labels.chomboReasons.sinkingWinNotFloating
        : result.buuChombo.reason === "game_ending_win_not_first"
          ? labels.chomboReasons.gameEndingWinNotFirst
          : labels.chomboReasons.gameEndingChinmai;
    rows.push({
      kind: "title",
      text: labels.chomboTitle.replace("{reason}", reasonLabel),
      size: 28,
    });
    for (let seat = 0; seat < 4; seat++) {
      const name = seatNames?.[seat] || `Player ${seat + 1}`;
      const total = result.buuChombo.chips[seat];
      const delta = result.buuChombo.chipDelta[seat];
      const sign = delta > 0 ? "+" : "";
      const color = delta < 0 ? 0xff6b6b : delta > 0 ? 0x86efac : 0xcbd5e1;
      rows.push({
        kind: "label",
        text: `${name}: ${total} (${sign}${delta})`,
        size: 20,
        color,
      });
    }
  } else if (result.reason === "exhaustive_draw") {
    rows.push({ kind: "title", text: labels.exhaustiveDraw, size: 32 });
  } else if (result.reason === "abort") {
    const kindLabel =
      result.abortKind === "kyuushuu"
        ? labels.abortKinds.kyuushuu
        : result.abortKind === "suufon_renda"
          ? labels.abortKinds.suufonRenda
          : result.abortKind === "suucha_riichi"
            ? labels.abortKinds.suuchaRiichi
            : result.abortKind === "sanchahou"
              ? labels.abortKinds.sanchahou
              : labels.abortKinds.unknown;
    rows.push({
      kind: "title",
      text: labels.abortTitle.replace("{kind}", kindLabel),
      size: 28,
    });
  }
  return rows;
}
