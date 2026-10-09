/*
 * TypeScript port of SkyEye-FAST/mcr-mahjong FanCalculator.kt v0.1.0,
 * itself a port of summerinsects/mahjong-algorithm fan_calculator.cpp.
 * Copyright (c) 2016-2027 Jeff Wang <summer_insects@163.com>
 * Copyright (c) 2026 SkyEye_FAST
 * MIT licensed; see THIRD_PARTY_NOTICES.md.
 */
import { MCR_FANS, MCR_FAN_IDS, type McrFanId } from "./fans";
import {
  ALL_TILES,
  CHOW,
  KONG,
  KNITTED,
  PAIR,
  PUNG,
  TABLE_SIZE,
  ORPHANS,
  eigen,
  isDragon,
  isGreen,
  isHonor,
  isMelded,
  isNumbered,
  isReversible,
  isTerminal,
  isTerminalOrHonor,
  isWind,
  mapPacks,
  mapTiles,
  pack,
  packTile,
  packType,
  rank,
  sameRank,
  sameSuit,
  suit,
} from "./internalTiles";

export const MIXED_KONG_MARKER = "CONCEALED_KONG_AND_MELDED_KONG" as const;
export type InternalFanId = McrFanId | typeof MIXED_KONG_MARKER;
export type FanTable = Int32Array;

const INTERNAL_FAN_IDS = [...MCR_FAN_IDS, MIXED_KONG_MARKER] as const;
const FAN_INDEX = Object.fromEntries(
  INTERNAL_FAN_IDS.map((id, index) => [id, index + 1])
) as Record<InternalFanId, number>;

export interface RawScore {
  readonly total: number;
  readonly table: FanTable;
}

export type CandidateEvaluator = (
  table: FanTable,
  packs: readonly number[] | null
) => number;

export function fanGet(table: FanTable, fan: InternalFanId): number {
  return table[FAN_INDEX[fan]];
}

export function fanSet(
  table: FanTable,
  fan: InternalFanId,
  value: number
): void {
  table[FAN_INDEX[fan]] = value;
}

export function fanAdd(
  table: FanTable,
  fan: InternalFanId,
  value = 1
): void {
  table[FAN_INDEX[fan]] += value;
}

function fanTable(): FanTable {
  return new Int32Array(INTERNAL_FAN_IDS.length + 1);
}

function regularFan(
  packs: readonly number[],
  fixedTable: Int32Array,
  standing: Int32Array,
  unique: readonly number[],
  fixed: number,
  winTile: number,
  hasUniqueWait: boolean,
  flags: number,
  prevalent: number,
  seat: number,
  table: FanTable
): void {
  let pair = 0;
  const chows: number[] = [];
  const pungs: number[] = [];
  let concealedPungs = 0;
  let meldedKongs = 0;
  let concealedKongs = 0;

  for (const value of packs) {
    const type = packType(value);
    if (type === CHOW) {
      chows.push(value);
    } else if (type === PUNG) {
      pungs.push(value);
      if (!isMelded(value)) {
        concealedPungs++;
      }
    } else if (type === KONG) {
      pungs.push(value);
      if (isMelded(value)) {
        meldedKongs++;
      } else {
        concealedKongs++;
      }
    } else if (type === PAIR) {
      pair = value;
    } else {
      return;
    }
  }
  if (pair === 0 || chows.length + pungs.length !== 4) {
    return;
  }

  adjustWinFlags(flags, table);
  if (
    (flags & 1) === 0 &&
    !chows.some((value) => {
      const tile = packTile(value);
      return (
        !isMelded(value) &&
        (tile - 1 === winTile || tile === winTile || tile + 1 === winTile)
      );
    })
  ) {
    for (const value of pungs) {
      if (packTile(value) === winTile && !isMelded(value)) {
        concealedPungs--;
      }
    }
  }

  if (pungs.length > 0) {
    calculateKongs(
      concealedPungs,
      meldedKongs,
      concealedKongs,
      table
    );
    if (
      pungs.length === 4 &&
      fanGet(table, "FOUR_KONGS") === 0 &&
      fanGet(table, "FOUR_CONCEALED_PUNGS") === 0
    ) {
      fanSet(table, "ALL_PUNGS", 1);
    }
    for (const value of pungs) {
      const fan = onePungFan(packTile(value));
      if (fan) {
        fanAdd(table, fan);
      }
    }
  }

  const chowTiles = chows.map(packTile).sort((first, second) => first - second);
  const pungTiles = pungs.map(packTile).sort((first, second) => first - second);
  if (chows.length === 4) {
    if (threeSuitedTerminalChows(chows, pair)) {
      fanSet(table, "THREE_SUITED_TERMINAL_CHOWS", 1);
    } else if (pureTerminalChows(chows, pair)) {
      fanSet(table, "PURE_TERMINAL_CHOWS", 1);
    } else {
      calculateFourChows(chowTiles, table);
    }
  } else if (chows.length === 3) {
    calculateThreeChows(chowTiles, table);
  } else if (chows.length === 2) {
    const chowFan = twoChowsFan(chowTiles[0], chowTiles[1]);
    if (chowFan) {
      fanAdd(table, chowFan);
    }
    const pungFan = twoPungsFan(pungTiles[0], pungTiles[1]);
    if (pungFan) {
      fanAdd(table, pungFan);
    }
  } else if (chows.length === 1) {
    calculateThreePungs(pungTiles, table);
  } else {
    calculateFourPungs(pungTiles, table);
  }

  adjustSelfDrawn(packs, fixed, (flags & 1) !== 0, table);
  adjustPair(packTile(pair), chows.length, table);
  adjustPacksTraits(packs, table);
  const merged = new Int32Array(TABLE_SIZE);
  for (let index = 0; index < TABLE_SIZE; index++) {
    merged[index] = standing[index] + fixedTable[index];
  }
  adjustSuits(unique, table);
  adjustTilesTraits(unique, table);
  adjustRange(unique, table);
  if (fanGet(table, "QUADRUPLE_CHOW") === 0) {
    adjustTileHog(merged, meldedKongs + concealedKongs, table);
  }
  if (hasUniqueWait) {
    adjustWaitingForm(packs.slice(fixed, 5), winTile, table);
  }
  finalAdjust(table);
  if (fanGet(table, "BIG_FOUR_WINDS") === 0) {
    for (const value of pungs) {
      if (isWind(packTile(value))) {
        adjustWinds(packTile(value), prevalent, seat, table);
      }
    }
  }
  if (table.every((value) => value === 0)) {
    fanSet(table, "CHICKEN_HAND", 1);
  }
}

