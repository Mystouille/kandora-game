/**
 * Configurable rules ("RuleSet") for a match.
 *
 * Preset rule-sets live as JSON files in `./presets/` and are loaded
 * via `./presets/index.ts`. The Tenhou-default baseline is
 * `presets/tenhou-hanchan.json`, surfaced here as `DEFAULT_RULE_SET`;
 * everything else is opt-in via a partial override passed to
 * `createInitialState({ ruleSet })`.
 *
 * Toggles only cover behavior the engine actually implements today —
 * additions (e.g. nagashi mangan, agari yame, busted-on-zero) land
 * alongside the features they gate.
 *
 * Wire format: `RuleSet` is structurally JSON-serializable so it
 * round-trips through Mongo / WebSocket without conversion.
 */

import { DEFAULT_PRESET_ID, getPreset, presetToRuleSet } from "./presets";

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
  /** Number of red 5m tiles (0–4; replaces that many "5m" copies). */
  nbRedFiveManzu: number;
  /** Number of red 5p tiles (0–4; replaces that many "5p" copies). */
  nbRedFivePinzu: number;
  /** Number of red 5s tiles (0–4; replaces that many "5s" copies). */
  nbRedFiveSouzu: number;
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
   * When `true`, the new kan-dora indicator for a minkan
   * (daiminkan / shouminkan — the two open kan flavors) is
   * revealed immediately as part of the kan event, so the
   * declarer's rinshan tsumo can already see the new dora.
   * When `false`, the reveal is deferred until the declarer's
   * next discard, so a rinshan tsumo on this very kan does
   * NOT benefit from the new dora (a common house rule).
   *
   * No effect when `kanDora` is `false` (no reveal happens
   * either way).
   */
  instantlyRevealDoraForMinkan: boolean;
  /**
   * When `true`, the new kan-dora indicator for an ankan
   * (closed kan) is revealed immediately as part of the kan
   * event. When `false`, the reveal is deferred until the
   * declarer's next discard.
   *
   * No effect when `kanDora` is `false`.
   */
  instantlyRevealDoraForAnkan: boolean;
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
  /**
   * Match ends immediately at hand-end if any seat's score is at or
   * below this threshold ("tobi" / bankruptcy). `null` disables the
   * check. Tenhou-default is `0` (any seat ≤ 0 → match ends).
   */
  bustedScore: number | null;
  /**
   * Dealer-wins-out: if the dealer wins (tsumo or ron) the final
   * hand of the final round, the match ends instead of advancing.
   * Tenhou-default ranked rooms: `false` (the match plays out).
   */
  agariYame: boolean;
  /**
   * Dealer-tenpai-out: if the dealer is tenpai at the exhaustive
   * draw of the final hand of the final round, the match ends
   * instead of advancing. Tenhou-default: `false`.
   */
  tenpaiYame: boolean;
  /**
   * Match ends immediately at hand-end on any win of mangan-or-
   * better (5+ han or any yakuman). Off by default; used by Buu
   * variants and some house rules.
   */
  manganEnds: boolean;
}

/**
 * Tenhou-default rule set, loaded from `presets/tenhou-hanchan.json`.
 * Edit the JSON to change the baseline — no TS recompile needed.
 */
export const DEFAULT_RULE_SET: RuleSet = presetToRuleSet(
  getPreset(DEFAULT_PRESET_ID)
);

/** Tonpuusen preset, loaded from `presets/tenhou-tonpuusen.json`. */
export const TONPUU_RULE_SET: RuleSet = presetToRuleSet(
  getPreset("tenhou-tonpuusen")
);

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

/**
 * True when the rule set disables red-five aka dora across every
 * numbered suit. Used as the `noAka` flag for the riichi scoring
 * library, which only exposes a global aka toggle.
 */
export function isAkaDisabled(rs: RuleSet): boolean {
  return (
    rs.nbRedFiveManzu === 0 &&
    rs.nbRedFivePinzu === 0 &&
    rs.nbRedFiveSouzu === 0
  );
}
