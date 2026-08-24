import { describe, expect, it } from "vitest";
import { sortYakuNames, sortYakuRecord } from "./yakuOrder";

describe("yakuOrder", () => {
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