function knittedFan(
  fixedTable: Int32Array,
  standing: Int32Array,
  fixedPacks: readonly number[],
  winTile: number,
  prevalent: number,
  seat: number,
  flags: number,
  table: FanTable
): boolean {
  if (ALL_TILES.every((tile) => standing[tile] <= 1)) {
    return false;
  }
  const sequence = KNITTED.find((row) =>
    row.every((tile) => standing[tile] > 0)
  );
  if (!sequence) {
    return false;
  }
  const rest = standing.slice();
  for (const tile of sequence) {
    rest[tile]--;
  }
  const work = new Array<number>(5).fill(0);
  const fixed = fixedPacks.length;
  if (fixed === 1) {
    work[3] = fixedPacks[0];
  }
  const divisions: number[][] = [];
  divideRec(rest, fixed + 3, 0, 0, work, divisions);
  if (divisions.length !== 1) {
    return false;
  }
  const packs = divisions[0];
  const involved = packs[3];
  const pairTile = packTile(packs[4]);
  fanSet(table, "KNITTED_STRAIGHT", 1);
  const type = packType(involved);
  if (type === CHOW) {
    if (isNumbered(pairTile)) {
      fanSet(table, "ALL_CHOWS", 1);
    }
    if (fixedTable[pairTile] + standing[pairTile] === 4) {
      fanSet(table, "TILE_HOG", 1);
    }
  } else {
    const tile = packTile(involved);
    if (isHonor(tile)) {
      if (isWind(tile)) {
        fanSet(table, "PUNG_OF_TERMINALS_OR_HONORS", 1);
        adjustWinds(tile, prevalent, seat, table);
        if (isDragon(pairTile)) {
          fanSet(table, "ALL_TYPES", 1);
        }
      } else {
        fanSet(table, "DRAGON_PUNG", 1);
        if (isWind(pairTile)) {
          fanSet(table, "ALL_TYPES", 1);
        }
      }
    } else {
      if (isTerminal(tile)) {
        fanSet(table, "PUNG_OF_TERMINALS_OR_HONORS", 1);
      }
      if (!isHonor(pairTile)) {
        fanSet(table, "NO_HONORS", 1);
      }
      if (
        type !== KONG &&
        fixedTable[tile] + standing[tile] === 4
      ) {
        fanSet(table, "TILE_HOG", 1);
      }
    }
  }

  adjustWinFlags(flags, table);
  if (isMelded(involved)) {
    if (type === KONG) {
      fanSet(table, "MELDED_KONG", 1);
    }
  } else {
    if (type === KONG) {
      fanSet(table, "CONCEALED_KONG", 1);
    }
    if ((flags & 1) !== 0) {
      fanSet(table, "FULLY_CONCEALED_HAND", 1);
      fanSet(table, "SELF_DRAWN", 0);
    } else {
      fanSet(table, "CONCEALED_HAND", 1);
    }
  }

  const heavenly = seat === 0 && fixed === 0 && (flags & 17) === 17;
  if (fixed === 0) {
    if (!heavenly && uniqueWaiting(rest, 4, winTile)) {
      adjustWaitingForm(packs.slice(3, 5), winTile, table);
    }
  } else if (
    !(sequence as readonly number[]).includes(winTile) ||
    standing[winTile] === 3
  ) {
    fanSet(table, "SINGLE_WAIT", 1);
  }
  finalAdjust(table);
  return true;
}

function sevenShiftedPairs(table: Int32Array, tileSuit: number): boolean {
  if (tileSuit === 4) {
    return false;
  }
  const third = (tileSuit << 4) | 3;
  if ([0, 1, 2, 3, 4].every((offset) => table[third + offset] === 2)) {
    if (table[third - 1] === 2) {
      return table[third - 2] === 2 || table[third + 5] === 2;
    }
    return table[third + 5] === 2 && table[third + 6] === 2;
  }
  return false;
}

function honorsAndKnitted(
  unique: readonly number[],
  table: FanTable
): boolean {
  if (unique.length !== 14) {
    return false;
  }
  const honorIndex = unique.findIndex(isHonor);
  const firstHonor = honorIndex < 0 ? 14 : honorIndex;
  if (firstHonor < 7 || firstHonor > 9) {
    return false;
  }
  if (
    !KNITTED.some((sequence) =>
      unique
        .slice(0, firstHonor)
        .every((tile) => (sequence as readonly number[]).includes(tile))
    )
  ) {
    return false;
  }
  if (
    firstHonor === 7 &&
    Array.from({ length: 7 }, (_, index) => index).every(
      (index) => ORPHANS[index + 6] === unique[index + 7]
    )
  ) {
    fanSet(table, "GREATER_HONORS_AND_KNITTED_TILES", 1);
    return true;
  }
  if (unique.slice(firstHonor).every((tile) => tile >= 0x41 && tile <= 0x47)) {
    fanSet(table, "LESSER_HONORS_AND_KNITTED_TILES", 1);
    if (firstHonor === 9) {
      fanSet(table, "KNITTED_STRAIGHT", 1);
    }
    return true;
  }
  return false;
}

function specialFan(
  standing: Int32Array,
  winTile: number,
  unique: readonly number[],
  flags: number,
  table: FanTable
): boolean {
  if (ALL_TILES.every((tile) => (standing[tile] & 1) === 0)) {
    const tileSuit = suit(winTile);
    if (sevenShiftedPairs(standing, tileSuit)) {
      fanSet(table, "SEVEN_SHIFTED_PAIRS", 1);
      if (
        standing[(tileSuit << 4) | 1] === 0 &&
        standing[(tileSuit << 4) | 9] === 0
      ) {
        fanSet(table, "ALL_SIMPLES", 1);
      }
      adjustWinFlags(flags, table);
    } else {
      fanSet(table, "SEVEN_PAIRS", 1);
      adjustSuits(unique, table);
      adjustTilesTraits(unique, table);
      adjustRange(unique, table);
      adjustTileHog(standing, 0, table);
      adjustWinFlags(flags, table);
      finalAdjust(table);
    }
    return true;
  }
  if (honorsAndKnitted(unique, table)) {
    adjustWinFlags(flags, table);
    return true;
  }
  if (arraysEqual(unique, ORPHANS)) {
    fanSet(table, "THIRTEEN_ORPHANS", 1);
    adjustWinFlags(flags, table);
    return true;
  }
  return false;
}

