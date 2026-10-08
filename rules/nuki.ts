import type { NukiAction } from "./actions";
import type { RuleSet } from "./ruleSet";
import { activeSeats, isActiveSeat } from "./seats";
import type { MatchState } from "./state";
import type { Seat, Tile } from "./types";
import {
  canTakeSanmaReplacement,
  getSanmaIndicatorPair,
} from "./wallTransitions";

export type PendingRobbery =
  | { kind: "shouminkan"; seat: Seat; tile: Tile; ponIdx: number }
  | { kind: "nuki"; seat: Seat; tile: Tile; opening: false };

/** Only unresolved declarations are robbable; terminal custody is not a window. */
export function getPendingRobbery(state: MatchState): PendingRobbery | null {
  if (
    state.phase !== "awaiting_chankan" ||
    (state.pendingShouminkan != null && state.pendingNuki != null)
  ) {
    return null;
  }
  if (state.pendingShouminkan != null) {
    return isActiveSeat(state.pendingShouminkan.seat, state.ruleSet.playerCount)
      ? { kind: "shouminkan", ...state.pendingShouminkan }
      : null;
  }
  const pending = state.pendingNuki;
  if (
    pending != null &&
    state.ruleSet.playerCount === 3 &&
    state.ruleSet.sanmaType === "online" &&
    pending.tile === "4z" &&
    !pending.opening &&
    isActiveSeat(pending.seat, 3)
  ) {
    return {
      kind: "nuki",
      seat: pending.seat,
      tile: pending.tile,
      opening: false,
    };
  }
  return null;
}

export function isNukiTile(
  tile: Tile,
  rules: Pick<RuleSet, "playerCount" | "sanmaType">
): boolean {
  return (
    rules.playerCount === 3 &&
    (rules.sanmaType === "online"
      ? tile === "4z"
      : tile === "5m" || tile === "0m")
  );
}

/** Committed or pending North interrupts the first go-around, never Kansai nuki. */
export function hasNukiInterruption(state: MatchState): boolean {
  return (
    state.ruleSet.playerCount === 3 &&
    state.ruleSet.sanmaType === "online" &&
    (state.pendingNuki != null ||
      state.nukiTiles.some((tiles) => tiles.length > 0))
  );
}

function isOpeningWindow(state: MatchState): boolean {
  return (
    state.phase === "awaiting_draw" &&
    state.turn === state.dealer &&
    state.lastDiscard === null &&
    state.lastDrawn.every((tile) => tile === null) &&
    state.discards.every((tiles) => tiles.length === 0) &&
    state.melds.every((melds) => melds.length === 0) &&
    state.riichiDeclared.every((declared) => !declared) &&
    state.hands.every((hand) => hand.length === 13)
  );
}

/**
 * Declaration preflight without consuming a tile. Duplicate personal-queue
 * ownership is the driver's responsibility; its supplied peek is preflighted
 * against the aggregate pool without consuming it.
 * Mandatory Kansai declarations may precede an exhausted-queue settlement.
 */
export function canDeclareNuki(state: MatchState, action: NukiAction): boolean {
  const rules = state.ruleSet;
  if (
    !isActiveSeat(action.seat, rules.playerCount) ||
    !isNukiTile(action.tile, rules) ||
    state.pendingNuki != null ||
    state.pendingShouminkan != null ||
    state.pendingRyuukyoku != null ||
    state.sanmaWall?.sanmaType !== rules.sanmaType ||
    !getSanmaIndicatorPair(state, 0) ||
    state.nukiTiles.reduce((count, tiles) => count + tiles.length, 0) >= 4 ||
    state.sanmaWall.replacementsTaken - state.sanmaWall.kanCount >= 4
  ) {
    return false;
  }
  const hand = state.hands[action.seat];
  if (!hand.includes(action.tile)) {
    return false;
  }
  if (action.opening === true) {
    if (rules.sanmaType !== "kansai" || !isOpeningWindow(state)) {
      return false;
    }
  } else {
    if (
      state.phase !== "awaiting_discard" ||
      state.turn !== action.seat ||
      state.lastDrawn[action.seat] === null ||
      hand.length !== 14 - 3 * state.melds[action.seat].length
    ) {
      return false;
    }
    if (
      rules.sanmaType === "online" &&
      state.riichiDeclared[action.seat] &&
      (state.lastDrawn[action.seat] !== action.tile ||
        hand.at(-1) !== action.tile)
    ) {
      return false;
    }
  }
  if (rules.sanmaType === "kansai" && action.replacementTile === undefined) {
    return true;
  }
  return canTakeSanmaReplacement(
    state,
    "nuki",
    state.sanmaWall.mode === "duplicate"
      ? (action.replacementTile ?? state.liveWall[0])
      : action.replacementTile
  );
}

/**
 * One forced action at a time. Opening processing is dealer-relative, retaining
 * the same seat through any replacement chain before visiting the next seat.
 */
export function nextAutomaticNuki(
  state: MatchState,
  opening = false
): NukiAction | null {
  if (state.ruleSet.playerCount !== 3 || state.ruleSet.sanmaType !== "kansai") {
    return null;
  }
  const seats = opening
    ? activeSeats(3).map((offset) => ((state.dealer + offset) % 3) as Seat)
    : [state.turn];
  for (const seat of seats) {
    const tile = state.hands[seat].find((candidate) =>
      isNukiTile(candidate, state.ruleSet)
    );
    if (tile === undefined) {
      continue;
    }
    const action: NukiAction = { type: "nuki", seat, tile, opening };
    if (canDeclareNuki(state, action)) {
      return action;
    }
  }
  return null;
}
