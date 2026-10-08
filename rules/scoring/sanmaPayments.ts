import type { SanmaType } from "../../protocol/seat";
import type { Wind } from "../types";
import type { RiichiRaw } from "./riichiAdapter";

export type ScoreCap = "mangan" | "haneman" | "baiman" | "sanbaiman";

export const SCORE_CAP_BASE: Readonly<Record<ScoreCap, number>> = {
  mangan: 2000,
  haneman: 3000,
  baiman: 4000,
  sanbaiman: 6000,
};

interface KansaiRow {
  maxHan: number;
  name: string;
  dealerRon: number;
  dealerEach: number;
  ron: number;
  other: number;
  dealer: number;
}

const KANSAI_ROWS: readonly KansaiRow[] = [
  {
    maxHan: 1,
    name: "",
    dealerRon: 2000,
    dealerEach: 1000,
    ron: 1000,
    other: 1000,
    dealer: 1000,
  },
  {
    maxHan: 2,
    name: "",
    dealerRon: 3000,
    dealerEach: 2000,
    ron: 2000,
    other: 1000,
    dealer: 1000,
  },
  {
    maxHan: 3,
    name: "",
    dealerRon: 6000,
    dealerEach: 3000,
    ron: 4000,
    other: 1000,
    dealer: 3000,
  },
  {
    maxHan: 5,
    name: "満貫",
    dealerRon: 12000,
    dealerEach: 6000,
    ron: 8000,
    other: 3000,
    dealer: 5000,
  },
  {
    maxHan: 7,
    name: "跳満",
    dealerRon: 18000,
    dealerEach: 9000,
    ron: 12000,
    other: 4000,
    dealer: 8000,
  },
  {
    maxHan: 10,
    name: "倍満",
    dealerRon: 24000,
    dealerEach: 12000,
    ron: 16000,
    other: 6000,
    dealer: 10000,
  },
  {
    maxHan: 12,
    name: "三倍満",
    dealerRon: 36000,
    dealerEach: 18000,
    ron: 24000,
    other: 8000,
    dealer: 16000,
  },
  {
    maxHan: Infinity,
    name: "数え役満",
    dealerRon: 48000,
    dealerEach: 24000,
    ron: 32000,
    other: 12000,
    dealer: 20000,
  },
];

const CAP_ROW: Readonly<Record<ScoreCap, number>> = {
  mangan: 3,
  haneman: 4,
  baiman: 5,
  sanbaiman: 6,
};

const WIND_NAMES: Readonly<Record<Wind, string>> = {
  E: "東",
  S: "南",
  W: "西",
  N: "北",
};

export interface SanmaPaymentContext {
  tsumo: boolean;
  sanmaType?: SanmaType;
  roundWind?: Wind;
  seatWind?: Wind;
  kiriageMangan?: boolean;
  scoreCap?: ScoreCap | null;
}

interface Payments {
  oya: number[];
  ko: number[];
}

function kansaiPayments(
  row: KansaiRow,
  tsumo: boolean,
  multiple = 1
): Payments {
  return tsumo
    ? {
        oya: [row.dealerEach * multiple, row.dealerEach * multiple],
        ko: [row.dealer * multiple, row.other * multiple],
      }
    : {
        oya: [row.dealerRon * multiple],
        ko: [row.ron * multiple],
      };
}

function onlineBasePayments(base: number, tsumo: boolean): Payments {
  return tsumo
    ? { oya: [base * 2, base * 2], ko: [base * 2, base] }
    : { oya: [base * 6], ko: [base * 4] };
}

function paymentTotal(payments: Payments, isDealer: boolean): number {
  return (isDealer ? payments.oya : payments.ko).reduce(
    (sum, amount) => sum + amount,
    0
  );
}

function formatText(result: RiichiRaw, context: SanmaPaymentContext): string {
  const round = WIND_NAMES[context.roundWind ?? "E"];
  const seat = WIND_NAMES[context.seatWind ?? "S"];
  let text = `(${round}場${seat}家)${context.tsumo ? "自摸" : "栄和"}`;
  if (result.yakuman === 0) {
    const fu = context.sanmaType === "kansai" ? "" : `${result.fu}符`;
    text += ` ${fu}${result.han}飜`;
  }
  if (result.name) {
    text += ` ${result.name}`;
  }
  text += ` ${result.ten}点`;
  if (context.tsumo) {
    text +=
      context.seatWind === "E"
        ? `(${result.oya[0]}all)`
        : `(${result.ko[0]},${result.ko[1]})`;
  }
  return text;
}

/** Price each candidate, before riichi.calc() chooses its winning interpretation. */
export function applySanmaPayments(
  result: RiichiRaw,
  context: SanmaPaymentContext
): void {
  if (
    !result.isAgari ||
    result.error ||
    (result.han === 0 && result.yakuman === 0)
  ) {
    return;
  }
  const isDealer = context.seatWind === "E";
  if (context.sanmaType === "kansai") {
    const yakumanRow = KANSAI_ROWS[KANSAI_ROWS.length - 1];
    const row =
      result.yakuman > 0
        ? yakumanRow
        : (KANSAI_ROWS.find((candidate) => result.han <= candidate.maxHan) ??
          yakumanRow);
    Object.assign(
      result,
      kansaiPayments(row, context.tsumo, result.yakuman || 1)
    );
    result.name =
      result.yakuman > 0
        ? result.yakuman > 1
          ? `${result.yakuman}倍役満`
          : "役満"
        : row.name;
  } else {
    result.oya = result.oya.slice(0, context.tsumo ? 2 : 1);
    result.ko = result.ko.slice(0, context.tsumo ? 2 : 1);
    if (
      context.kiriageMangan &&
      result.yakuman === 0 &&
      ((result.han === 4 && result.fu === 30) ||
        (result.han === 3 && result.fu === 60))
    ) {
      Object.assign(
        result,
        onlineBasePayments(SCORE_CAP_BASE.mangan, context.tsumo)
      );
      result.name = "満貫";
    }
  }
  result.ten = paymentTotal(result, isDealer);

  if (context.scoreCap) {
    const row = KANSAI_ROWS[CAP_ROW[context.scoreCap]];
    const cap =
      context.sanmaType === "kansai"
        ? kansaiPayments(row, context.tsumo)
        : onlineBasePayments(SCORE_CAP_BASE[context.scoreCap], context.tsumo);
    const capTen = paymentTotal(cap, isDealer);
    if (result.ten > capTen) {
      Object.assign(result, cap);
      result.ten = capTen;
      result.name = row.name;
    }
  }
  result.text = formatText(result, context);
}