function nineGates(
  standing: Int32Array,
  winTile: number,
  seat: number,
  flags: number,
  table: FanTable
): boolean {
  const tileSuit = suit(winTile);
  if (tileSuit === 4) {
    return false;
  }
  const base = tileSuit << 4;
  let winningRank = rank(winTile);
  if (seat === 0 && (flags & 17) === 17) {
    let secondWin = 0;
    for (let value = 2; value <= 8; value++) {
      const count = standing[base + value];
      if (count === 0) {
        return false;
      }
      if (count === 2) {
        secondWin = base + value;
      }
    }
    if (secondWin !== 0) {
      if (standing[base + 1] !== 3 || standing[base + 9] !== 3) {
        return false;
      }
      winningRank = rank(secondWin);
    } else if (
      standing[base + 1] === 4 &&
      standing[base + 9] === 3
    ) {
      winningRank = 1;
    } else if (
      standing[base + 1] === 3 &&
      standing[base + 9] === 4
    ) {
      winningRank = 2;
    } else {
      return false;
    }
  } else if (winningRank === 1) {
    if (
      standing[winTile] !== 4 ||
      standing[base + 9] !== 3 ||
      Array.from({ length: 7 }, (_, index) => index + 2).some(
        (value) => standing[base + value] !== 1
      )
    ) {
      return false;
    }
  } else if (winningRank === 9) {
    if (
      standing[winTile] !== 4 ||
      standing[base + 1] !== 3 ||
      Array.from({ length: 7 }, (_, index) => index + 2).some(
        (value) => standing[base + value] !== 1
      )
    ) {
      return false;
    }
  } else if (
    standing[winTile] !== 2 ||
    standing[base + 1] !== 3 ||
    standing[base + 9] !== 3 ||
    Array.from({ length: winningRank - 2 }, (_, index) => index + 2).some(
      (value) => standing[base + value] !== 1
    ) ||
    Array.from(
      { length: Math.max(0, 8 - winningRank) },
      (_, index) => winningRank + 1 + index
    ).some((value) => standing[base + value] !== 1)
  ) {
    return false;
  }

  fanSet(table, "NINE_GATES", 1);
  if (winningRank === 1 || winningRank === 9) {
    fanSet(table, "PURE_STRAIGHT", 1);
    fanSet(table, "TILE_HOG", 1);
  } else if (winningRank === 2 || winningRank === 8) {
    fanSet(table, "TWO_CONCEALED_PUNGS", 1);
    fanSet(table, "SHORT_STRAIGHT", 1);
    fanSet(table, "PUNG_OF_TERMINALS_OR_HONORS", 1);
  } else if (winningRank === 5) {
    fanSet(table, "TWO_CONCEALED_PUNGS", 1);
    fanSet(table, "PUNG_OF_TERMINALS_OR_HONORS", 1);
  } else {
    fanSet(table, "SHORT_STRAIGHT", 1);
  }
  adjustWinFlags(flags, table);
  return true;
}

export function calculateRaw(
  tiles: readonly number[],
  fixedPacks: readonly number[],
  winTile: number,
  flags: number,
  prevalent: number,
  seat: number,
  flowers: number,
  evaluate: CandidateEvaluator
): RawScore {
  const fixed = fixedPacks.length;
  const empty = fanTable();
  if (
    tiles.length === 0 ||
    fixed < 0 ||
    fixed > 4 ||
    fixed * 3 + tiles.length !== 13
  ) {
    return { total: -1, table: empty };
  }

  const fixedTable = mapPacks(fixedPacks);
  const standing = mapTiles(tiles);
  standing[winTile]++;
  const unique = ALL_TILES.filter(
    (tile) => fixedTable[tile] !== 0 || standing[tile] !== 0
  );
  let corrected = flags;
  if (standing[winTile] !== 1) {
    corrected &= ~2;
  }
  if (fixedTable[winTile] === 3) {
    corrected |= 2;
  }
  if ((corrected & 4) !== 0) {
    if ((corrected & 1) !== 0) {
      if (!fixedPacks.some((value) => packType(value) === KONG)) {
        corrected &= ~4;
      }
    } else if (fixedTable[winTile] !== 0 || standing[winTile] !== 1) {
      corrected &= ~4;
    }
  }

  let maximum = 0;
  const temporary = fanTable();
  if (fixed === 0) {
    if (
      specialFan(standing, winTile, unique, corrected, temporary) ||
      knittedFan(
        fixedTable,
        standing,
        fixedPacks,
        winTile,
        prevalent,
        seat,
        corrected,
        temporary
      ) ||
      nineGates(standing, winTile, seat, corrected, temporary)
    ) {
      maximum = evaluate(temporary, null);
    }
  } else if (
    fixed === 1 &&
    knittedFan(
      fixedTable,
      standing,
      fixedPacks,
      winTile,
      prevalent,
      seat,
      corrected,
      temporary
    )
  ) {
    maximum = evaluate(temporary, null);
  }

  if (maximum === 0 || fanGet(temporary, "SEVEN_PAIRS") === 1) {
    const heavenly = seat === 0 && fixed === 0 && (corrected & 17) === 17;
    const hasUniqueWait =
      !heavenly && uniqueWaiting(standing, tiles.length, winTile);
    let selected: FanTable | null = null;
    for (const packs of divide(standing, fixedPacks)) {
      const current = fanTable();
      regularFan(
        packs,
        fixedTable,
        standing,
        unique,
        fixed,
        winTile,
        hasUniqueWait,
        corrected,
        prevalent,
        seat,
        current
      );
      const points = evaluate(current, packs);
      if (points > maximum) {
        maximum = points;
        selected = current;
      } else if (
        points === maximum &&
        (fanGet(current, "PURE_TRIPLE_CHOW") === 1 ||
          fanGet(temporary, "SEVEN_PAIRS") === 1 ||
          fanGet(current, "TRIPLE_PUNG") !== 0)
      ) {
        selected = current;
      }
    }
    if (selected) {
      temporary.set(selected);
    }
  }

  if (maximum === 0) {
    return { total: -3, table: empty };
  }
  fanSet(temporary, "FLOWER_TILES", flowers);
  return { total: maximum + flowers, table: temporary };
}

function adjustSelfDrawn(
  packs: readonly number[],
  fixed: number,
  selfDrawn: boolean,
  table: FanTable
): void {
  const meldedCount = packs
    .slice(0, fixed)
    .filter((value) => isMelded(value)).length;
  if (meldedCount === 0) {
    fanSet(
      table,
      selfDrawn ? "FULLY_CONCEALED_HAND" : "CONCEALED_HAND",
      1
    );
  } else if (meldedCount === 4) {
    fanSet(table, selfDrawn ? "SELF_DRAWN" : "MELDED_HAND", 1);
  } else if (selfDrawn) {
    fanSet(table, "SELF_DRAWN", 1);
  }
}

function adjustPair(
  tile: number,
  chowCount: number,
  table: FanTable
): void {
  if (chowCount === 4) {
    if (isNumbered(tile)) {
      fanSet(table, "ALL_CHOWS", 1);
    }
    return;
  }
  if (fanGet(table, "TWO_DRAGONS_PUNGS") !== 0) {
    if (isDragon(tile)) {
      fanSet(table, "LITTLE_THREE_DRAGONS", 1);
      fanSet(table, "TWO_DRAGONS_PUNGS", 0);
    }
    return;
  }
  if (fanGet(table, "BIG_THREE_WINDS") !== 0 && isWind(tile)) {
    fanSet(table, "LITTLE_FOUR_WINDS", 1);
    fanSet(table, "BIG_THREE_WINDS", 0);
  }
}

