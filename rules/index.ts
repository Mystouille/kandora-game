/**
 * Public surface of the pure rules engine.
 *
 * Anything outside `app/game/rules/` should import from this barrel,
 * not from individual modules — gives us room to reorganize internals
 * without churning callers.
 */

export type { Tile, Seat, Wind, Suit } from "./types";
export { SEATS, SUITS, WIND_TILES, DRAGON_TILES, compareTiles } from "./types";

export type { PRNG } from "./prng";
export { createPRNG, hashStringToSeed } from "./prng";

export type { WallOptions, DealtMatch } from "./wall";
export { buildAllTiles, dealMatch } from "./wall";

export type {
  MatchPhase,
  MatchState,
  MatchOptions,
  HandResult,
  Meld,
} from "./state";
export { createInitialState } from "./state";

export type {
  Action,
  DiscardAction,
  DrawAction,
  TsumoAction,
  RonAction,
  RiichiAction,
  ChiAction,
  PonAction,
  KanAction,
  AbortAction,
  StartNextHandAction,
} from "./actions";

export type { EngineEvent, StepResult, FuritenChange } from "./step";
export { step, seatWind, isFuritenForRon } from "./step";

export type { MatchEndReason, MatchEndDecision } from "./matchEnd";
export { isFinalHandOfMatch, shouldEndMatch } from "./matchEnd";

export type { DistributeInput } from "./payments";
export { distributePayments } from "./payments";

export type { HandCounts, SuitBlock } from "./shanten";
export {
  acceptanceTiles,
  chiitoitsuShanten,
  countsFromTiles,
  isTenpai,
  isWinningShape,
  kokushiShanten,
  precomputeSuitTable,
  shanten,
  standardShanten,
  tileToIndex,
  waits,
} from "./shanten";

export type { ScoreInput, ScoreResult } from "./score";
export { buildRiichiInput, indicatorToDora, scoreHand } from "./score";

export type { RuleSet, RuleSetOverride } from "./ruleSet";
export {
  DEFAULT_RULE_SET,
  TONPUU_RULE_SET,
  isAkaDisabled,
  resolveRuleSet,
} from "./ruleSet";

export type { RuleSetPreset } from "./presets";
export {
  DEFAULT_PRESET_ID,
  getPreset,
  listPresetIds,
  listPresets,
  presetToRuleSet,
} from "./presets";

export { isAnkanLegalDuringRiichi } from "./riichiKan";

export type { CallOption, SeatCallOptions } from "./calls";
export { enumerateCalls } from "./calls";
