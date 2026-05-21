/**
 * Tests for `scoreHand()` — the riichi-package wrapper.
 *
 * Each case expresses a 13-tile hand + win tile + context flags,
 * and asserts the han / fu / ten / yaku reported by our wrapper.
 *
 * Phase 1 step 4 scope: closed-hand wins only. Hands with calls
 * (chi / pon / kan) are intentionally absent and will be added
 * alongside engine support for them.
 */

import { describe, expect, it } from "vitest";
import type { Tile } from "./types";
import { buildRiichiInput, indicatorToDora, scoreHand } from "./score";

/** Parse a tenhou-style shorthand `123m45p1z` into individual tiles. */
function tiles(s: string): Tile[] {
  const out: Tile[] = [];
  let digits = "";
  for (const ch of s) {
    if (ch >= "0" && ch <= "9") {
      digits += ch;
    } else {
      for (const d of digits) {
        out.push(`${d}${ch}`);
      }
      digits = "";
    }
  }
  return out;
}

describe("indicatorToDora", () => {
  it("rolls suited 1..9", () => {
    expect(indicatorToDora("1m")).toBe("2m");
    expect(indicatorToDora("8p")).toBe("9p");
    expect(indicatorToDora("9s")).toBe("1s");
  });

  it("treats red five as 5", () => {
    expect(indicatorToDora("0m")).toBe("6m");
  });

  it("cycles winds E→S→W→N→E", () => {
    expect(indicatorToDora("1z")).toBe("2z");
    expect(indicatorToDora("4z")).toBe("1z");
  });

  it("cycles dragons haku→hatsu→chun→haku", () => {
    expect(indicatorToDora("5z")).toBe("6z");
    expect(indicatorToDora("7z")).toBe("5z");
  });
});

describe("buildRiichiInput", () => {
  it("groups by suit and appends tsumo win tile", () => {
    const s = buildRiichiInput({
      hand: tiles("234m234p234s55z11z"), // 13 tiles
      winTile: "5z",
      tsumo: true,
    });
    expect(s).toBe("234m234p234s11555z");
  });

  it("uses + for ron win tile", () => {
    const s = buildRiichiInput({
      hand: tiles("234m234p234s55z11z"),
      winTile: "5z",
      tsumo: false,
    });
    expect(s).toBe("234m234p234s1155z+5z");
  });

  it("encodes flags + dora (indicators converted to dora)", () => {
    const s = buildRiichiInput({
      hand: tiles("123m456p234s55z11z"),
      winTile: "1z",
      tsumo: true,
      riichi: true,
      ippatsu: true,
      doraIndicators: ["2p"], // → dora 3p
    });
    expect(s).toBe("123m456p234s11551z+ri+d3p");
  });

  it("emits non-default winds and skips defaults", () => {
    expect(
      buildRiichiInput({
        hand: tiles("234m234p234s222z1z"),
        winTile: "1z",
        tsumo: false,
        roundWind: "S",
        seatWind: "S",
      })
    ).toMatch(/\+22$/);
  });

  it("rejects non-13-tile hands", () => {
    expect(() =>
      buildRiichiInput({
        hand: tiles("12m"),
        winTile: "3m",
        tsumo: true,
      })
    ).toThrow(/13 concealed tiles/);
  });
});

