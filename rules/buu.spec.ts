/**
 * Buu Mahjong — unit tests for `buu.ts` (chip distribution,
 * sinking detection, yakuman immediate-sankoro, dabuken, and the
 * three victory-legality rules) plus the buu-east preset.
 *
 * These tests pin the pure helpers in `buu.ts` and the preset
 * shape. End-to-end win-path tests through `step()` belong with
 * the existing step.* specs and are not duplicated here.
 */

import { describe, expect, it } from "vitest";
import { createInitialState, type MatchState } from "./state";
import { resolveRuleSet } from "./ruleSet";
import {
  evaluateBuuHandEnd,
  checkBuuVictoryLegality,
  evaluateBuuEndOfGameChips,
} from "./buu";
import { getPreset, presetToRuleSet } from "./presets";
import type { Seat } from "./types";

function buuState(
  scores: [number, number, number, number],
  dabuken: [boolean, boolean, boolean, boolean] = [false, false, false, false]
): MatchState {
  const s = createInitialState(1, { ruleSet: { buuMode: true } });
  return {
    ...s,
    // Re-resolve from the buu-east preset so every chip-related
    // field is populated to its Buu values (5/3/1, sink-threshold
    // 5999 = strictly below starting score, etc.).
    ruleSet: presetToRuleSet(getPreset("buu-east")),
    scores,
    dabuken,
  };
}

describe("buu-east preset", () => {
  it("loads with the expected Buu-defining shape", () => {
    const rs = presetToRuleSet(getPreset("buu-east"));
    expect(rs.buuMode).toBe(true);
    expect(rs.startingScore).toBe(6000);
    expect(rs.roundWindCount).toBe(1);
    expect(rs.roundLimit).toBe(4);
    expect(rs.nbRedFivePinzu).toBe(2);
    expect(rs.nbRedFiveManzu).toBe(0);
    expect(rs.nbRedFiveSouzu).toBe(0);
    expect(rs.ippatsu).toBe(false);
    expect(rs.uraDora).toBe(false);
    expect(rs.kanDora).toBe(false);
    expect(rs.atamahane).toBe(true);
    expect(rs.bustedScore).toBe(0);
    expect(rs.winnerThreshold).toBe(12000);
    expect(rs.riichiBetValue).toBe(100);
    expect(rs.honbaPayments).toBe(false);
    expect(rs.tenpaiPayments).toBe(false);
    expect(rs.tenpaiRenchan).toBe(false);
    expect(rs.kiriageMangan).toBe(true);
    expect(rs.chipPayouts).toEqual({ sankoro: 5, nikoro: 3, chinmai: 1 });
    expect(rs.immediateSankoroOnYakuman).toBe(true);
    expect(rs.illegalVictoryRules).toEqual({
      sinkingWinNotFloating: true,
      gameEndingWinNotFirst: true,
      gameEndingChinmai: true,
    });
    expect(rs.illegalVictoryAllLastOff).toBe(true);
    expect(rs.chipChomboPenalty).toBe(2);
  });
});

