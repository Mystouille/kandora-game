import { describe, expect, it } from "vitest";
import { sortYakuNames, sortYakuRecord } from "./yakuOrder";

describe("yakuOrder", () => {
  it("puts Nuki Dora and its aliases after all other bonuses", () => {
    const names = [
      "Nuki Dora",
      "Dora",
      "抜きドラ",
      "Tsumo",
      "Aka Dora",
      "Kita",
      "Ura Dora",
    ];
    expect(sortYakuNames(names)).toEqual([
      "Tsumo",
      "Dora",
      "Aka Dora",
      "Ura Dora",
      "Nuki Dora",
      "抜きドラ",
      "Kita",
    ]);
    expect(names[0]).toBe("Nuki Dora");
    expect(
      Object.keys(
        sortYakuRecord({ "nuki dora": "2飜", ドラ: "1飜", 立直: "1飜" })
      )
    ).toEqual(["立直", "ドラ", "nuki dora"]);
  });

  it("orders canonical names while preserving neutral insertion order", () => {
    expect(
      sortYakuNames(["Dora", "Toitoi", "Riichi", "Haku", "Ippatsu"])
    ).toEqual(["Riichi", "Ippatsu", "Toitoi", "Haku", "Dora"]);
  });

  it("applies the same priorities to scorer kanji aliases", () => {
    expect(sortYakuNames(["裏ドラ", "三暗刻", "断么九", "立直"])).toEqual([
      "立直",
      "断么九",
      "三暗刻",
      "裏ドラ",
    ]);
  });

  it("returns a new record with values unchanged", () => {
    expect(
      sortYakuRecord({ Dora: "2飜", Pinfu: "1飜", Riichi: "1飜" })
    ).toEqual({ Riichi: "1飜", Pinfu: "1飜", Dora: "2飜" });
  });
});
