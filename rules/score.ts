/**
 * Scoring — translates a winning hand into the input format expected
 * by the `riichi` npm package and returns a typed result.
 *
 * Phase 1 step 4: closed-hand wins only. Calls/melds (chi/pon/kan)
 * will be added in Phase 1 step 5 alongside engine support for them.
 *
 * Reference for the riichi string format:
 *   https://github.com/takayama-lily/riichi
 *
 * Hand layout: groups of digits per suit, win tile appended last.
 *   Tsumo: `<hand13><winTile>`
 *   Ron:   `<hand13>+<winTile>`
 *
 * Options (after the hand): `+<flags>+d<doraIndicators>+u<uraDora>+<wind>`
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

import Riichi from "riichi";
import { sortYakuRecord } from "~/game/protocol/yakuOrder";

// ---------------------------------------------------------------------------
// Monkey-patch: fix penchan fu bug in `riichi` npm package (v1.2.0).
//
// The library's `calcFu` mistakenly compares chii edge tiles to a
// boolean (`hasAgariFu`) instead of the win tile (`this.agari`),
// so penchan completions on the lower edge (789 won on 7) and
// upper edge (123 won on 3) miss the +2 wait fu. Kanchan/tanki
// remain correct because they're matched on `v[1] === this.agari`.
//
// We replace `calcFu` once at module load with the corrected
// version. Pinfu / chiitoitsu / yakuman branches are untouched.
// ---------------------------------------------------------------------------
{
  const ceil10 = (n: number): number => Math.ceil(n / 10) * 10;
  const is19 = (t: unknown): boolean =>
    typeof t === "string" &&
    t.length === 2 &&
    (t.includes("1") || t.includes("9") || t.includes("z"));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (Riichi.prototype as any).calcFu = function calcFuPatched(this: any): void {
    let fu = 0;
    if (this.tmpResult.yaku["七対子"]) {
      fu = 25;
    } else if (this.tmpResult.yaku["平和"]) {
      fu = this.isTsumo ? 20 : 30;
    } else {
      fu = 20;
      let hasAgariFu = false;
      if (!this.isTsumo && this.isMenzen()) {
        fu += 10;
      }
      for (const v of this.currentPattern) {
        if (typeof v === "string") {
          if (v.includes("z")) {
            for (const vv of [this.bakaze, this.jikaze, 5, 6, 7]) {
              if (parseInt(v) === vv) {
                fu += 2;
              }
            }
          }
          if (this.agari === v) {
            hasAgariFu = true;
          }
        } else {
          if (v.length === 4) {
            fu += is19(v[0]) ? 16 : 8;
          } else if (v.length === 2) {
            fu += is19(v[0]) ? 32 : 16;
          } else if (v.length === 1) {
            fu += is19(v[0]) ? 8 : 4;
          } else if (v.length === 3 && v[0] === v[1]) {
            fu += is19(v[0]) ? 4 : 2;
          } else if (!hasAgariFu) {
            // Kanchan: win is the middle tile of a chii.
            if (v[1] === this.agari) {
              hasAgariFu = true;
            }
            // Penchan upper edge: chii 789, win = 7.
            else if (v[0] === this.agari && parseInt(v[2]) === 9) {
              hasAgariFu = true;
            }
            // Penchan lower edge: chii 123, win = 3.
            else if (v[2] === this.agari && parseInt(v[0]) === 1) {
              hasAgariFu = true;
            }
          }
        }
      }
      if (hasAgariFu) {
        fu += 2;
      }
      if (this.isTsumo) {
        fu += 2;
      }
      fu = ceil10(fu);
      if (fu < 30) {
        fu = 30;
      }
    }
    this.tmpResult.fu = fu;
  };
}

export interface ScoreInput {
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
  /** Rinshan kaihou (win on dead-wall draw after kan) or chankan. */
  rinshanOrChankan?: boolean;
  /** Tenhou / chiihou (dealer/non-dealer first-draw win). */
  blessingOfHeavenOrEarth?: boolean;
  /** Disable kuitan (open tanyao). Default: allowed. */
  noKuitan?: boolean;
  /** Disable red-five dora (treat 0X as a normal 5X). Default: enabled. */
  noAka?: boolean;
  /**
   * Clamp the result’s payment to the named tier when the
   * lib-computed `ten` exceeds it. `null` / omitted leaves the
   * payment untouched. See `RuleSet.scoreCap`.
   */
  scoreCap?: "mangan" | "haneman" | "baiman" | "sanbaiman" | null;
  /**
   * Open / concealed melds owned by the winner (chi, pon, kan).
   * The riichi package counts each meld as 3 tiles regardless of
   * kan, so the concealed `hand` must contain `13 - 3*melds.length`
   * tiles before the win tile arrives.
   */
  melds?: readonly Meld[];
}

