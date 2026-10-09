/**
 * Scoring — translates a winning hand into the input format expected
 * by the `riichi` npm package and returns a typed result.
 *
 * Reference for the riichi string format:
 *   https://github.com/takayama-lily/riichi
 *
 * Hand layout: groups of digits per suit, win tile appended last.
 *   Tsumo: `<hand13><winTile>`
 *   Ron:   `<hand13>+<winTile>`
 *
 * Options (after the hand): `+<flags>+d<doraTiles>+<wind>`
 *   flag letters used here:
 *     r — riichi
 *     w — double riichi (we still set `r` too for clarity, but `w`
 *         alone is sufficient per the lib)
 *     i — ippatsu
 *     t — tenhou / chiihou
 *     h — haitei / houtei
 *     k — chankan / rinshan kaihou
 *   wind digits:
 *     `<round><seat>` where 1=E, 2=S, 3=W, 4=N (default 12 = E/S)
 */

import type { Tile, Wind } from "./types";
import { compareTiles } from "./types";
import type { Meld } from "./state";
import type { PlayerCount, SanmaType } from "../protocol/seat";
import { createRiichiScorer, type RiichiRaw } from "./scoring/riichiAdapter";
import {
  applySanmaPayments,
  SCORE_CAP_BASE,
  type ScoreCap,
} from "./scoring/sanmaPayments";
import { sortYakuRecord } from "~/game/protocol/yakuOrder";

export interface ScoreInput {
  /** Defaults to four-player scoring; sanma options are inactive unless this is 3. */
  playerCount?: PlayerCount;
  /** Three-player payment and manzu dora policy. Default: Online. */
  sanmaType?: SanmaType;
  /** Successfully extracted tiles, separate from the concealed hand and melds. */
  nukiTiles?: readonly Tile[];
  /**
   * 13 concealed tiles (the hand before the win tile arrives).
   * Order is irrelevant — we canonicalize internally.
   */
  hand: readonly Tile[];
  /** The winning tile (tsumo draw or ron discard). */
  winTile: Tile;
  /** True for tsumo (self-draw), false for ron (off another player). */
  tsumo: boolean;
  /** Dora indicator tiles (the indicator, not the dora). */
  doraIndicators?: readonly Tile[];
  /** Uradora indicator tiles (revealed only on a riichi win). */
  uraDoraIndicators?: readonly Tile[];
  /** Round wind, default "E". */
  roundWind?: Wind;
  /**
   * Seat wind for the winning player, default "S" (non-dealer).
   * Set this to `"E"` when the winner is the dealer.
   */
  seatWind?: Wind;
  /** Riichi was declared. */
  riichi?: boolean;
  /** Double riichi (declared on the very first uninterrupted turn). */
  doubleRiichi?: boolean;
  /** Ippatsu — win on the next turn after riichi with no interruption. */
  ippatsu?: boolean;
  /** Haitei (last-tile tsumo) or houtei (last-discard ron). */
  haiteiOrHoutei?: boolean;
  /** Rinshan kaihou (kan/nuki replacement win) or chankan (kan/North robbery). */
  rinshanOrChankan?: boolean;
  /** Tenhou / chiihou (dealer/non-dealer first-draw win). */
  blessingOfHeavenOrEarth?: boolean;
  /** Disable kuitan (open tanyao). Default: allowed. */
  noKuitan?: boolean;
  /** Disable red-five dora (treat 0X as a normal 5X). Default: enabled. */
  noAka?: boolean;
  /** Promote 4-han 30-fu and 3-han 60-fu wins to mangan. */
  kiriageMangan?: boolean;
  /** Fu for a pair that is both the round wind and seat wind. Default: 4. */
  doubleWindPairFu?: 2 | 4;
  /**
   * Clamp the result’s payment to the named tier when the
   * lib-computed `ten` exceeds it. `null` / omitted leaves the
   * payment untouched. See `RuleSet.scoreCap`.
   */
  scoreCap?: ScoreCap | null;
  /**
   * Open / concealed melds owned by the winner (chi, pon, kan).
   * The riichi package counts each meld as 3 tiles regardless of
   * kan, so the concealed `hand` must contain `13 - 3*melds.length`
   * tiles before the win tile arrives.
   */
  melds?: readonly Meld[];
}

