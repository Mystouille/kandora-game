/**
 * Configurable rules ("RuleSet") for a match.
 *
 * The engine keeps the canonical Tenhou-default rule set at module
 * scope (`DEFAULT_RULE_SET`); everything else is opt-in via a
 * partial override passed to `createInitialState({ ruleSet })`.
 *
 * Toggles only cover behavior the engine actually implements today —
 * additions (e.g. nagashi mangan, agari yame, busted-on-zero) land
 * alongside the features they gate.
 *
 * Wire format: `RuleSet` is structurally JSON-serializable so it
 * round-trips through Mongo / WebSocket without conversion.
 */

export interface RuleSet {
  /**
   * Number of round winds played (E only / E+S / E+S+W+N).
   *   1 = tonpuusen (East-only)
   *   2 = hanchan (East + South)   ← Tenhou default
   *   4 = full nankan (E+S+W+N)
   */
  roundWindCount: 1 | 2 | 4;
  /** Hands per round wind (4 = standard E1..E4). */
  roundLimit: number;
  /** Starting score per seat. */
  startingScore: number;
  /** Number of red 5s per numbered suit (0 disables aka entirely). */
  redFivesPerSuit: 0 | 1;
  /** Open tanyao (kuitan) is a valid yaku. */
  kuitan: boolean;
  /** Riichi declared on the very first uninterrupted turn scores extra. */
  doubleRiichi: boolean;
  /**
   * Renhou (non-dealer ron on the first uninterrupted go-around
   * before drawing any tile). When `true`, scored as a yakuman in
   * the same slot as tenhou/chiihou. Tenhou-default is `false`
   * (Tenhou itself does not award renhou).
   */
  renhou: boolean;
  /** Ippatsu yaku is awarded when applicable. */
  ippatsu: boolean;
  /** Reveal ura-dora to riichi winners. */
  uraDora: boolean;
  /** Reveal a new dora indicator after every kan. */
  kanDora: boolean;
  /**
   * Award nagashi mangan at exhaustive draw to any seat whose
   * discards are all terminals/honors and were never called.
   * Pays as a tsumo-mangan (stacks with regular tenpai payments).
   */
  nagashiMangan: boolean;
  /** Per-flavor abortive-draw toggles. */
  aborts: {
    /** Player-declared 9-terminal abort on the opening hand. */
    kyuushuu: boolean;
    /** Auto: 4 identical wind first-discards with no calls. */
    suufonRenda: boolean;
    /** Auto: 4 successful riichi declarations. */
    suuchaRiichi: boolean;
    /** Auto: triple ron on the same discard aborts the hand. */
    sanchahou: boolean;
  };
}

/** Tenhou-default rule set: hanchan, all common aborts, ippatsu/ura on. */
export const DEFAULT_RULE_SET: RuleSet = {
  roundWindCount: 2,
  roundLimit: 4,
  startingScore: 25000,
  redFivesPerSuit: 1,
  kuitan: true,
  doubleRiichi: true,
  renhou: false,
  ippatsu: true,
  uraDora: true,
  kanDora: true,
  nagashiMangan: true,
  aborts: {
    kyuushuu: true,
    suufonRenda: true,
    suuchaRiichi: true,
    sanchahou: true,
  },
};

/** Tonpuusen preset (East round only, otherwise Tenhou-default). */
export const TONPUU_RULE_SET: RuleSet = {
  ...DEFAULT_RULE_SET,
  roundWindCount: 1,
};

/** Resolve a partial override into a complete `RuleSet`. */
export function resolveRuleSet(partial?: RuleSetOverride): RuleSet {
  if (!partial) {
    return { ...DEFAULT_RULE_SET, aborts: { ...DEFAULT_RULE_SET.aborts } };
  }
  return {
    ...DEFAULT_RULE_SET,
    ...partial,
    aborts: {
      ...DEFAULT_RULE_SET.aborts,
      ...(partial.aborts ?? {}),
    },
  } as RuleSet;
}

/** Deep-partial-style override accepted by `resolveRuleSet`. */
export type RuleSetOverride = DeepPartial<RuleSet>;

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};
