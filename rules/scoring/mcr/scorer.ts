/*
 * Public normalization for the scorer ported from SkyEye-FAST/mcr-mahjong
 * v0.1.0 (7d772b66adcf0e8316123f66b350c5cb9d71a7ca), which derives from
 * Jeff Wang's summerinsects/mahjong-algorithm at
 * 44a178af08bf11f82a8993fddbe2fe8876ddd8f3. MIT licensed; see
 * THIRD_PARTY_NOTICES.md.
 */
import { isMcrWinningShape } from "~/core/mahjong/rules/mcrShanten";
import { MCR_FANS, MCR_FAN_IDS, type McrFanId } from "./fans";
import {
  MIXED_KONG_MARKER,
  calculateRaw,
  fanGet,
  fanSet,
  publicFanTotal,
  type FanTable,
} from "./fanCalculator";
import {
  KONG,
  PUNG,
  packMeld,
  packTile,
  packType,
  physicalCounts,
  sameRank,
  tileCode,
} from "./internalTiles";
import type {
  McrAwardedFan,
  McrMeldInput,
  McrNotWinningScore,
  McrScoreInput,
  McrScoreResult,
  McrWinContext,
} from "./types";

const NOT_WINNING: McrNotWinningScore = Object.freeze({
  isWinningShape: false,
  fans: Object.freeze([]) as readonly [],
  totalFan: 0,
  nonFlowerFan: 0,
  meetsMinimum: false,
});

const WIND_INDEX = { E: 0, S: 1, W: 2, N: 3 } as const;

/**
 * Scores one Kandora-shaped hand. Structural qualification is delegated to the
 * shared MCR core; this slice deliberately contains no shanten implementation.
 */
export function scoreMcr(input: McrScoreInput): McrScoreResult {
  const winningShape = isMcrWinningShape(
    input.hand,
    input.melds ?? [],
    input.winTile
  );
  const normalized = normalizeInput(input);
  if (!winningShape) {
    return NOT_WINNING;
  }

  const raw = calculateRaw(
    normalized.tiles,
    normalized.fixedPacks,
    normalized.winTile,
    contextFlags(normalized.context),
    WIND_INDEX[
      normalized.context.roundWind ??
        normalized.context.prevalentWind ??
        "E"
    ],
    WIND_INDEX[normalized.context.seatWind ?? "E"],
    normalized.context.flowerCount ?? 0,
    (table, packs) =>
      normalizeCandidate(
        table,
        packs,
        normalized.melds,
        normalized.context,
        normalized.counts
      )
  );
  if (raw.total === -3) {
    return NOT_WINNING;
  }
  if (raw.total < 0) {
    throw new Error(`Invalid MCR calculator input (${raw.total})`);
  }

  const fans = Object.freeze(
    MCR_FAN_IDS.filter((id) => fanGet(raw.table, id) > 0).map((id) =>
      awardedFan(
        id,
        fanGet(raw.table, id),
        id === "TWO_MELDED_KONGS" &&
          fanGet(raw.table, MIXED_KONG_MARKER) !== 0
      )
    )
  );
  const totalFan = fans.reduce(
    (total, fan) => total + fan.awardedPoints,
    0
  );
  if (totalFan !== raw.total) {
    throw new Error("MCR scoring breakdown does not match selected candidate");
  }
  const flowerPoints =
    fans.find((fan) => fan.id === "FLOWER_TILES")?.awardedPoints ?? 0;
  const nonFlowerFan = totalFan - flowerPoints;
  return Object.freeze({
    isWinningShape: true,
    fans,
    totalFan,
    nonFlowerFan,
    meetsMinimum: nonFlowerFan >= 8,
  });
}

interface NormalizedInput {
  readonly tiles: readonly number[];
  readonly fixedPacks: readonly number[];
  readonly winTile: number;
  readonly melds: readonly McrMeldInput[];
  readonly context: McrWinContext;
  readonly counts: Int32Array;
}

function normalizeInput(input: McrScoreInput): NormalizedInput {
  const melds = input.melds ?? [];
  if (melds.length > 4 || input.hand.length + melds.length * 3 !== 13) {
    throw new Error(
      "Expected hand length + three times meld count to equal thirteen"
    );
  }
  const fixedPacks = melds.map(packMeld);
  const counts = physicalCounts(input.hand, melds, input.winTile);
  if (Array.from(counts).some((count) => count > 4)) {
    throw new Error("A tile occurs more than four times");
  }
  validateContext(input.context);
  return {
    tiles: input.hand.map(tileCode),
    fixedPacks,
    winTile: tileCode(input.winTile),
    melds,
    context: input.context,
    counts,
  };
}

