import { describe, expect, it } from "vitest";
import {
  riichiLibYakuToRomaji,
  tenhouYakuIdToLegacyHan,
  tenhouYakuIdToRomaji,
} from "./yakuNames";

describe("riichiLibYakuToRomaji", () => {
  it("normalizes scorer yaku without changing values or order", () => {
    const normalized = riichiLibYakuToRomaji({
      立直: "1飜",
      一発: "1飜",
      平和: "1飜",
      断么九: "1飜",
      ドラ: "2飜",
      赤ドラ: "1飜",
      裏ドラ: "1飜",
    });

    expect(normalized).toEqual({
      Riichi: "1飜",
      Ippatsu: "1飜",
      Pinfu: "1飜",
      Tanyao: "1飜",
      Dora: "2飜",
      "Aka Dora": "1飜",
      "Ura Dora": "1飜",
    });
    expect(Object.keys(normalized)).toEqual([
      "Riichi",
      "Ippatsu",
      "Pinfu",
      "Tanyao",
      "Dora",
      "Aka Dora",
      "Ura Dora",
    ]);
  });

  it("collapses wind and dragon variants to canonical names", () => {
    expect(
      riichiLibYakuToRomaji({
        場風東: "1飜",
        自風南: "1飜",
        役牌白: "1飜",
        役牌発: "1飜",
        役牌中: "1飜",
      })
    ).toEqual({
      Bakaze: "1飜",
      Jikaze: "1飜",
      Haku: "1飜",
      Hatsu: "1飜",
      Chun: "1飜",
    });
  });

  it("normalizes yakuman and preserves unknown names", () => {
    expect(
      riichiLibYakuToRomaji({
        大三元: "役満",
        四暗刻単騎待ち: "役満",
        "Custom Yaku": "5飜",
      })
    ).toEqual({
      Daisangen: "役満",
      "Suuankou Tanki": "役満",
      "Custom Yaku": "5飜",
    });
  });

  it("preserves Tenhou display names and legacy statistics ids", () => {
    expect(tenhouYakuIdToRomaji(1)).toBe("Riichi");
    expect(tenhouYakuIdToLegacyHan(1)).toBe(2);
    expect(tenhouYakuIdToRomaji(38)).toBe("Daisangen");
    expect(tenhouYakuIdToLegacyHan(38)).toBe(37);
    expect(tenhouYakuIdToRomaji(999)).toBeUndefined();
    expect(tenhouYakuIdToLegacyHan(999)).toBeUndefined();
  });
});