export interface ScoreResult {
  /** Winning shape; a legal win also requires positive han or yakumanCount. */
  isAgari: boolean;
  /** Han count (0 for yakuman wins; check `yakumanCount` instead). */
  han: number;
  /** Fu count for hand analysis; not a pricing factor for Kansai. */
  fu: number;
  /**
   * Total points awarded to the winner. For ron this is the lump sum
   * paid by the loser; for tsumo it is the sum across all payers.
   */
  ten: number;
  /** Yaku name → han string (e.g. "立直" → "1飜"). */
  yaku: Record<string, string>;
  /** Regular indicator dora in the hand/melds/nuki, excluding aka and ura. */
  doraCount: number;
  /** Red-five dora. */
  akaDoraCount: number;
  /** Ura dora. */
  uraDoraCount: number;
  /** True if any yakuman is scored. */
  isYakuman: boolean;
  /** Yakuman multiple (1 = single, 2 = double, etc.; 0 if none). */
  yakumanCount: number;
  /**
   * Per-payer payments. For ron:
   *   - winner is dealer: `oya[0]` is the only meaningful entry
   *     (the discarder's payment).
   *   - winner is non-dealer: `ko[0]` is the discarder's payment.
   * For tsumo:
   *   - dealer winner: `oya` contains the equal opponent payments.
   *   - non-dealer winner: `ko[0]` is the dealer's payment, followed by
   *     one payment per other non-dealer. Do not use `oya[0]` here:
   *     Kansai's dealer-winner and dealer-payer amounts can differ.
   *   - both arrays have two entries in sanma, three in four-player play.
   */
  oya: readonly number[];
  ko: readonly number[];
  /** Human-readable summary string from the underlying lib. */
  text: string;
  /** Raw library output, kept for debugging / future fields. */
  raw: unknown;
}

// ---------------------------------------------------------------------------
// String building
// ---------------------------------------------------------------------------

const WIND_DIGIT: Record<Wind, string> = { E: "1", S: "2", W: "3", N: "4" };

function tileNumeric(t: Tile): number {
  // Red five sorts as 5; keep red AFTER white five within ties.
  return t[0] === "0" ? 5 : Number(t[0]);
}

function tileSuit(t: Tile): "m" | "p" | "s" | "z" {
  return t[t.length - 1] as "m" | "p" | "s" | "z";
}

/** Sort tiles into canonical (m,p,s,z) order, numeric ascending; red after white. */
function sortTiles(tiles: readonly Tile[]): Tile[] {
  return [...tiles].sort((a, b) => {
    const cmp = compareTiles(a, b);
    if (cmp !== 0) {
      return cmp;
    }
    // Tie-break: white five (5X) before red five (0X).
    if (a[0] === "0" && b[0] !== "0") {
      return 1;
    }
    if (b[0] === "0" && a[0] !== "0") {
      return -1;
    }
    return 0;
  });
}

/** `[1m,2m,3m,4p,5p,1z,1z]` → `"123m45p11z"`. */
function tilesToGroups(tiles: readonly Tile[]): string {
  if (tiles.length === 0) {
    return "";
  }
  const out: string[] = [];
  let curSuit: string = tileSuit(tiles[0]);
  let digits = "";
  for (const t of tiles) {
    const s = tileSuit(t);
    if (s !== curSuit) {
      out.push(digits + curSuit);
      digits = "";
      curSuit = s;
    }
    digits += t[0]; // includes "0" for red five
  }
  out.push(digits + curSuit);
  return out.join("");
}