describe("evaluateBuuHandEnd", () => {
  it("no-op when buuMode is off", () => {
    const s = createInitialState(1);
    const out = evaluateBuuHandEnd(s, 0, false);
    expect(out.chipDelta).toEqual([0, 0, 0, 0]);
    expect(out.sinkingCount).toBe(0);
    expect(out.awardedDabuken).toBe(false);
    expect(out.consumedDabuken).toBe(false);
  });

  it("chinmai: one sinker pays 1 chip to winner", () => {
    // Sinking = score < starting (6000). Winner (seat 0) at 7000 is
    // not sinking; only seat 1 (5000) drops below 6000.
    const s = buuState([7000, 5000, 7000, 7000]);
    const out = evaluateBuuHandEnd(s, 0 as Seat, false);
    expect(out.sinkingCount).toBe(1);
    expect(out.chipDelta).toEqual([1, -1, 0, 0]);
    expect(out.awardedDabuken).toBe(false);
  });

  it("nikoro: two sinkers pay 3 chips each to winner", () => {
    const s = buuState([7000, 5000, 4000, 7000]); // seats 1 & 2 sinking
    const out = evaluateBuuHandEnd(s, 0 as Seat, false);
    expect(out.sinkingCount).toBe(2);
    expect(out.chipDelta).toEqual([6, -3, -3, 0]);
  });

  it("sankoro: three sinkers pay 5 chips each to winner", () => {
    const s = buuState([7000, 5000, 4000, 3000]); // 1, 2, 3 sinking
    const out = evaluateBuuHandEnd(s, 0 as Seat, false);
    expect(out.sinkingCount).toBe(3);
    expect(out.chipDelta).toEqual([15, -5, -5, -5]);
  });

  it("yakuman forces sankoro regardless of actual scores", () => {
    const s = buuState([7000, 7000, 7000, 7000]); // nobody sinking
    const out = evaluateBuuHandEnd(s, 0 as Seat, true);
    expect(out.sinkingCount).toBe(3);
    expect(out.chipDelta).toEqual([15, -5, -5, -5]);
    expect(out.awardedDabuken).toBe(true);
  });

  it("dabuken doubles chip income on the next sankoro", () => {
    const s = buuState([7000, 5000, 4000, 3000], [true, false, false, false]);
    const out = evaluateBuuHandEnd(s, 0 as Seat, false);
    expect(out.consumedDabuken).toBe(true);
    expect(out.chipDelta).toEqual([30, -10, -10, -10]);
  });

  it("winner excluded from sinking count even when sinking themselves", () => {
    // Winner (seat 0) at 0 is sinking but is excluded; seats 1 & 2
    // are below starting (sinking); seat 3 at 7000 floats.
    const s = buuState([0, 5000, 4000, 7000]);
    const out = evaluateBuuHandEnd(s, 0 as Seat, false);
    expect(out.sinkingCount).toBe(2);
    expect(out.chipDelta).toEqual([6, -3, -3, 0]);
  });

  it("every legal win wipes all dabuken before any new award", () => {
    // Non-sankoro win: clear everyone, award nobody. Winner seat 0
    // floats (7000); seats 1 & 2 sink → nikoro.
    const nikoro = evaluateBuuHandEnd(
      buuState([7000, 5000, 4000, 7000], [true, false, false, false]),
      0 as Seat,
      false
    );
    expect(nikoro.clearAllDabuken).toBe(true);
    expect(nikoro.awardedDabuken).toBe(false);

    // Sankoro by seat B (seat 2) with stale dabuken on seat A
    // (seat 0): wipe must still fire so seat A loses its token,
    // and the award then re-grants it to seat 2 only.
    const sankoro = evaluateBuuHandEnd(
      buuState([5000, 4000, 7000, 3000], [true, false, false, false]),
      2 as Seat,
      false
    );
    expect(sankoro.sinkingCount).toBe(3);
    expect(sankoro.clearAllDabuken).toBe(true);
    expect(sankoro.awardedDabuken).toBe(true);
    // Seat 0 wasn't the winner, so its dabuken wasn't consumed
    // (no doubling) — the wipe handled by the caller still drops it.
    expect(sankoro.consumedDabuken).toBe(false);
  });
});