function adjustSuits(tiles: readonly number[], table: FanTable): void {
  let flags = 0;
  for (const tile of tiles) {
    flags |= 1 << suit(tile);
  }
  if ((flags & 0xf1) === 0) {
    fanSet(table, "NO_HONORS", 1);
  }
  if ((flags & 0xe3) === 0) {
    fanAdd(table, "ONE_VOIDED_SUIT");
  }
  if ((flags & 0xe5) === 0) {
    fanAdd(table, "ONE_VOIDED_SUIT");
  }
  if ((flags & 0xe9) === 0) {
    fanAdd(table, "ONE_VOIDED_SUIT");
  }
  if (fanGet(table, "ONE_VOIDED_SUIT") === 2) {
    fanSet(table, "ONE_VOIDED_SUIT", 0);
    if (fanGet(table, "NO_HONORS") === 0) {
      fanSet(table, "HALF_FLUSH", 1);
    } else {
      fanSet(table, "FULL_FLUSH", 1);
      fanSet(table, "NO_HONORS", 0);
    }
  }
  if (
    flags === 0x1e &&
    tiles.some(isWind) &&
    tiles.some(isDragon)
  ) {
    fanSet(table, "ALL_TYPES", 1);
  }
}

function adjustRange(tiles: readonly number[], table: FanTable): void {
  let flags = 0;
  for (const tile of tiles) {
    if (!isNumbered(tile)) {
      return;
    }
    flags |= 1 << rank(tile);
  }
  if ((flags & 0xffe1) === 0) {
    fanSet(table, (flags & 0x10) !== 0 ? "LOWER_FOUR" : "LOWER_TILES", 1);
    return;
  }
  if ((flags & 0xfc3f) === 0) {
    fanSet(table, (flags & 0x40) !== 0 ? "UPPER_FOUR" : "UPPER_TILES", 1);
    return;
  }
  if ((flags & 0xff8f) === 0) {
    fanSet(table, "MIDDLE_TILES", 1);
  }
}

function adjustPacksTraits(
  packs: readonly number[],
  table: FanTable
): void {
  let terminals = 0;
  let honors = 0;
  let fives = 0;
  let evens = 0;
  for (const value of packs) {
    const tile = packTile(value);
    if (isNumbered(tile)) {
      if (packType(value) === CHOW) {
        if (rank(tile) === 2 || rank(tile) === 8) {
          terminals++;
        } else if (
          rank(tile) === 4 ||
          rank(tile) === 5 ||
          rank(tile) === 6
        ) {
          fives++;
        }
      } else if (rank(tile) === 1 || rank(tile) === 9) {
        terminals++;
      } else if (rank(tile) === 5) {
        fives++;
      } else if ([2, 4, 6, 8].includes(rank(tile))) {
        evens++;
      }
    } else {
      honors++;
    }
  }
  if (terminals + honors === 5) {
    fanSet(table, "OUTSIDE_HAND", 1);
    return;
  }
  if (fives === 5) {
    fanSet(table, "ALL_FIVE", 1);
    return;
  }
  if (evens === 5) {
    fanSet(table, "ALL_EVEN_PUNGS", 1);
  }
}

function adjustTilesTraits(
  tiles: readonly number[],
  table: FanTable
): void {
  if (!tiles.some(isTerminalOrHonor)) {
    fanSet(table, "ALL_SIMPLES", 1);
  }
  if (tiles.every(isReversible)) {
    fanSet(table, "REVERSIBLE_TILES", 1);
  }
  if (tiles.every(isGreen)) {
    fanSet(table, "ALL_GREEN", 1);
  }
  if (fanGet(table, "ALL_SIMPLES") !== 0) {
    return;
  }
  if (tiles.every(isHonor)) {
    fanSet(table, "ALL_HONORS", 1);
    return;
  }
  if (tiles.every(isTerminal)) {
    fanSet(table, "ALL_TERMINALS", 1);
    return;
  }
  if (tiles.every(isTerminalOrHonor)) {
    fanSet(table, "ALL_TERMINALS_AND_HONORS", 1);
  }
}

function adjustTileHog(
  tiles: Int32Array,
  kongs: number,
  table: FanTable
): void {
  fanSet(
    table,
    "TILE_HOG",
    (Array.from(tiles).filter((count) => count === 4).length - kongs) & 255
  );
}

function adjustWaitingForm(
  concealed: readonly number[],
  winTile: number,
  table: FanTable
): void {
  if (
    fanGet(table, "MELDED_HAND") !== 0 ||
    fanGet(table, "FOUR_KONGS") !== 0
  ) {
    return;
  }
  let flags = 0;
  for (const value of concealed) {
    const tile = packTile(value);
    if (packType(value) === CHOW) {
      if (tile === winTile) {
        flags |= 2;
      } else if (tile + 1 === winTile || tile - 1 === winTile) {
        flags |= 1;
      }
    } else if (packType(value) === PAIR && tile === winTile) {
      flags |= 4;
    }
  }
  if ((flags & 1) !== 0) {
    fanSet(table, "EDGE_WAIT", 1);
  } else if ((flags & 2) !== 0) {
    fanSet(table, "CLOSED_WAIT", 1);
  } else if ((flags & 4) !== 0) {
    fanSet(table, "SINGLE_WAIT", 1);
  }
}