describe("scoreHand — closed-hand wins", () => {
  it("scores a chiitoitsu riichi tsumo (non-dealer)", () => {
    const r = scoreHand({
      hand: tiles("11m22p33s44m55p66s7z"),
      winTile: "7z",
      tsumo: true,
      riichi: true,
    });
    expect(r.isAgari).toBe(true);
    expect(r.han).toBe(4);
    expect(r.fu).toBe(25);
    expect(r.ten).toBe(6400);
    expect(r.yaku).toMatchObject({ 七対子: "2飜", 立直: "1飜" });
    expect(r.isYakuman).toBe(false);
  });

  it("scores sanshoku doujun + yakuhai haku ron (non-dealer)", () => {
    const r = scoreHand({
      hand: tiles("234m234p234s555z1s"),
      winTile: "1s",
      tsumo: false,
    });
    expect(r.isAgari).toBe(true);
    expect(r.han).toBe(3);
    expect(r.fu).toBe(40);
    expect(r.ten).toBe(5200);
    expect(r.yaku).toMatchObject({ 三色同順: "2飜", 役牌白: "1飜" });
  });

  it("scores kokushi musou 13-way wait as double yakuman (non-dealer)", () => {
    const r = scoreHand({
      hand: tiles("19m19p19s1234567z"),
      winTile: "1z",
      tsumo: true,
    });
    expect(r.isAgari).toBe(true);
    expect(r.isYakuman).toBe(true);
    expect(r.yakumanCount).toBe(2);
    expect(r.ten).toBe(64000);
    expect(r.yaku).toMatchObject({ 国士無双十三面待ち: "ダブル役満" });
  });

  it("scores sanshoku + pinfu + riichi + ippatsu + tsumo (haneman)", () => {
    const r = scoreHand({
      hand: tiles("234m234p11s23445s"),
      winTile: "6s",
      tsumo: true,
      riichi: true,
      ippatsu: true,
    });
    expect(r.isAgari).toBe(true);
    // sanshoku(2) + pinfu(1) + tsumo(1) + riichi(1) + ippatsu(1) = 6 han.
    expect(r.han).toBe(6);
    expect(r.fu).toBe(20);
    expect(r.ten).toBe(12000);
    expect(r.yaku).toMatchObject({
      三色同順: "2飜",
      平和: "1飜",
      門前清自摸和: "1飜",
      立直: "1飜",
      一発: "1飜",
    });
  });

  it("counts dora from indicator (indicator 1m → dora 2m)", () => {
    // Same hand as above but with a dora indicator that hits the
    // hand (one 2m present in 234m). Expect +1 han over baseline.
    const r = scoreHand({
      hand: tiles("234m234p11s23445s"),
      winTile: "6s",
      tsumo: true,
      riichi: true,
      ippatsu: true,
      doraIndicators: ["1m"],
    });
    expect(r.han).toBe(7);
    expect(r.yaku).toMatchObject({ ドラ: "1飜" });
  });

  it("respects roundWind / seatWind for double yakuhai (south-south)", () => {
    const r = scoreHand({
      hand: tiles("234m234p234s222z1z"),
      winTile: "1z",
      tsumo: true,
      roundWind: "S",
      seatWind: "S",
    });
    expect(r.isAgari).toBe(true);
    // sanshoku(2) + tsumo(1) + south-round(1) + south-seat(1) = 5 han.
    expect(r.han).toBe(5);
    expect(r.yaku).toMatchObject({
      三色同順: "2飜",
      自風南: "1飜",
      場風南: "1飜",
    });
  });

  it("returns isAgari=false for non-winning shapes", () => {
    const r = scoreHand({
      hand: tiles("123m456p789s11s2z3z"), // 13 tiles, no path to a win
      winTile: "4z",
      tsumo: false,
    });
    expect(r.isAgari).toBe(false);
    expect(r.han).toBe(0);
    expect(r.ten).toBe(0);
  });

  it("scoreCap clamps a 6-han haneman down to mangan (non-dealer tsumo)", () => {
    // Same haneman tsumo as above; cap drops ten 12000 → 8000.
    const r = scoreHand({
      hand: tiles("234m234p11s23445s"),
      winTile: "6s",
      tsumo: true,
      riichi: true,
      ippatsu: true,
      scoreCap: "mangan",
    });
    expect(r.isAgari).toBe(true);
    expect(r.han).toBe(6); // han / yaku unchanged
    expect(r.ten).toBe(8000); // mangan, non-dealer tsumo
    expect(r.oya).toEqual([4000, 4000, 4000]);
    expect(r.ko).toEqual([4000, 2000, 2000]);
  });

  it("scoreCap clamps a double-yakuman down to mangan (dealer tsumo)", () => {
    // 13-way kokushi: lib reports 64000; cap drops to dealer
    // mangan (12000 total = 4000 × 3).
    const r = scoreHand({
      hand: tiles("19m19p19s1234567z"),
      winTile: "1z",
      tsumo: true,
      seatWind: "E",
      scoreCap: "mangan",
    });
    expect(r.isAgari).toBe(true);
    expect(r.isYakuman).toBe(true); // yakuman flag stays
    expect(r.ten).toBe(12000);
    expect(r.oya).toEqual([4000, 4000, 4000]);
  });

  it("scoreCap leaves sub-cap hands untouched", () => {
    const r = scoreHand({
      hand: tiles("234m234p234s222z1z"),
      winTile: "1z",
      tsumo: true,
      roundWind: "S",
      seatWind: "S",
      scoreCap: "mangan",
    });
    // 5 han non-dealer tsumo → already mangan (8000); cap is a no-op.
    expect(r.ten).toBe(8000);
  });
});