describe("evaluateBuuEndOfGameChips", () => {
  it("no-op when buuMode is off", () => {
    const s = createInitialState(1);
    const out = evaluateBuuEndOfGameChips(s);
    expect(out.chipDelta).toEqual([0, 0, 0, 0]);
    expect(out.perSinker).toBe(0);
    expect(out.sinkingSeats).toEqual([]);
  });

  it("no transfer when no non-winner sinks", () => {
    const out = evaluateBuuEndOfGameChips(buuState([8000, 6000, 6000, 6000]));
    expect(out.winner).toBe(0);
    expect(out.sinkingSeats).toEqual([]);
    expect(out.chipDelta).toEqual([0, 0, 0, 0]);
  });

  it("chinmai: one non-winner sinks → 1 chip from sinker to winner", () => {
    // Winner seat 0 (8000), one sinker seat 3 (5000 < 6000).
    const out = evaluateBuuEndOfGameChips(buuState([8000, 6000, 6000, 5000]));
    expect(out.winner).toBe(0);
    expect(out.sinkingSeats).toEqual([3]);
    expect(out.perSinker).toBe(1);
    expect(out.chipDelta).toEqual([1, 0, 0, -1]);
  });

  it("nikoro: two non-winners sink → 3 chips each to winner", () => {
    const out = evaluateBuuEndOfGameChips(buuState([10000, 6000, 4000, 4000]));
    expect(out.winner).toBe(0);
    expect(out.sinkingSeats).toEqual([2, 3]);
    expect(out.perSinker).toBe(3);
    expect(out.chipDelta).toEqual([6, 0, -3, -3]);
  });

  it("sankoro: all three non-winners sink → 5 chips each to winner", () => {
    const out = evaluateBuuEndOfGameChips(buuState([3000, 15000, 3000, 3000]));
    expect(out.winner).toBe(1);
    expect(out.sinkingSeats).toEqual([0, 2, 3]);
    expect(out.perSinker).toBe(5);
    expect(out.chipDelta).toEqual([-5, 15, -5, -5]);
  });

  it("ties on highest score broken by lowest seat index (closer to dealer)", () => {
    // Seats 0 and 2 tied at 9000 — winner is seat 0.
    const out = evaluateBuuEndOfGameChips(buuState([9000, 3000, 9000, 3000]));
    expect(out.winner).toBe(0);
    expect(out.sinkingSeats).toEqual([1, 3]);
    expect(out.chipDelta).toEqual([6, -3, 0, -3]);
  });

  it("awards a fresh dabuken to the winner on sankoro (3 sinkers)", () => {
    const out = evaluateBuuEndOfGameChips(buuState([15000, 3000, 3000, 3000]));
    expect(out.winner).toBe(0);
    expect(out.sinkingSeats).toEqual([1, 2, 3]);
    expect(out.awardedDabuken).toBe(true);
    expect(out.consumedDabuken).toBe(false);
    expect(out.perSinker).toBe(5);
  });

  it("does not award a dabuken on chinmai or nikoro", () => {
    const chinmai = evaluateBuuEndOfGameChips(
      buuState([8000, 6000, 6000, 5000])
    );
    expect(chinmai.awardedDabuken).toBe(false);
    const nikoro = evaluateBuuEndOfGameChips(
      buuState([10000, 6000, 4000, 4000])
    );
    expect(nikoro.awardedDabuken).toBe(false);
  });

  it("winner holding a dabuken consumes it and doubles the chip transfer", () => {
    // Seat 0 wins with 1 sinker (seat 3) and already holds a
    // dabuken from the previous game.
    const out = evaluateBuuEndOfGameChips(
      buuState([8000, 6000, 6000, 5000], [true, false, false, false])
    );
    expect(out.consumedDabuken).toBe(true);
    expect(out.perSinker).toBe(2); // chinmai × 2
    expect(out.chipDelta).toEqual([2, 0, 0, -2]);
    // A chinmai consumes but does not re-award.
    expect(out.awardedDabuken).toBe(false);
  });

  it("end-of-game sankoro for a dabuken holder both consumes and re-awards", () => {
    const out = evaluateBuuEndOfGameChips(
      buuState([15000, 3000, 3000, 3000], [true, false, false, false])
    );
    expect(out.consumedDabuken).toBe(true);
    expect(out.awardedDabuken).toBe(true);
    expect(out.perSinker).toBe(10); // sankoro × 2
    expect(out.chipDelta).toEqual([30, -10, -10, -10]);
  });

  it("does not consume a dabuken when no chips would move", () => {
    // Winner holds a dabuken but no non-winner sinks — token
    // is wiped by the caller but `consumedDabuken` stays false
    // (it only flips when the doubling actually applies).
    const out = evaluateBuuEndOfGameChips(
      buuState([8000, 6000, 6000, 6000], [true, false, false, false])
    );
    expect(out.consumedDabuken).toBe(false);
    expect(out.perSinker).toBe(0);
    expect(out.chipDelta).toEqual([0, 0, 0, 0]);
  });
});