/** Append a single tile to an already-grouped string, sharing suit letter when possible. */
function appendWinTile(handStr: string, winTile: Tile): string {
  const suit = tileSuit(winTile);
  const digit = winTile[0];
  // If handStr ends with the same suit letter, drop that letter, add digit, re-add suit.
  if (handStr.endsWith(suit)) {
    return `${handStr.slice(0, -1)}${digit}${suit}`;
  }
  return `${handStr}${digit}${suit}`;
}

function buildOptionFlags(input: ScoreInput): string {
  let flags = "";
  if (input.doubleRiichi) {
    flags += "w";
  } else if (input.riichi) {
    flags += "r";
  }
  if (input.ippatsu) {
    flags += "i";
  }
  if (input.blessingOfHeavenOrEarth) {
    flags += "t";
  }
  if (
    input.haiteiOrHoutei &&
    !(input.playerCount === 3 && input.rinshanOrChankan)
  ) {
    flags += "h";
  }
  if (input.rinshanOrChankan) {
    flags += "k";
  }
  return flags;
}

function buildWindDigits(input: ScoreInput): string {
  const round = WIND_DIGIT[input.roundWind ?? "E"];
  const seat = WIND_DIGIT[input.seatWind ?? "S"];
  // Default is "12" (round E, seat S). Only emit if non-default.
  if (round === "1" && seat === "2") {
    return "";
  }
  return round + seat;
}

/**
 * Convert a dora indicator to the dora tile it indicates.
 *   - suited 1..9: indicator k → (k mod 9) + 1
 *   - winds  1z..4z (E,S,W,N): indicator cycles E→S→W→N→E
 *   - dragons 5z..7z (haku,hatsu,chun): indicator cycles 5z→6z→7z→5z
 *   - red five (`0X`) is treated as 5; result is the suited 6.
 *   - sanma manzu: Online 1↔9; Kansai 1→5→9→1, including red 0m.
 *
 * The riichi npm package's `+d` argument expects the dora itself,
 * not the indicator, so we translate here.
 */
export function indicatorToDora(indicator: Tile): Tile;
// eslint-disable-next-line no-redeclare -- Retain the original one-argument callback signature.
export function indicatorToDora(
  indicator: Tile,
  variant: Pick<ScoreInput, "playerCount" | "sanmaType">
): Tile;
// eslint-disable-next-line no-redeclare -- Implementation of the overloads above.
export function indicatorToDora(
  indicator: Tile,
  variant: Pick<ScoreInput, "playerCount" | "sanmaType"> = {}
): Tile {
  const suit = tileSuit(indicator);
  const n = tileNumeric(indicator);
  if (suit === "m" && variant.playerCount === 3) {
    const cycle = variant.sanmaType === "kansai" ? [1, 5, 9] : [1, 9];
    const index = cycle.indexOf(n);
    if (index >= 0) {
      return `${cycle[(index + 1) % cycle.length]}m`;
    }
  }
  if (suit === "z") {
    if (n >= 1 && n <= 4) {
      return `${(n % 4) + 1}z`;
    }
    // dragons
    return `${((n - 5 + 1) % 3) + 5}z`;
  }
  return `${(n % 9) + 1}${suit}`;
}

function normalizeRedFive(tile: Tile): Tile {
  return tile[0] === "0" ? (`5${tileSuit(tile)}` as Tile) : tile;
}

function countIndicatorDora(
  tiles: readonly Tile[],
  indicators: readonly Tile[],
  variant: Pick<ScoreInput, "playerCount" | "sanmaType">
): number {
  return indicators.reduce((total, indicator) => {
    const dora = normalizeRedFive(indicatorToDora(indicator, variant));
    return (
      total + tiles.filter((tile) => normalizeRedFive(tile) === dora).length
    );
  }, 0);
}

function applicableUraIndicators(input: ScoreInput): readonly Tile[] {
  if (
    input.playerCount === 3 &&
    (!(input.riichi || input.doubleRiichi) ||
      input.melds?.some((meld) => meld.type !== "ankan"))
  ) {
    return [];
  }
  return input.uraDoraIndicators ?? [];
}