function finalAdjust(table: FanTable): void {
  if (fanGet(table, "BIG_FOUR_WINDS") !== 0) {
    fanSet(table, "ALL_PUNGS", 0);
    fanSet(table, "PUNG_OF_TERMINALS_OR_HONORS", 0);
  }
  if (fanGet(table, "BIG_THREE_DRAGONS") !== 0) {
    fanSet(table, "DRAGON_PUNG", 0);
  }
  if (fanGet(table, "ALL_GREEN") !== 0) {
    fanSet(table, "HALF_FLUSH", 0);
    fanSet(table, "ONE_VOIDED_SUIT", 0);
  }
  if (fanGet(table, "FOUR_KONGS") !== 0) {
    fanSet(table, "SINGLE_WAIT", 0);
  }
  if (fanGet(table, "ALL_TERMINALS") !== 0) {
    fanSet(table, "ALL_PUNGS", 0);
    fanSet(table, "OUTSIDE_HAND", 0);
    fanSet(table, "PUNG_OF_TERMINALS_OR_HONORS", 0);
    fanSet(table, "NO_HONORS", 0);
    fanSet(table, "DOUBLE_PUNG", 0);
  }
  if (fanGet(table, "LITTLE_FOUR_WINDS") !== 0) {
    fanSet(table, "PUNG_OF_TERMINALS_OR_HONORS", 0);
  }
  if (fanGet(table, "LITTLE_THREE_DRAGONS") !== 0) {
    fanSet(table, "DRAGON_PUNG", 0);
  }
  if (fanGet(table, "ALL_HONORS") !== 0) {
    fanSet(table, "ALL_PUNGS", 0);
    fanSet(table, "OUTSIDE_HAND", 0);
    fanSet(table, "PUNG_OF_TERMINALS_OR_HONORS", 0);
    fanSet(table, "ONE_VOIDED_SUIT", 0);
  }
  if (fanGet(table, "FOUR_CONCEALED_PUNGS") !== 0) {
    fanSet(table, "ALL_PUNGS", 0);
    fanSet(table, "CONCEALED_HAND", 0);
    if (fanGet(table, "FULLY_CONCEALED_HAND") !== 0) {
      fanSet(table, "FULLY_CONCEALED_HAND", 0);
      fanSet(table, "SELF_DRAWN", 1);
    }
  }
  if (fanGet(table, "PURE_TERMINAL_CHOWS") !== 0) {
    fanSet(table, "FULL_FLUSH", 0);
    fanSet(table, "ALL_CHOWS", 0);
    fanSet(table, "NO_HONORS", 0);
  }
  if (fanGet(table, "FOUR_PURE_SHIFTED_PUNGS") !== 0) {
    fanSet(table, "ALL_PUNGS", 0);
  }
  if (fanGet(table, "ALL_TERMINALS_AND_HONORS") !== 0) {
    fanSet(table, "ALL_PUNGS", 0);
    fanSet(table, "OUTSIDE_HAND", 0);
    fanSet(table, "PUNG_OF_TERMINALS_OR_HONORS", 0);
  }
  if (fanGet(table, "ALL_EVEN_PUNGS") !== 0) {
    fanSet(table, "ALL_PUNGS", 0);
    fanSet(table, "ALL_SIMPLES", 0);
    fanSet(table, "NO_HONORS", 0);
  }
  if (fanGet(table, "UPPER_TILES") !== 0) {
    fanSet(table, "NO_HONORS", 0);
  }
  if (fanGet(table, "MIDDLE_TILES") !== 0) {
    fanSet(table, "ALL_SIMPLES", 0);
    fanSet(table, "NO_HONORS", 0);
  }
  if (fanGet(table, "LOWER_TILES") !== 0) {
    fanSet(table, "NO_HONORS", 0);
  }
  if (fanGet(table, "THREE_SUITED_TERMINAL_CHOWS") !== 0) {
    fanSet(table, "ALL_CHOWS", 0);
    fanSet(table, "NO_HONORS", 0);
  }
  if (fanGet(table, "ALL_FIVE") !== 0) {
    fanSet(table, "ALL_SIMPLES", 0);
    fanSet(table, "NO_HONORS", 0);
  }
  if (fanGet(table, "UPPER_FOUR") !== 0) {
    fanSet(table, "NO_HONORS", 0);
  }
  if (fanGet(table, "LOWER_FOUR") !== 0) {
    fanSet(table, "NO_HONORS", 0);
  }
  if (
    fanGet(table, "BIG_THREE_WINDS") !== 0 &&
    fanGet(table, "ALL_HONORS") === 0 &&
    fanGet(table, "ALL_TERMINALS_AND_HONORS") === 0
  ) {
    if (fanGet(table, "PUNG_OF_TERMINALS_OR_HONORS") < 3) {
      throw new Error("Invalid Big Three Winds adjustment");
    }
    fanAdd(table, "PUNG_OF_TERMINALS_OR_HONORS", -3);
  }
  if (fanGet(table, "REVERSIBLE_TILES") !== 0) {
    fanSet(table, "ONE_VOIDED_SUIT", 0);
  }
  if (fanGet(table, "LAST_TILE_DRAW") !== 0) {
    fanSet(table, "SELF_DRAWN", 0);
  }
  if (fanGet(table, "OUT_WITH_REPLACEMENT_TILE") !== 0) {
    fanSet(table, "SELF_DRAWN", 0);
  }
  if (fanGet(table, "MELDED_HAND") !== 0) {
    fanSet(table, "SINGLE_WAIT", 0);
  }
  if (fanGet(table, "TWO_DRAGONS_PUNGS") !== 0) {
    fanSet(table, "DRAGON_PUNG", 0);
  }
  if (fanGet(table, "FULLY_CONCEALED_HAND") !== 0) {
    fanSet(table, "SELF_DRAWN", 0);
  }
  if (fanGet(table, "ALL_CHOWS") !== 0) {
    fanSet(table, "NO_HONORS", 0);
  }
  if (fanGet(table, "ALL_SIMPLES") !== 0) {
    fanSet(table, "NO_HONORS", 0);
  }
}

function adjustWinds(
  tile: number,
  prevalent: number,
  seat: number,
  table: FanTable
): void {
  const deducted =
    fanGet(table, "BIG_THREE_WINDS") !== 0 ||
    fanGet(table, "ALL_TERMINALS_AND_HONORS") !== 0 ||
    fanGet(table, "ALL_HONORS") !== 0 ||
    fanGet(table, "LITTLE_FOUR_WINDS") !== 0;
  if (tile - 0x41 === prevalent) {
    fanSet(table, "PREVALENT_WIND", 1);
    if (!deducted) {
      fanAdd(table, "PUNG_OF_TERMINALS_OR_HONORS", -1);
    }
  }
  if (tile - 0x41 === seat) {
    fanSet(table, "SEAT_WIND", 1);
    if (seat !== prevalent && !deducted) {
      fanAdd(table, "PUNG_OF_TERMINALS_OR_HONORS", -1);
    }
  }
}

function adjustWinFlags(flags: number, table: FanTable): void {
  if ((flags & 2) !== 0) {
    fanSet(table, "LAST_TILE", 1);
  }
  if ((flags & 1) !== 0) {
    fanSet(table, "SELF_DRAWN", 1);
    if ((flags & 8) !== 0) {
      fanSet(table, "LAST_TILE_DRAW", 1);
      fanSet(table, "SELF_DRAWN", 0);
    }
    if ((flags & 4) !== 0) {
      fanSet(table, "OUT_WITH_REPLACEMENT_TILE", 1);
      fanSet(table, "SELF_DRAWN", 0);
    }
  } else {
    if ((flags & 8) !== 0) {
      fanSet(table, "LAST_TILE_CLAIM", 1);
    }
    if ((flags & 4) !== 0) {
      fanSet(table, "ROBBING_THE_KONG", 1);
      fanSet(table, "LAST_TILE", 0);
    }
  }
}

function shiftedByOne(first: number, second: number, third: number): boolean {
  return first + 1 === second && second + 1 === third;
}

function shiftedByTwo(first: number, second: number, third: number): boolean {
  return first + 2 === second && second + 2 === third;
}

function allDifferent(first: number, second: number, third: number): boolean {
  return first !== second && first !== third && second !== third;
}

function shiftedUnordered(
  first: number,
  second: number,
  third: number
): boolean {
  return (
    shiftedByOne(second, first, third) ||
    shiftedByOne(third, first, second) ||
    shiftedByOne(first, second, third) ||
    shiftedByOne(third, second, first) ||
    shiftedByOne(first, third, second) ||
    shiftedByOne(second, third, first)
  );
}

