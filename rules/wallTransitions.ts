import type { SanmaType } from "../protocol/seat";
import type { Tile } from "./types";

export type SanmaReplacementKind = "kan" | "nuki";

export interface SanmaWallState {
  sanmaType: SanmaType;
  mode: "standard" | "duplicate";
  /** Total committed kan and nuki replacements, from zero through eight. */
  replacementsTaken: number;
  /** Committed kans, from zero through four, independent of dora presentation. */
  kanCount: number;
}

/** Structural interface so the wall policy does not depend on MatchState. */
export interface SanmaWallContext {
  liveWall: Tile[];
  deadWall: Tile[];
  sanmaWall?: SanmaWallState;
}

export interface SanmaIndicatorPair {
  dora: Tile;
  ura: Tile;
}

export interface SanmaReplacement {
  tile: Tile;
  /** Present only for a kan; the caller decides when to reveal the reserved pair. */
  indicators?: SanmaIndicatorPair;
}

const MAX_KANS = 4;
const MAX_NUKIS = 4;
const MAX_REPLACEMENTS = MAX_KANS + MAX_NUKIS;

function containsTiles(tiles: readonly Tile[]): boolean {
  for (const tile of tiles) {
    if (typeof tile !== "string" || tile.length === 0) {
      return false;
    }
  }
  return true;
}

function validatedState(
  wall: Readonly<SanmaWallContext>
): SanmaWallState | undefined {
  const state = wall.sanmaWall;
  if (
    !state ||
    (state.sanmaType !== "online" && state.sanmaType !== "kansai") ||
    (state.mode !== "standard" && state.mode !== "duplicate") ||
    !Number.isInteger(state.replacementsTaken) ||
    !Number.isInteger(state.kanCount) ||
    state.replacementsTaken < 0 ||
    state.replacementsTaken > MAX_REPLACEMENTS ||
    state.kanCount < 0 ||
    state.kanCount > MAX_KANS ||
    state.replacementsTaken < state.kanCount ||
    state.replacementsTaken - state.kanCount > MAX_NUKIS
  ) {
    return undefined;
  }
  const expectedReserve =
    state.mode === "standard" && state.sanmaType === "kansai"
      ? 10 - state.replacementsTaken + 2 * state.kanCount
      : 14;
  if (
    !Array.isArray(wall.liveWall) ||
    !Array.isArray(wall.deadWall) ||
    wall.deadWall.length !== expectedReserve ||
    !containsTiles(wall.liveWall) ||
    !containsTiles(wall.deadWall)
  ) {
    return undefined;
  }
  return state;
}

function indicatorPair(
  deadWall: readonly Tile[],
  state: SanmaWallState,
  kanIndex: number
): SanmaIndicatorPair | undefined {
  // Standard walls shift only their replacement prefix; Duplicate never shifts.
  const boundary =
    state.mode === "duplicate" ? 4 : MAX_REPLACEMENTS - state.replacementsTaken;
  const dora = deadWall[boundary + 2 * kanIndex];
  const ura = deadWall[boundary + 2 * kanIndex + 1];
  if (dora === undefined || ura === undefined) {
    return undefined;
  }
  return { dora, ura };
}

/**
 * Read an already committed pair, including the opening pair at index zero.
 * Defaults to the most recent kan. Uncommitted indices or invalid wall state
 * return undefined; reveal timing and public dora arrays are deliberately ignored.
 */
export function getSanmaIndicatorPair(
  wall: Readonly<SanmaWallContext>,
  kanIndex?: number
): SanmaIndicatorPair | undefined {
  const state = validatedState(wall);
  if (!state) {
    return undefined;
  }
  const index = kanIndex ?? state.kanCount;
  if (!Number.isInteger(index) || index < 0 || index > state.kanCount) {
    return undefined;
  }
  return indicatorPair(wall.deadWall, state, index);
}

interface PreparedReplacement {
  liveWall: Tile[];
  deadWall: Tile[];
  sanmaWall: SanmaWallState;
  result: SanmaReplacement;
}

function prepareReplacement(
  wall: Readonly<SanmaWallContext>,
  kind: SanmaReplacementKind,
  suppliedTile?: Tile
): PreparedReplacement | undefined {
  const state = validatedState(wall);
  if (
    !state ||
    (kind !== "kan" && kind !== "nuki") ||
    state.replacementsTaken >= MAX_REPLACEMENTS ||
    (kind === "kan" && state.kanCount >= MAX_KANS) ||
    (kind === "nuki" && state.replacementsTaken - state.kanCount >= MAX_NUKIS)
  ) {
    return undefined;
  }

  const sanmaWall: SanmaWallState = {
    ...state,
    replacementsTaken: state.replacementsTaken + 1,
    kanCount: state.kanCount + (kind === "kan" ? 1 : 0),
  };
  const liveWall = [...wall.liveWall];
  let deadWall: Tile[];
  let tile: Tile;
  if (state.mode === "duplicate") {
    if (suppliedTile === undefined) {
      return undefined;
    }
    const index = liveWall.indexOf(suppliedTile);
    if (index < 0) {
      return undefined;
    }
    tile = liveWall.splice(index, 1)[0];
    deadWall = wall.deadWall;
  } else {
    const reserveCount =
      state.sanmaType === "online" ? 1 : kind === "kan" ? 2 : 0;
    if (suppliedTile !== undefined || liveWall.length < reserveCount) {
      return undefined;
    }
    tile = wall.deadWall[0];
    deadWall = wall.deadWall.slice(1);
    for (let count = 0; count < reserveCount; count++) {
      deadWall.push(liveWall.pop()!);
    }
  }

  const result: SanmaReplacement = { tile };
  if (kind === "kan") {
    const indicators = indicatorPair(deadWall, sanmaWall, sanmaWall.kanCount);
    if (!indicators) {
      return undefined;
    }
    result.indicators = indicators;
  }
  return { liveWall, deadWall, sanmaWall, result };
}

/** Pure preflight with the same validation and resource checks as the commit. */
export function canTakeSanmaReplacement(
  wall: Readonly<SanmaWallContext>,
  kind: SanmaReplacementKind,
  suppliedTile?: Tile
): boolean {
  return prepareReplacement(wall, kind, suppliedTile) !== undefined;
}

/**
 * Commit to a caller-owned wall-bearing state, or return undefined unchanged.
 * Replaces arrays/metadata rather than mutating shared references; Duplicate's
 * physical reserve is untouched. Invalid state never falls back to yonma rules.
 *
 * Standard Online replenishes one live-tail tile for either cause. Standard
 * Kansai appends two live-tail tiles, last tile first, only for a kan.
 * Duplicate requires the trusted acting-queue tile and removes one exact match
 * from the live pool; validating and committing that personal queue is the caller's
 * responsibility. No hands, nuki records, dora arrays or events are changed here.
 */
export function takeSanmaReplacement(
  wall: SanmaWallContext,
  kind: SanmaReplacementKind,
  suppliedTile?: Tile
): SanmaReplacement | undefined {
  const prepared = prepareReplacement(wall, kind, suppliedTile);
  if (!prepared) {
    return undefined;
  }
  wall.liveWall = prepared.liveWall;
  wall.deadWall = prepared.deadWall;
  wall.sanmaWall = prepared.sanmaWall;
  return prepared.result;
}
