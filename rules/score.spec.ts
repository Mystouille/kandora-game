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
});