function validateContext(context: McrWinContext): void {
  if (context.method !== "discard" && context.method !== "self-draw") {
    throw new Error(`Invalid MCR win method: ${String(context.method)}`);
  }
  const flowers = context.flowerCount ?? 0;
  if (!Number.isInteger(flowers) || flowers < 0 || flowers > 8) {
    throw new RangeError("flowerCount must be an integer from zero through eight");
  }
  if (context.lastTileDraw && context.lastTileClaim) {
    throw new Error("A win cannot be both last-tile draw and last-tile claim");
  }
  if (
    context.roundWind &&
    context.prevalentWind &&
    context.roundWind !== context.prevalentWind
  ) {
    throw new Error("roundWind and prevalentWind must agree when both are set");
  }
  if (
    context.method === "self-draw" &&
    (context.lastTileClaim || context.robbingPromotedKong)
  ) {
    throw new Error("Self-draw cannot claim the last tile or rob a kong");
  }
  if (
    context.method === "discard" &&
    (context.lastTileDraw || context.replacementTile)
  ) {
    throw new Error("A discard win cannot be a last draw or replacement draw");
  }
}

function contextFlags(context: McrWinContext): number {
  let flags = context.method === "self-draw" ? 1 : 0;
  if (context.lastCopy) {
    flags |= 2;
  }
  if (context.replacementTile || context.robbingPromotedKong) {
    flags |= 4;
  }
  if (context.lastTileDraw || context.lastTileClaim) {
    flags |= 8;
  }
  return flags;
}

function normalizeCandidate(
  table: FanTable,
  packs: readonly number[] | null,
  melds: readonly McrMeldInput[],
  context: McrWinContext,
  counts: Int32Array
): number {
  if (fanGet(table, MIXED_KONG_MARKER) !== 0) {
    fanSet(table, "TWO_MELDED_KONGS", 1);
  }

  if (fanGet(table, "ALL_GREEN") !== 0 && counts[0x46] > 0) {
    fanSet(table, "HALF_FLUSH", 1);
  }

  const concealedKongs = melds.filter((meld) => meld.type === "ankan").length;
  if (
    fanGet(table, "THREE_KONGS") !== 0 ||
    fanGet(table, "FOUR_KONGS") !== 0
  ) {
    if (concealedKongs === 1) {
      fanSet(table, "CONCEALED_KONG", 1);
    } else if (concealedKongs === 2) {
      fanSet(table, "TWO_CONCEALED_KONGS", 1);
      fanSet(table, "TWO_CONCEALED_PUNGS", 0);
    }
  }

  if (
    context.method === "self-draw" &&
    [
      "NINE_GATES",
      "SEVEN_SHIFTED_PAIRS",
      "THIRTEEN_ORPHANS",
      "FOUR_CONCEALED_PUNGS",
      "SEVEN_PAIRS",
      "GREATER_HONORS_AND_KNITTED_TILES",
      "LESSER_HONORS_AND_KNITTED_TILES",
    ].some((id) => fanGet(table, id as McrFanId) !== 0)
  ) {
    fanSet(table, "SELF_DRAWN", 0);
    fanSet(table, "FULLY_CONCEALED_HAND", 1);
  }

  if (
    fanGet(table, "ALL_TERMINALS") !== 0 &&
    fanGet(table, "TRIPLE_PUNG") === 0 &&
    packs
  ) {
    const pungs = packs
      .filter((value) => packType(value) === PUNG || packType(value) === KONG)
      .map(packTile);
    let doublePungs = 0;
    for (let first = 0; first < pungs.length; first++) {
      for (let second = first + 1; second < pungs.length; second++) {
        if (sameRank(pungs[first], pungs[second])) {
          doublePungs++;
        }
      }
    }
    fanSet(table, "DOUBLE_PUNG", doublePungs);
  }

  const otherNonFlowerFan = MCR_FAN_IDS.filter(
    (id) => id !== "CHICKEN_HAND" && id !== "FLOWER_TILES"
  ).reduce(
    (total, id) => total + MCR_FANS[id].points * fanGet(table, id),
    0
  );
  fanSet(table, "CHICKEN_HAND", otherNonFlowerFan === 0 ? 1 : 0);

  return (
    publicFanTotal(table) +
    (fanGet(table, MIXED_KONG_MARKER) !== 0 ? 2 : 0)
  );
}

function awardedFan(
  id: McrFanId,
  count: number,
  mixedKongPair: boolean
): McrAwardedFan {
  const definition = MCR_FANS[id];
  return Object.freeze({
    id,
    englishName: definition.englishName,
    value: definition.points,
    count,
    awardedPoints: mixedKongPair ? 6 : definition.points * count,
  });
}
