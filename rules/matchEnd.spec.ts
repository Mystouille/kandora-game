/**
 * matchEnd — unit tests for `shouldEndMatch` decision branches.
 *
 * Builds minimal `MatchState` + `HandResult` fixtures and verifies
 * the helper returns the expected `{ ended, reason }` for each
 * RuleSet toggle (busted / agari_yame / tenpai_yame)
 * and the always-on round_limit cutoff.
 */

import { describe, expect, it } from "vitest";
import type { RuleSetOverride } from "./ruleSet";
import { createInitialState, type HandResult, type MatchState } from "./state";
import { shouldEndMatch } from "./matchEnd";

function makeState(overrides: RuleSetOverride = {}): MatchState {
  return createInitialState(1, { ruleSet: overrides });
}

function setProgress(
  s: MatchState,
  progress: Partial<
    Pick<MatchState, "roundWind" | "roundNumber" | "dealer" | "scores">
  >
): MatchState {
  return { ...s, ...progress };
}

function winResult(
  winner: 0 | 1 | 2 | 3,
  opts: { han: number; isYakuman?: boolean; reason?: "tsumo" | "ron" } = {
    han: 1,
  }
): HandResult {
  return {
    reason: opts.reason ?? "tsumo",
    winner,
    loser: null,
    delta: [0, 0, 0, 0],
    tenpai: null,
    abortKind: null,
    winHan: opts.han,
    winYakuman: opts.isYakuman ?? false,
  };
}

function drawResult(tenpai: [boolean, boolean, boolean, boolean]): HandResult {
  return {
    reason: "exhaustive_draw",
    winner: null,
    loser: null,
    delta: [0, 0, 0, 0],
    tenpai,
    abortKind: null,
    winHan: null,
    winYakuman: null,
  };
}

describe("shouldEndMatch — busted (tobi)", () => {
  it("ends with reason 'busted' when any seat is strictly below bustedScore under default (strict) rules", () => {
    const s = setProgress(makeState(), { scores: [25000, 25000, 25000, -100] });
    const d = shouldEndMatch(s, winResult(0, { han: 1 }), false);
    expect(d.ended).toBe(true);
    expect(d.ended && d.reason).toBe("busted");
  });

  it("does NOT bust on exactly bustedScore under strict mode (Tenhou default)", () => {
    const s = setProgress(makeState(), { scores: [25000, 25000, 25000, 0] });
    const d = shouldEndMatch(s, winResult(0, { han: 1 }), false);
    expect(d.ended).toBe(false);
  });

  it("busts on exactly bustedScore when bustedStrict is off (Buu-style)", () => {
    const s = setProgress(makeState({ bustedStrict: false }), {
      scores: [25000, 25000, 25000, 0],
    });
    const d = shouldEndMatch(s, winResult(0, { han: 1 }), false);
    expect(d.ended).toBe(true);
    expect(d.ended && d.reason).toBe("busted");
  });

  it("disabled when bustedScore is null", () => {
    const s = setProgress(makeState({ bustedScore: null }), {
      scores: [25000, 25000, 25000, -5000],
    });
    const d = shouldEndMatch(s, winResult(0, { han: 1 }), false);
    // No other rule triggers (E1, non-dealer win on first hand → keep playing).
    expect(d.ended).toBe(false);
  });

  it("custom threshold (e.g. 5000) triggers earlier (strict-below: 4999 busts, 5000 doesn't)", () => {
    const s = setProgress(makeState({ bustedScore: 5000 }), {
      scores: [40000, 30000, 25000, 4999],
    });
    const d = shouldEndMatch(s, winResult(0, { han: 1 }), false);
    expect(d.ended).toBe(true);
    expect(d.ended && d.reason).toBe("busted");
  });
});