/** Public for tests / debugging. */
export function buildRiichiInput(input: ScoreInput): string {
  const meldCount = input.melds?.length ?? 0;
  const expectedHandLen = 13 - 3 * meldCount;
  if (input.hand.length !== expectedHandLen) {
    throw new Error(
      `scoreHand: hand must have ${expectedHandLen} concealed tiles when ${meldCount} meld(s) are declared (got ${input.hand.length})`
    );
  }
  const sorted = sortTiles(input.hand);
  const handStr = tilesToGroups(sorted);
  const withWin = input.tsumo
    ? appendWinTile(handStr, input.winTile)
    : `${handStr}+${input.winTile[0]}${tileSuit(input.winTile)}`;

  const meldChunks: string[] = [];
  if (input.melds) {
    for (const m of input.melds) {
      meldChunks.push(meldToGroup(m));
    }
  }

  const tail: string[] = [];
  const flags = buildOptionFlags(input);
  const windDigits = buildWindDigits(input);
  if (flags || windDigits) {
    tail.push(flags + windDigits);
  }
  // The `riichi` package accepts one `d` chunk and replaces (rather
  // than appends) its internal list if another appears. Combine regular
  // and ura indicators first so every indicator contributes, including
  // duplicate indicators that point to the same tile.
  const allDoraIndicators = [
    ...(input.doraIndicators ?? []),
    ...applicableUraIndicators(input),
  ];
  if (allDoraIndicators.length > 0) {
    const dora = allDoraIndicators.map((indicator) =>
      indicatorToDora(indicator, input)
    );
    tail.push(`d${tilesToGroups(sortTiles(dora))}`);
  }

  const segments: string[] = [withWin, ...meldChunks, ...tail];
  return segments.join("+");
}

/**
 * Encode a meld in the riichi-package's furo notation. The lib uses
 * tile-count alone to disambiguate kind:
 *   - 2 same tiles   → ankan (concealed kan)
 *   - 3 same tiles   → minkou (open pon)
 *   - 4 same tiles   → minkan (open kan)
 *   - 3 sequential   → chi
 * Open vs concealed kan is therefore distinguished by length, not
 * by an explicit flag. Shouminkan (added kan) is encoded as 4 same
 * tiles too — the lib doesn't differentiate it from minkan for
 * scoring purposes.
 */