function fourChowsFan(
  first: number,
  second: number,
  third: number,
  fourth: number
): McrFanId | null {
  if (
    (first + 2 === second &&
      second + 2 === third &&
      third + 2 === fourth) ||
    (first + 1 === second &&
      second + 1 === third &&
      third + 1 === fourth)
  ) {
    return "FOUR_PURE_SHIFTED_CHOWS";
  }
  if (first === second && first === third && first === fourth) {
    return "QUADRUPLE_CHOW";
  }
  return null;
}

function threeChowsFan(
  first: number,
  second: number,
  third: number
): McrFanId | null {
  const firstRank = rank(first);
  const secondRank = rank(second);
  const thirdRank = rank(third);
  if (allDifferent(suit(first), suit(second), suit(third))) {
    if (shiftedUnordered(secondRank, firstRank, thirdRank)) {
      return "MIXED_SHIFTED_CHOWS";
    }
    if (firstRank === secondRank && secondRank === thirdRank) {
      return "MIXED_TRIPLE_CHOW";
    }
    if (
      [firstRank, secondRank, thirdRank].sort((a, b) => a - b).join(",") ===
      "2,5,8"
    ) {
      return "MIXED_STRAIGHT";
    }
  } else {
    if (first + 3 === second && second + 3 === third) {
      return "PURE_STRAIGHT";
    }
    if (
      shiftedByTwo(first, second, third) ||
      shiftedByOne(first, second, third)
    ) {
      return "PURE_SHIFTED_CHOWS";
    }
    if (first === second && first === third) {
      return "PURE_TRIPLE_CHOW";
    }
  }
  return null;
}

function twoChowsFan(first: number, second: number): McrFanId | null {
  if (!sameSuit(first, second)) {
    if (sameRank(first, second)) {
      return "MIXED_DOUBLE_CHOW";
    }
  } else {
    if (first + 3 === second || second + 3 === first) {
      return "SHORT_STRAIGHT";
    }
    if (
      (rank(first) === 2 && rank(second) === 8) ||
      (rank(first) === 8 && rank(second) === 2)
    ) {
      return "TWO_TERMINAL_CHOWS";
    }
    if (first === second) {
      return "PURE_DOUBLE_CHOW";
    }
  }
  return null;
}

function fourPungsFan(
  first: number,
  second: number,
  third: number,
  fourth: number
): McrFanId | null {
  if (
    isNumbered(first) &&
    first + 1 === second &&
    second + 1 === third &&
    third + 1 === fourth
  ) {
    return "FOUR_PURE_SHIFTED_PUNGS";
  }
  if (
    first === 0x41 &&
    second === 0x42 &&
    third === 0x43 &&
    fourth === 0x44
  ) {
    return "BIG_FOUR_WINDS";
  }
  return null;
}

function threePungsFan(
  first: number,
  second: number,
  third: number
): McrFanId | null {
  if (isNumbered(first) && isNumbered(second) && isNumbered(third)) {
    const firstRank = rank(first);
    const secondRank = rank(second);
    const thirdRank = rank(third);
    if (allDifferent(suit(first), suit(second), suit(third))) {
      if (shiftedUnordered(secondRank, firstRank, thirdRank)) {
        return "MIXED_SHIFTED_PUNGS";
      }
      if (firstRank === secondRank && secondRank === thirdRank) {
        return "TRIPLE_PUNG";
      }
    } else if (first + 1 === second && second + 1 === third) {
      return "PURE_SHIFTED_PUNGS";
    }
  } else {
    const winds = [first, second, third];
    if (
      arraysEqual(winds, [0x41, 0x42, 0x43]) ||
      arraysEqual(winds, [0x41, 0x42, 0x44]) ||
      arraysEqual(winds, [0x41, 0x43, 0x44]) ||
      arraysEqual(winds, [0x42, 0x43, 0x44])
    ) {
      return "BIG_THREE_WINDS";
    }
    if (arraysEqual(winds, [0x45, 0x46, 0x47])) {
      return "BIG_THREE_DRAGONS";
    }
  }
  return null;
}

function twoPungsFan(first: number, second: number): McrFanId | null {
  if (isNumbered(first) && isNumbered(second)) {
    if (sameRank(first, second)) {
      return "DOUBLE_PUNG";
    }
  } else if (isDragon(first) && isDragon(second)) {
    return "TWO_DRAGONS_PUNGS";
  }
  return null;
}

function onePungFan(tile: number): McrFanId | null {
  if (isDragon(tile)) {
    return "DRAGON_PUNG";
  }
  if (isTerminal(tile) || isWind(tile)) {
    return "PUNG_OF_TERMINALS_OR_HONORS";
  }
  return null;
}

function extraChowFan(
  first: number,
  second: number,
  third: number,
  extra: number
): McrFanId | null {
  const candidates = [
    twoChowsFan(first, extra),
    twoChowsFan(second, extra),
    twoChowsFan(third, extra),
  ];
  for (const fan of [
    "PURE_DOUBLE_CHOW",
    "MIXED_DOUBLE_CHOW",
    "SHORT_STRAIGHT",
    "TWO_TERMINAL_CHOWS",
  ] as const) {
    if (candidates.includes(fan)) {
      return fan;
    }
  }
  return null;
}

function exclusionaryRule(
  fans: readonly (McrFanId | null)[],
  maximum: number,
  table: FanTable
): void {
  const lowFans = [
    "PURE_DOUBLE_CHOW",
    "MIXED_DOUBLE_CHOW",
    "SHORT_STRAIGHT",
    "TWO_TERMINAL_CHOWS",
  ] as const;
  const counts = [0, 0, 0, 0];
  let count = 0;
  for (const fan of fans) {
    if (fan) {
      const index = lowFans.indexOf(
        fan as (typeof lowFans)[number]
      );
      if (index >= 0) {
        count++;
        counts[index]++;
      }
    }
  }
  let limit = 1;
  while (count > maximum && limit >= 0) {
    for (let index = 3; count > maximum && index >= 0; index--) {
      while (counts[index] > limit && count > maximum) {
        counts[index]--;
        count--;
      }
    }
    limit--;
  }
  for (let index = 0; index < lowFans.length; index++) {
    fanSet(table, lowFans[index], counts[index]);
  }
}

function threeOfFourChows(
  first: number,
  second: number,
  third: number,
  extra: number,
  table: FanTable
): boolean {
  const fan = threeChowsFan(first, second, third);
  if (!fan) {
    return false;
  }
  fanSet(table, fan, 1);
  const extraFan = extraChowFan(first, second, third, extra);
  if (extraFan) {
    fanSet(table, extraFan, 1);
  }
  return true;
}