describe("shouldEndMatch — agari_yame", () => {
  it("triggers when dealer wins final hand of final round and agariYame on", () => {
    const s = setProgress(
      makeState({
        agariYame: true,
        bustedScore: null,
        roundWindCount: 2,
        roundLimit: 4,
      }),
      {
        roundWind: "S",
        roundNumber: 4,
        dealer: 2,
        scores: [25000, 25000, 25000, 25000],
      }
    );
    const d = shouldEndMatch(
      s,
      winResult(2, { han: 1, reason: "tsumo" }),
      true
    );
    expect(d.ended).toBe(true);
    expect(d.ended && d.reason).toBe("agari_yame");
  });

  it("does NOT trigger if agariYame is off", () => {
    const s = setProgress(makeState({ agariYame: false, bustedScore: null }), {
      roundWind: "S",
      roundNumber: 4,
      dealer: 2,
      scores: [25000, 25000, 25000, 25000],
    });
    // Dealer wins => dealerKeeps=true => not round_limit either => stays.
    const d = shouldEndMatch(s, winResult(2, { han: 1 }), true);
    expect(d.ended).toBe(false);
  });

  it("does NOT trigger on non-final hand even if agariYame on", () => {
    const s = setProgress(makeState({ agariYame: true, bustedScore: null }), {
      roundWind: "S",
      roundNumber: 3,
      dealer: 2,
      scores: [25000, 25000, 25000, 25000],
    });
    const d = shouldEndMatch(s, winResult(2, { han: 1 }), true);
    expect(d.ended).toBe(false);
  });
});

describe("shouldEndMatch — tenpai_yame", () => {
  it("triggers on exhaustive draw with dealer tenpai on final hand", () => {
    const s = setProgress(makeState({ tenpaiYame: true, bustedScore: null }), {
      roundWind: "S",
      roundNumber: 4,
      dealer: 2,
      scores: [25000, 25000, 25000, 25000],
    });
    const d = shouldEndMatch(s, drawResult([false, false, true, false]), true);
    expect(d.ended).toBe(true);
    expect(d.ended && d.reason).toBe("tenpai_yame");
  });

  it("does NOT trigger if dealer is noten", () => {
    const s = setProgress(makeState({ tenpaiYame: true, bustedScore: null }), {
      roundWind: "S",
      roundNumber: 4,
      dealer: 2,
      scores: [25000, 25000, 25000, 25000],
    });
    const d = shouldEndMatch(s, drawResult([true, true, false, true]), false);
    // Dealer noten → dealerKeeps=false on final hand → round_limit.
    expect(d.ended).toBe(true);
    expect(d.ended && d.reason).toBe("round_limit");
  });
});

describe("shouldEndMatch — round_limit", () => {
  it("triggers on final hand of final round when dealer does not keep", () => {
    const s = setProgress(makeState({ bustedScore: null }), {
      roundWind: "S",
      roundNumber: 4,
      dealer: 2,
      scores: [25000, 25000, 25000, 25000],
    });
    const d = shouldEndMatch(s, winResult(0, { han: 1 }), false);
    expect(d.ended).toBe(true);
    expect(d.ended && d.reason).toBe("round_limit");
  });

  it("does NOT trigger on final hand if dealer keeps (honba continuation)", () => {
    const s = setProgress(makeState({ bustedScore: null }), {
      roundWind: "S",
      roundNumber: 4,
      dealer: 2,
      scores: [25000, 25000, 25000, 25000],
    });
    const d = shouldEndMatch(s, winResult(2, { han: 1 }), true);
    expect(d.ended).toBe(false);
  });

  it("does NOT trigger on non-final hand", () => {
    const s = setProgress(makeState({ bustedScore: null }), {
      roundWind: "E",
      roundNumber: 3,
      dealer: 2,
      scores: [25000, 25000, 25000, 25000],
    });
    const d = shouldEndMatch(s, winResult(0, { han: 1 }), false);
    expect(d.ended).toBe(false);
  });
});

describe("shouldEndMatch — precedence", () => {
  it("busted beats round_limit", () => {
    const s = setProgress(makeState(), {
      roundWind: "S",
      roundNumber: 4,
      dealer: 2,
      scores: [60000, 40000, 25000, -25000],
    });
    const d = shouldEndMatch(s, winResult(0, { han: 1 }), false);
    expect(d.ended && d.reason).toBe("busted");
  });

  it("busted beats agari_yame", () => {
    const s = setProgress(makeState({ agariYame: true }), {
      roundWind: "S",
      roundNumber: 4,
      dealer: 2,
      scores: [60000, 40000, 25000, -25000],
    });
    const d = shouldEndMatch(s, winResult(2, { han: 1 }), true);
    expect(d.ended && d.reason).toBe("busted");
  });
});