function meldToGroup(meld: Meld): string {
  const sorted = sortTiles(meld.tiles);
  if (meld.type === "ankan") {
    // 2 same tiles per the lib's quirky convention.
    const t = sorted[0];
    return `${t[0]}${t[0]}${tileSuit(t)}`;
  }
  return tilesToGroups(sorted);
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

export function scoreHand(input: ScoreInput): ScoreResult {
  const str = buildRiichiInput(input);
  const sanma = input.playerCount === 3;
  const nukiTiles = sanma ? (input.nukiTiles ?? []) : [];
  const uraIndicators = applicableUraIndicators(input);
  const handTiles = [
    ...input.hand,
    input.winTile,
    ...(input.melds?.flatMap((meld) => meld.tiles) ?? []),
  ];
  const winningTiles = [
    ...handTiles,
    ...nukiTiles,
  ];
  const doraCount = countIndicatorDora(
    winningTiles,
    input.doraIndicators ?? [],
    input
  );
  const uraDoraCount = countIndicatorDora(winningTiles, uraIndicators, input);
  const akaDoraCount = input.noAka
    ? 0
    : winningTiles.filter((tile) => tile[0] === "0").length;
  const scorer = createRiichiScorer(str, {
    doubleWindPairFu: input.doubleWindPairFu,
    noKuitan: input.noKuitan,
    noAka: input.noAka,
    rinshan: sanma && input.tsumo && input.rinshanOrChankan,
    kansaiNorthYakuhai:
      sanma &&
      input.sanmaType === "kansai" &&
      handTiles.filter((tile) => tile === "4z").length >= 3,
    nukiDora: nukiTiles.length,
    nukiIndicatorDora: countIndicatorDora(
      nukiTiles,
      [...(input.doraIndicators ?? []), ...uraIndicators],
      input
    ),
    nukiAkaDora: nukiTiles.filter((tile) => tile[0] === "0").length,
    priceCandidate: sanma
      ? (candidate) => applySanmaPayments(candidate, input)
      : undefined,
  });
  const raw = scorer.calc();
  if (!sanma) {
    // Preserve legacy candidate selection and four-player cap behavior.
    if (input.kiriageMangan) {
      applyKiriageMangan(raw, input.tsumo, input.seatWind === "E");
    }
    if (input.scoreCap) {
      applyScoreCap(raw, input.scoreCap, input.tsumo, input.seatWind === "E");
    }
  } else if (raw.ten === 0) {
    raw.oya = input.tsumo ? [0, 0] : [0];
    raw.ko = input.tsumo ? [0, 0] : [0];
  }

  const yaku = { ...raw.yaku };
  if (Object.hasOwn(yaku, "ドラ")) {
    delete yaku["ドラ"];
    if (doraCount > 0) {
      yaku["ドラ"] = `${doraCount}飜`;
    }
  }
  if (
    uraIndicators.length > 0 &&
    raw.yakuman === 0 &&
    (!sanma || raw.han > 0)
  ) {
    yaku["裏ドラ"] = `${uraDoraCount}飜`;
  }

  return {
    isAgari: raw.isAgari && !raw.error,
    han: raw.han,
    fu: raw.fu,
    ten: raw.ten,
    yaku: sortYakuRecord(yaku),
    doraCount,
    akaDoraCount,
    uraDoraCount,
    isYakuman: raw.yakuman > 0,
    yakumanCount: raw.yakuman,
    oya: raw.oya,
    ko: raw.ko,
    text: raw.text,
    raw,
  };
}

function applyKiriageMangan(
  raw: RiichiRaw,
  isTsumo: boolean,
  isDealer: boolean
): void {
  const isKiriageBoundary =
    (raw.han === 4 && raw.fu === 30) || (raw.han === 3 && raw.fu === 60);
  if (!raw.isAgari || raw.error || raw.yakuman > 0 || !isKiriageBoundary) {
    return;
  }
  setBasePayments(raw, SCORE_CAP_BASE.mangan, isTsumo, isDealer);
}

/**
 * Clamp `raw.oya` / `raw.ko` / `raw.ten` to the named tier when
 * `raw.ten` already exceeds it. Preserves the lib’s array shape
 * so `distributePayments` keeps working without branching:
 *   - tsumo: `oya = [b*2, b*2, b*2]`, `ko = [b*2, b, b]`
 *   - ron:   `oya = [b*6]`, `ko = [b*4]`
 * `raw.han` / `raw.yaku` / `raw.yakuman` are kept as-is so the UI
 * still shows the true hand value (e.g. “baiman → mangan” is
 * obvious from yaku list + capped ten).
 */
function applyScoreCap(
  raw: RiichiRaw,
  cap: NonNullable<ScoreInput["scoreCap"]>,
  isTsumo: boolean,
  isDealer: boolean
): void {
  const base = SCORE_CAP_BASE[cap];
  const capTen = isDealer ? base * 6 : base * 4;
  if (raw.ten <= capTen) {
    return;
  }
  setBasePayments(raw, base, isTsumo, isDealer);
}

function setBasePayments(
  raw: RiichiRaw,
  base: number,
  isTsumo: boolean,
  isDealer: boolean
): void {
  if (isTsumo) {
    raw.oya = [base * 2, base * 2, base * 2];
    raw.ko = [base * 2, base, base];
  } else {
    raw.oya = [base * 6];
    raw.ko = [base * 4];
  }
  raw.ten = isDealer ? base * 6 : base * 4;
}