function calculateFourChows(tiles: readonly number[], table: FanTable): void {
  const fan = fourChowsFan(tiles[0], tiles[1], tiles[2], tiles[3]);
  if (fan) {
    fanSet(table, fan, 1);
    return;
  }
  if (
    threeOfFourChows(tiles[0], tiles[1], tiles[2], tiles[3], table) ||
    threeOfFourChows(tiles[0], tiles[1], tiles[3], tiles[2], table) ||
    threeOfFourChows(tiles[0], tiles[2], tiles[3], tiles[1], table) ||
    threeOfFourChows(tiles[1], tiles[2], tiles[3], tiles[0], table)
  ) {
    return;
  }
  const fans = [
    twoChowsFan(tiles[0], tiles[1]),
    twoChowsFan(tiles[0], tiles[2]),
    twoChowsFan(tiles[0], tiles[3]),
    twoChowsFan(tiles[1], tiles[2]),
    twoChowsFan(tiles[1], tiles[3]),
    twoChowsFan(tiles[2], tiles[3]),
  ];
  let maximum = 3;
  if (!fans[0] && !fans[1] && !fans[2]) {
    maximum--;
  }
  if (!fans[0] && !fans[3] && !fans[4]) {
    maximum--;
  }
  if (!fans[1] && !fans[3] && !fans[5]) {
    maximum--;
  }
  if (!fans[2] && !fans[4] && !fans[5]) {
    maximum--;
  }
  if (maximum > 0) {
    exclusionaryRule(fans, maximum, table);
  }
}

function calculateThreeChows(tiles: readonly number[], table: FanTable): void {
  const fan = threeChowsFan(tiles[0], tiles[1], tiles[2]);
  if (fan) {
    fanSet(table, fan, 1);
    return;
  }
  exclusionaryRule(
    [
      twoChowsFan(tiles[0], tiles[1]),
      twoChowsFan(tiles[0], tiles[2]),
      twoChowsFan(tiles[1], tiles[2]),
    ],
    2,
    table
  );
}

function calculateFourPungs(tiles: readonly number[], table: FanTable): void {
  const fan = fourPungsFan(tiles[0], tiles[1], tiles[2], tiles[3]);
  if (fan) {
    fanSet(table, fan, 1);
    return;
  }
  let free = -1;
  const selections = [
    [0, 1, 2, 3],
    [0, 1, 3, 2],
    [0, 2, 3, 1],
    [1, 2, 3, 0],
  ];
  for (const indices of selections) {
    const selectedFan = threePungsFan(
      tiles[indices[0]],
      tiles[indices[1]],
      tiles[indices[2]]
    );
    if (selectedFan) {
      fanSet(table, selectedFan, 1);
      free = indices[3];
      break;
    }
  }
  if (free >= 0) {
    for (let index = 0; index < 4; index++) {
      if (index === free) {
        continue;
      }
      const pairFan = twoPungsFan(tiles[index], tiles[free]);
      if (pairFan) {
        fanAdd(table, pairFan);
        break;
      }
    }
    return;
  }
  for (let first = 0; first <= 2; first++) {
    for (let second = first + 1; second <= 3; second++) {
      const pairFan = twoPungsFan(tiles[first], tiles[second]);
      if (pairFan) {
        fanAdd(table, pairFan);
      }
    }
  }
}

function calculateThreePungs(tiles: readonly number[], table: FanTable): void {
  const fan = threePungsFan(tiles[0], tiles[1], tiles[2]);
  if (fan) {
    fanSet(table, fan, 1);
    return;
  }
  for (let first = 0; first <= 1; first++) {
    for (let second = first + 1; second <= 2; second++) {
      const pairFan = twoPungsFan(tiles[first], tiles[second]);
      if (pairFan) {
        fanAdd(table, pairFan);
      }
    }
  }
}

function calculateKongs(
  concealedPungs: number,
  meldedKongs: number,
  concealedKongs: number,
  table: FanTable
): void {
  const concealed = (count: number): void => {
    if (count === 2) {
      fanSet(table, "TWO_CONCEALED_PUNGS", 1);
    } else if (count === 3) {
      fanSet(table, "THREE_CONCEALED_PUNGS", 1);
    } else if (count === 4) {
      fanSet(table, "FOUR_CONCEALED_PUNGS", 1);
    }
  };
  const kongs = meldedKongs + concealedKongs;
  if (kongs === 0) {
    concealed(concealedPungs);
  } else if (kongs === 1) {
    if (meldedKongs === 1) {
      fanSet(table, "MELDED_KONG", 1);
      concealed(concealedPungs);
    } else {
      fanSet(table, "CONCEALED_KONG", 1);
      concealed(concealedPungs + 1);
    }
  } else if (kongs === 2) {
    if (concealedKongs === 0) {
      fanSet(table, "TWO_MELDED_KONGS", 1);
      if (concealedPungs === 2) {
        fanSet(table, "TWO_CONCEALED_PUNGS", 1);
      }
    } else if (concealedKongs === 1) {
      fanSet(table, MIXED_KONG_MARKER, 1);
      concealed(concealedPungs + 1);
    } else {
      fanSet(table, "TWO_CONCEALED_KONGS", 1);
      if (concealedPungs > 0) {
        concealed(concealedPungs + 2);
      }
    }
  } else if (kongs === 3) {
    fanSet(table, "THREE_KONGS", 1);
    if (concealedKongs === 1 && concealedPungs > 0) {
      fanSet(table, "TWO_CONCEALED_PUNGS", 1);
    } else if (concealedKongs === 2) {
      fanSet(
        table,
        concealedPungs === 0
          ? "TWO_CONCEALED_PUNGS"
          : "THREE_CONCEALED_PUNGS",
        1
      );
    } else if (concealedKongs === 3) {
      fanSet(
        table,
        concealedPungs === 0
          ? "THREE_CONCEALED_PUNGS"
          : "FOUR_CONCEALED_PUNGS",
        1
      );
    }
  } else if (kongs === 4) {
    fanSet(table, "FOUR_KONGS", 1);
    concealed(concealedKongs);
  }
}

function pureTerminalChows(
  chows: readonly number[],
  pair: number
): boolean {
  const pairTile = packTile(pair);
  if (rank(pairTile) !== 5) {
    return false;
  }
  let low = 0;
  let high = 0;
  for (const value of chows) {
    const tile = packTile(value);
    if (suit(tile) !== suit(pairTile)) {
      return false;
    }
    if (rank(tile) === 2) {
      low++;
    } else if (rank(tile) === 8) {
      high++;
    } else {
      return false;
    }
  }
  return low === 2 && high === 2;
}

