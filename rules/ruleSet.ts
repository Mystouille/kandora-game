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
   * Atamahane (head-bump): when `true`, only the seat closest
   * counter-clockwise from the discarder may ron on a given
   * discard — competing downstream rons are dropped (no
   * double / triple ron). When `false` (default), every legal
   * ron candidate wins simultaneously (multi-ron) and triple
   * ron is governed by `aborts.sanchahou`.
   */
  atamahane: boolean;
  /**
   * Match ends immediately at hand-end if any seat's score is at or
   * below this threshold ("tobi" / bankruptcy). `null` disables the
   * check. Tenhou-default is `0` (any seat ≤ 0 → match ends).
   */
  bustedScore: number | null;
  /**
   * When `true`, the bust check is strict: a seat busts only when
   * its score is *strictly* below `bustedScore` (`score <
   * bustedScore`). When `false` (default), the check is inclusive
   * (`score <= bustedScore`), matching Tenhou-on-zero house rules
   * and Buu Mahjong (where exactly 0 is "sinking").
   *
   * Most ranked Japanese variants run strict-below (a seat at
   * exactly 0 keeps playing); set this `true` for those.
   */
  bustedStrict: boolean;
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
   * Master toggle for Buu Mahjong mechanics. When `true`, the
   * engine reads the additional Buu-specific fields below
   * (chip ledger, sinking, sankoro/nikoro/chinmai payouts,
   * winnerThreshold float-win, immediate-sankoro-on-yakuman,
   * illegal-victory chombos). When `false`, every Buu field is
   * ignored regardless of value and the engine is behaviorally
   * identical to before these fields existed.
   */
  buuMode: boolean;
  /**
   * Point value of a single riichi stick. Standard riichi: 1000.
   * Buu: 100. Affects both the at-declaration deduction and the
   * winner pickup at hand-end (`riichiSticks * riichiBetValue`).
   */
  riichiBetValue: number;
  /**
   * When `false`, the 300/100-per-honba bonus at win-end is
   * skipped (Buu has no repeat counters). The honba counter
   * itself still ticks internally so each re-deal gets a
   * distinct seed.
   */
  honbaPayments: boolean;
  /**
   * When `false`, the 3000-point tenpai/noten split at exhaustive
   * draw is skipped (Buu has no tenpai payments).
   */
  tenpaiPayments: boolean;
  /**
   * When `false`, dealer-tenpai at exhaustive draw does NOT keep
   * the dealer (Buu disables tenpai renchan; honba still ticks).
   * When `true` (default), the standard rule applies.
   */
  tenpaiRenchan: boolean;
  /**
   * When `true`, a 4-han 30-fu win is rounded up to mangan
   * (kiriage mangan). Currently a recognized flag only — the
   * scoring lib reports the un-rounded result and the post-hoc
   * promotion lands alongside the chip system.
   */
  kiriageMangan: boolean;
  /**
   * Hard score-tier ceiling. When set, any hand whose computed
   * payment exceeds the named tier is clamped to that tier’s
   * fixed payout (mangan = 8000 non-dealer / 12000 dealer,
   * etc.) — yakuman included. `null` means no cap (the riichi
   * lib’s natural haneman/baiman/sanbaiman/yakuman tiers apply).
   * Buu Mahjong: `"mangan"`.
   */
  scoreCap: "mangan" | "haneman" | "baiman" | "sanbaiman" | null;
  /**
   * Chip payouts per sinking-player count at hand-end. Only
   * consulted when `buuMode` is on.
   *   - chinmai (1 sinker):  each sinker pays `chinmai` chips.
   *   - nikoro  (2 sinkers): each sinker pays `nikoro` chips.
   *   - sankoro (3 sinkers): each sinker pays `sankoro` chips.
   */
  chipPayouts: {
    sankoro: number;
    nikoro: number;
    chinmai: number;
  };
  /**
   * A seat is "sinking" when `score <= sinkThreshold` at hand-end.
   * For Buu Mahjong the configured value is `startingScore - 1`
   * (i.e. strictly below the starting score), so per-hand sankoro/
   * nikoro/chinmai payouts are triggered against any non-winner who
   * has dipped below their initial 6000. Distinct from `bustedScore`
   * (“busted-out” at <=0), which terminates the match entirely.
   * Used for chip distribution and the illegal-victory rules.
   */
  sinkThreshold: number;
  /**
   * Match ends at hand-end if any seat's score reaches at least
   * this value ("floating to victory"). `null` disables the
   * check. Buu: 12000.
   */
  winnerThreshold: number | null;
  /**
   * When `true`, a yakuman win immediately distributes chips as
   * if all three non-winners were sinking (sankoro), regardless
   * of actual scores, AND awards a dabuken token to the winner
   * (consumed by the next sankoro of that seat). Buu: `true`.
   */
  immediateSankoroOnYakuman: boolean;
  /**
   * Three Buu-specific "you cannot win this way" rules. When
   * violated they incur a chombo (delta reverted, chip penalty
   * applied). All three are gated by `illegalVictoryAllLastOff`
   * during the final hand.
   *
   *   - sinkingWinNotFloating: a sinking seat winning a hand that
   *     would sink another player without lifting the winner
   *     itself out of sinking.
   *   - gameEndingWinNotFirst: winning a hand that would end the
   *     match without making the winner the first-place seat.
   *   - gameEndingChinmai: winning a hand that would end the
   *     match with only one player sinking.
   */
  illegalVictoryRules: {
    sinkingWinNotFloating: boolean;
    gameEndingWinNotFirst: boolean;
    gameEndingChinmai: boolean;
  };
  /**
   * When `true`, the three `illegalVictoryRules` are suspended
   * during the final hand of the match ("all last"). Buu: `true`.
   */
  illegalVictoryAllLastOff: boolean;
  /**
   * Chip penalty applied to a chombo'd seat (paid to every other
   * seat). `null` disables chip-based chombo penalty. Buu: 2.
   */
  chipChomboPenalty: number | null;
  /**
   * Per-seat chip count at the start of a match. Buu: 30; the
   * non-Buu presets keep this at 0 since chips are unused
   * there. Only consulted when initialising `MatchState.chips`
   * in `createInitialState`.
   */
  startingChips: number;
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
    return {
      ...DEFAULT_RULE_SET,
      aborts: { ...DEFAULT_RULE_SET.aborts },
      chipPayouts: { ...DEFAULT_RULE_SET.chipPayouts },
      illegalVictoryRules: { ...DEFAULT_RULE_SET.illegalVictoryRules },
    };
  }
  return {
    ...DEFAULT_RULE_SET,
    ...partial,
    aborts: {
      ...DEFAULT_RULE_SET.aborts,
      ...(partial.aborts ?? {}),
    },
    chipPayouts: {
      ...DEFAULT_RULE_SET.chipPayouts,
      ...(partial.chipPayouts ?? {}),
    },
    illegalVictoryRules: {
      ...DEFAULT_RULE_SET.illegalVictoryRules,
      ...(partial.illegalVictoryRules ?? {}),
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