describe("checkBuuVictoryLegality", () => {
  function legalityState(scores: [number, number, number, number]): MatchState {
    return buuState(scores);
  }

  it("no-op when buuMode is off", () => {
    const s = createInitialState(1);
    const r = checkBuuVictoryLegality({
      state: s,
      winner: 0,
      winnerWasSinking: true,
      wouldEndMatch: true,
      isFinalHand: false,
    });
    expect(r.legal).toBe(true);
  });

  it("all rules suspended on the final hand by default", () => {
    const s = legalityState([-100, -200, -300, 12000]);
    const r = checkBuuVictoryLegality({
      state: s,
      winner: 3,
      winnerWasSinking: false,
      wouldEndMatch: true,
      isFinalHand: true,
    });
    expect(r.legal).toBe(true);
  });

  it("flags sinking-win that keeps winner sunk while another stays sunk", () => {
    // Winner (seat 0) is still sinking (<6000) after the win, and
    // seat 1 is also sinking.
    const s = legalityState([-50, -200, 4000, 4000]);
    const r = checkBuuVictoryLegality({
      state: s,
      winner: 0,
      winnerWasSinking: true,
      wouldEndMatch: false,
      isFinalHand: false,
    });
    expect(r.legal).toBe(false);
    expect(r.reason).toBe("sinking_win_not_floating");
  });

  it("allows sinking winner if they float themselves out", () => {
    // Winner was sinking pre-win, now at 7000 (above starting).
    const s = legalityState([7000, -100, 4000, 4000]);
    const r = checkBuuVictoryLegality({
      state: s,
      winner: 0,
      winnerWasSinking: true,
      wouldEndMatch: false,
      isFinalHand: false,
    });
    expect(r.legal).toBe(true);
  });

  it("flags game-ending win where winner is not first place", () => {
    // Match ending, but seat 1 is ahead of winner (seat 0).
    const s = legalityState([10000, 13000, 0, -100]);
    const r = checkBuuVictoryLegality({
      state: s,
      winner: 0,
      winnerWasSinking: false,
      wouldEndMatch: true,
      isFinalHand: false,
    });
    expect(r.legal).toBe(false);
    expect(r.reason).toBe("game_ending_win_not_first");
  });

  it("flags game-ending chinmai (only one sinker)", () => {
    // Only seat 3 (-100) is sinking; seats 1 & 2 at 7000 float.
    const s = legalityState([13000, 7000, 7000, -100]);
    const r = checkBuuVictoryLegality({
      state: s,
      winner: 0,
      winnerWasSinking: false,
      wouldEndMatch: true,
      isFinalHand: false,
    });
    expect(r.legal).toBe(false);
    expect(r.reason).toBe("game_ending_chinmai");
  });

  it("allows game-ending sankoro / nikoro wins", () => {
    const s = legalityState([13000, -100, -200, -300]);
    const r = checkBuuVictoryLegality({
      state: s,
      winner: 0,
      winnerWasSinking: false,
      wouldEndMatch: true,
      isFinalHand: false,
    });
    expect(r.legal).toBe(true);
  });
});

describe("resolveRuleSet — Buu override merging", () => {
  it("partial override of nested chipPayouts preserves untouched keys", () => {
    const rs = resolveRuleSet({
      buuMode: true,
      chipPayouts: { sankoro: 10 },
    });
    expect(rs.chipPayouts.sankoro).toBe(10);
    // nikoro / chinmai fall back to the default-preset values (0).
    expect(rs.chipPayouts.nikoro).toBe(0);
    expect(rs.chipPayouts.chinmai).toBe(0);
  });

  it("partial override of illegalVictoryRules merges per key", () => {
    const rs = resolveRuleSet({
      illegalVictoryRules: { gameEndingChinmai: true },
    });
    expect(rs.illegalVictoryRules.gameEndingChinmai).toBe(true);
    expect(rs.illegalVictoryRules.sinkingWinNotFloating).toBe(false);
    expect(rs.illegalVictoryRules.gameEndingWinNotFirst).toBe(false);
  });
});