function threeSuitedTerminalChows(
  chows: readonly number[],
  pair: number
): boolean {
  const pairTile = packTile(pair);
  if (rank(pairTile) !== 5) {
    return false;
  }
  const low = new Int32Array(4);
  const high = new Int32Array(4);
  const pairSuit = suit(pairTile);
  for (const value of chows) {
    const tile = packTile(value);
    if (suit(tile) === pairSuit) {
      return false;
    }
    if (rank(tile) === 2) {
      low[suit(tile)]++;
    } else if (rank(tile) === 8) {
      high[suit(tile)]++;
    } else {
      return false;
    }
  }
  if (pairSuit === 1) {
    return low[2] !== 0 && low[3] !== 0 && high[2] !== 0 && high[3] !== 0;
  }
  if (pairSuit === 2) {
    return low[1] !== 0 && low[3] !== 0 && high[1] !== 0 && high[3] !== 0;
  }
  if (pairSuit === 3) {
    return low[1] !== 0 && low[2] !== 0 && high[1] !== 0 && high[2] !== 0;
  }
  return false;
}

function checkSevenPairsWaiting(
  standing: Int32Array,
  waiting: Int32Array
): void {
  let pairs = 0;
  for (const tile of ALL_TILES) {
    if (standing[tile] === 2 || standing[tile] === 3) {
      pairs++;
    } else if (standing[tile] === 4) {
      pairs += 2;
    }
  }
  if (pairs === 6) {
    for (const tile of ALL_TILES) {
      if (standing[tile] === 1 || standing[tile] === 3) {
        waiting[tile] = 1;
        break;
      }
    }
  }
}

function regularPackWaiting(table: Int32Array, waiting: Int32Array): void {
  for (const tile of ALL_TILES) {
    if (table[tile] < 1) {
      continue;
    }
    if (table[tile] > 1) {
      waiting[tile] = 1;
      return;
    }
    if (isNumbered(tile)) {
      const tileRank = rank(tile);
      if (tileRank > 1 && table[tile - 1] !== 0) {
        if (tileRank < 9) {
          waiting[tile + 1] = 1;
        }
        if (tileRank > 2) {
          waiting[tile - 2] = 1;
        }
        return;
      }
      if (tileRank > 2 && table[tile - 2] !== 0) {
        waiting[tile - 1] = 1;
        return;
      }
    }
  }
}

function checkRegularWaiting(
  table: Int32Array,
  count: number,
  previous: number,
  waiting: Int32Array
): void {
  if (count === 1) {
    for (const tile of ALL_TILES) {
      if (table[tile] === 1) {
        waiting[tile] = 1;
        break;
      }
    }
    return;
  }
  if (count === 4) {
    for (const tile of ALL_TILES) {
      if (table[tile] < 2) {
        continue;
      }
      table[tile] -= 2;
      regularPackWaiting(table, waiting);
      table[tile] += 2;
    }
  }
  for (const tile of ALL_TILES) {
    if (table[tile] < 1) {
      continue;
    }
    if (table[tile] > 2) {
      const order = eigen(tile, tile, tile);
      if (order > previous) {
        table[tile] -= 3;
        checkRegularWaiting(table, count - 3, order, waiting);
        table[tile] += 3;
      }
    }
    if (
      isNumbered(tile) &&
      rank(tile) < 8 &&
      table[tile + 1] !== 0 &&
      table[tile + 2] !== 0
    ) {
      const order = eigen(tile, tile + 1, tile + 2);
      if (order >= previous) {
        table[tile]--;
        table[tile + 1]--;
        table[tile + 2]--;
        checkRegularWaiting(table, count - 3, order, waiting);
        table[tile]++;
        table[tile + 1]++;
        table[tile + 2]++;
      }
    }
  }
}

function uniqueWaiting(
  standing: Int32Array,
  count: number,
  winTile: number
): boolean {
  const waiting = new Int32Array(TABLE_SIZE);
  standing[winTile] = (standing[winTile] - 1) & 0xffff;
  if (count === 13) {
    checkSevenPairsWaiting(standing, waiting);
  }
  checkRegularWaiting(standing, count, 0, waiting);
  standing[winTile] = (standing[winTile] + 1) & 0xffff;
  return ALL_TILES.filter((tile) => waiting[tile] !== 0).length === 1;
}

function divideTail(
  table: Int32Array,
  fixed: number,
  work: number[],
  result: number[][]
): boolean {
  for (const tile of ALL_TILES) {
    if (table[tile] < 2) {
      continue;
    }
    table[tile] -= 2;
    const used = table.every((value) => value === 0);
    table[tile] += 2;
    if (used) {
      work[4] = pack(0, PAIR, tile);
      const copy = [...work];
      if (fixed < 4) {
        const sorted = copy
          .slice(fixed, 4)
          .sort((first, second) => first - second);
        copy.splice(fixed, 4 - fixed, ...sorted);
      }
      if (
        !result.some((old) =>
          old.slice(fixed, 4).every((value, index) => value === copy[fixed + index])
        )
      ) {
        result.push(copy);
      }
      return true;
    }
  }
  return false;
}

function divideRec(
  table: Int32Array,
  fixed: number,
  step: number,
  previous: number,
  work: number[],
  result: number[][]
): boolean {
  const index = fixed + step;
  if (index === 4) {
    return divideTail(table, fixed, work, result);
  }
  let found = false;
  for (const tile of ALL_TILES) {
    if (table[tile] < 1) {
      continue;
    }
    if (table[tile] > 2) {
      const order = eigen(tile, tile, tile);
      if (order > previous) {
        work[index] = pack(0, PUNG, tile);
        table[tile] -= 3;
        if (divideRec(table, fixed, step + 1, order, work, result)) {
          found = true;
        }
        table[tile] += 3;
      }
    }
    if (
      isNumbered(tile) &&
      rank(tile) < 8 &&
      table[tile + 1] !== 0 &&
      table[tile + 2] !== 0
    ) {
      const order = eigen(tile, tile + 1, tile + 2);
      if (order >= previous) {
        work[index] = pack(0, CHOW, tile + 1);
        table[tile]--;
        table[tile + 1]--;
        table[tile + 2]--;
        if (divideRec(table, fixed, step + 1, order, work, result)) {
          found = true;
        }
        table[tile]++;
        table[tile + 1]++;
        table[tile + 2]++;
      }
    }
  }
  return found;
}

function divide(
  table: Int32Array,
  fixedPacks: readonly number[]
): number[][] {
  const result: number[][] = [];
  if (ALL_TILES.every((tile) => table[tile] <= 1)) {
    return result;
  }
  const work = new Array<number>(5).fill(0);
  fixedPacks.forEach((value, index) => {
    work[index] = value;
  });
  divideRec(table, fixedPacks.length, 0, 0, work, result);
  return result;
}

function arraysEqual(
  first: readonly number[],
  second: readonly number[]
): boolean {
  return (
    first.length === second.length &&
    first.every((value, index) => value === second[index])
  );
}

export function publicFanTotal(table: FanTable): number {
  return MCR_FAN_IDS.reduce(
    (total, id) => total + MCR_FANS[id].points * fanGet(table, id),
    0
  );
}
