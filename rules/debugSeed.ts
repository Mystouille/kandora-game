import type { MatchDebug } from "../protocol/messages";
import type { PlayerCount } from "../protocol/seat";
import type { Action } from "./actions";
import type { RuleSet } from "./ruleSet";
import type { MatchState } from "./state";
import { isPlayableTile } from "./tileAvailability";
import type { Tile } from "./types";
import { buildAllTiles, normalizeMcrOpeningFlowers } from "./wall";

export function debugDiscardSeat(playerCount: PlayerCount): 2 | 3 {
  return playerCount === 3 ? 2 : 3;
}

export function debugSeedValidationError(
  debug: MatchDebug,
  rules: RuleSet
): string | null {
  if (debug === undefined) {
    return null;
  }
  if (debug.humanHand !== undefined && debug.humanHand.length !== 13) {
    return `Starting hand should have 13 tiles, got ${debug.humanHand.length}.`;
  }
  const inventory = new Set(
    buildAllTiles({
      rulesFamily: rules.rulesFamily,
      playerCount: rules.playerCount,
      sanmaType: rules.sanmaType,
      redFives: {
        m: rules.nbRedFiveManzu,
        p: rules.nbRedFivePinzu,
        s: rules.nbRedFiveSouzu,
      },
    })
  );
  const unavailable = [
    ...new Set([
      ...(debug.humanHand ?? []),
      ...(debug.humanDraws ?? []),
      ...(debug.leftDiscards ?? []),
    ]),
  ].filter((tile) => !inventory.has(tile));
  if (unavailable.length > 0) {
    return `Tile(s) not available for this game type: ${unavailable.join(", ")}.`;
  }
  if (debug.leftDiscards?.some((tile) => !isPlayableTile(tile, rules))) {
    return "Forced discards cannot contain flowers or mandatory Kansai nuki tiles.";
  }
  return null;
}

export function applyDebugHand(
  state: MatchState,
  debug: NonNullable<MatchDebug>,
  humanDrawQueue: Tile[]
): void {
  if (state.ruleSet.rulesFamily === "mcr") {
    if (debug.humanHand !== undefined || humanDrawQueue.length > 0) {
      const openingDraw = state.lastDrawn[0];
      if (openingDraw === null || state.hands[0].length !== 14) {
        throw new Error("Debug seed requires MCR's fourteen-tile opening hand");
      }
      state.hands[0] = [
        ...(debug.humanHand ?? state.hands[0].slice(0, 13)),
        humanDrawQueue.shift() ?? openingDraw,
      ];
      if (debug.humanHand !== undefined) {
        state.flowerTiles[0] = [];
      }
      normalizeMcrOpeningFlowers(
        state.hands[0],
        state.flowerTiles[0],
        () => humanDrawQueue.shift() ?? state.liveWall.pop()
      );
      state.lastDrawn[0] = state.hands[0][13];
    }
  } else if (debug.humanHand !== undefined) {
    state.hands[0] = [...debug.humanHand];
  }
}

export function withDebugReplacement(
  state: MatchState,
  action: Action,
  tile: Tile | undefined
): MatchState {
  if (
    tile === undefined ||
    ("forceExhaustive" in action && action.forceExhaustive === true)
  ) {
    return state;
  }
  const seat =
    action.type === "kan" && action.kind !== "shouminkan"
      ? action.seat
      : action.type === "complete_shouminkan"
        ? state.pendingShouminkan?.seat
        : action.type === "complete_nuki"
          ? state.pendingNuki?.seat
          : action.type === "complete_flower"
            ? state.pendingFlower?.seat
            : undefined;
  if (seat !== 0) {
    return state;
  }
  const wallKey = state.ruleSet.rulesFamily === "mcr" ? "liveWall" : "deadWall";
  if (state[wallKey].length === 0) {
    return state;
  }
  // Keep reserve movement and indicator accounting in the engine.
  const wall = [...state[wallKey]];
  wall[wallKey === "liveWall" ? wall.length - 1 : 0] = tile;
  return { ...state, [wallKey]: wall };
}