describe("riichi-lib penchan fu patch", () => {
  // The riichi npm package (v1.2.0) miscomputes fu for penchan
  // completions on either edge: the wait-fu branch compares chii
  // edge tiles to a boolean instead of the win tile. We patch
  // `calcFu` at module load — these tests pin the corrected
  // behaviour for both edges.

  it("upper-edge penchan ron (789p won on 7p) gets +2 fu", () => {
    // Hand: 234p 4p5p6p 8p9p + 1m2m3m + 5m5m, riichi, ron 7p.
    // Decomposition: 123m, 5m5m pair, 234p, 456p, 789p (penchan).
    // Expected: 20 base + 10 menzen ron + 2 penchan = 32 → 40 fu,
    // 1 han (riichi), dealer ron = 2000 points.
    const r = scoreHand({
      hand: tiles("12355m23445689p"),
      winTile: "7p",
      tsumo: false,
      riichi: true,
      roundWind: "E",
      seatWind: "E",
    });
    expect(r.isAgari).toBe(true);
    expect(r.han).toBe(1);
    expect(r.fu).toBe(40);
    expect(r.ten).toBe(2000);
  });

  it("lower-edge penchan ron (123m won on 3m) gets +2 fu", () => {
    // Hand: 1m2m + 4m5m6m + 234p + 567p + 99s, riichi, ron 3m.
    // Decomposition: 123m (penchan), 456m, 234p, 567p, 99s pair.
    // Expected: 20 + 10 menzen ron + 2 penchan = 32 → 40 fu.
    const r = scoreHand({
      hand: tiles("12456m234567p99s"),
      winTile: "3m",
      tsumo: false,
      riichi: true,
      roundWind: "E",
      seatWind: "S",
    });
    expect(r.isAgari).toBe(true);
    expect(r.han).toBe(1);
    expect(r.fu).toBe(40);
  });
});

describe("no-yaku rejection (engine gate)", () => {
  // The riichi lib reports `isAgari: true, han: 0, yaku: {}` for a
  // winning shape with no scoring yaku (dora alone never qualifies).
  // The engine's tsumo/ron handlers must reject these — pinned here
  // at the score level so the contract is explicit.

  it("open tsumo with only dora has han=0 and empty yaku", () => {
    const r = scoreHand({
      hand: tiles("99m23478p567s"),
      winTile: "6p",
      tsumo: true,
      roundWind: "E",
      seatWind: "S",
      doraIndicators: ["8m"], // makes 9m dora; 99m = 2 dora
      melds: [
        {
          type: "chi",
          tiles: ["1m", "2m", "3m"],
          claimedTile: "1m",
          from: 3,
        },
      ],
    });
    expect(r.isAgari).toBe(true);
    expect(r.han).toBe(0);
    expect(r.yakumanCount).toBe(0);
    expect(Object.keys(r.yaku)).toHaveLength(0);
  });
});