export interface ScoreResult {
  /** True iff the hand is a valid winning hand under the given context. */
  isAgari: boolean;
  /** Han count (0 for yakuman wins; check `yakumanCount` instead). */
  han: number;
  /** Fu count. */
  fu: number;
  /**
   * Total points awarded to the winner. For ron this is the lump sum
   * paid by the loser; for tsumo it is the sum across all payers.
   */
  ten: number;
  /** Yaku name → han string (e.g. "立直" → "1飜"). */
  yaku: Record<string, string>;
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
   *   - dealer winner: `oya[0..2]` are the three non-dealer payments
   *     (all equal).
   *   - non-dealer winner: `oya[0]` = dealer payment, `ko[1..2]` =
   *     each non-dealer payment.
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
  if (input.haiteiOrHoutei) {
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
 *
 * The riichi npm package's `+d` argument expects the dora itself,
 * not the indicator, so we translate here.
 */
export function indicatorToDora(indicator: Tile): Tile {
  const suit = tileSuit(indicator);
  const n = tileNumeric(indicator);
  if (suit === "z") {
    if (n >= 1 && n <= 4) {
      return `${(n % 4) + 1}z`;
    }
    // dragons
    return `${((n - 5 + 1) % 3) + 5}z`;
  }
  return `${(n % 9) + 1}${suit}`;
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
  if (input.doraIndicators && input.doraIndicators.length > 0) {
    const dora = input.doraIndicators.map(indicatorToDora);
    tail.push(`d${tilesToGroups(sortTiles(dora))}`);
  }
  // The `riichi` package supports a single `d` chunk for both regular
  // and uradora; revealed only on a riichi win, both convert from
  // indicators to actual dora tiles before being passed in.
  if (input.uraDoraIndicators && input.uraDoraIndicators.length > 0) {
    const ura = input.uraDoraIndicators.map(indicatorToDora);
    tail.push(`d${tilesToGroups(sortTiles(ura))}`);
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

interface RiichiRaw {
  isAgari: boolean;
  yakuman: number;
  yaku: Record<string, string>;
  han: number;
  fu: number;
  ten: number;
  name: string;
  text: string;
  oya: number[];
  ko: number[];
  error: boolean;
}

export function scoreHand(input: ScoreInput): ScoreResult {
  const str = buildRiichiInput(input);
  const r = new Riichi(str);
  if (input.noKuitan) {
    r.disableKuitan();
  }
  if (input.noAka) {
    r.disableAka();
  }
  const raw = r.calc() as RiichiRaw;

  if (input.scoreCap) {
    applyScoreCap(raw, input.scoreCap, input.tsumo, input.seatWind === "E");
  }

  return {
    isAgari: raw.isAgari && !raw.error,
    han: raw.han,
    fu: raw.fu,
    ten: raw.ten,
    yaku: sortYakuRecord(raw.yaku),
    isYakuman: raw.yakuman > 0,
    yakumanCount: raw.yakuman,
    oya: raw.oya,
    ko: raw.ko,
    text: raw.text,
    raw,
  };
}

/**
 * Base unit per scoring tier (riichi-lib `base` value: ten =
 * `base*6` dealer / `base*4` non-dealer; tsumo splits per
 * `payments.ts`). Used to clamp the lib’s output when a
 * `RuleSet.scoreCap` is in effect.
 */
const SCORE_CAP_BASE: Record<NonNullable<ScoreInput["scoreCap"]>, number> = {
  mangan: 2000,
  haneman: 3000,
  baiman: 4000,
  sanbaiman: 6000,
};

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
  if (isTsumo) {
    raw.oya = [base * 2, base * 2, base * 2];
    raw.ko = [base * 2, base, base];
  } else {
    raw.oya = [base * 6];
    raw.ko = [base * 4];
  }
  raw.ten = capTen;
}
