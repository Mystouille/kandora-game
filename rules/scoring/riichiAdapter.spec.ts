import Riichi from "riichi";
import { describe, expect, it } from "vitest";
import { applySanmaPayments } from "./sanmaPayments";
import { createRiichiScorer, type RiichiAdapterOptions } from "./riichiAdapter";

function controlledCandidates(options: RiichiAdapterOptions = {}) {
  const scorer = createRiichiScorer("222333444p5567s+8s", options);
  let candidate = 0;
  // Use the installed library's real two-pattern comparison loop, with values
  // straddling the point/han preference boundary independently of its yaku set.
  scorer.calcYaku = () => {
    scorer.tmpResult.han = candidate === 0 ? 2 : 3;
    scorer.tmpResult.fu = candidate === 0 ? 70 : 30;
    scorer.tmpResult.yakuman = 0;
    scorer.tmpResult.yaku = {
      [`candidate${candidate}`]: `${scorer.tmpResult.han}飜`,
    };
    candidate++;
  };
  scorer.calcFu = () => {};
  return scorer;
}

describe("per-instance riichi adapter", () => {
  it("revalues candidates before the library's point-first selection for Kansai", () => {
    const standard = controlledCandidates().calc();
    expect(standard).toMatchObject({ han: 2, fu: 70, ten: 4500 });

    const kansai = controlledCandidates({
      priceCandidate: (candidate) =>
        applySanmaPayments(candidate, {
          tsumo: false,
          sanmaType: "kansai",
        }),
    }).calc();
    expect(kansai).toMatchObject({ han: 3, fu: 30, ten: 4000 });
    expect(kansai.yaku).toEqual({ candidate1: "3飜" });
  });

  it.each([
    { nukiDora: 3, nukiIndicatorDora: 0, nukiAkaDora: 0 },
    { nukiDora: 1, nukiIndicatorDora: 1, nukiAkaDora: 1 },
  ])(
    "adds nuki bonuses before candidate selection and limit-band comparisons: %o",
    (bonuses) => {
      const score = controlledCandidates({
        ...bonuses,
        priceCandidate: (candidate) =>
          applySanmaPayments(candidate, {
            tsumo: false,
            sanmaType: "kansai",
          }),
      }).calc();
      expect(score).toMatchObject({ han: 6, fu: 30, ten: 12000 });
      expect(score.yaku).toMatchObject({
        candidate1: "3飜",
        抜きドラ: `${bonuses.nukiDora}飜`,
      });
    }
  );

  it("uses han to break a same-band tie, not fu or original yonma points", () => {
    const score = controlledCandidates({
      nukiDora: 2,
      priceCandidate: (candidate) =>
        applySanmaPayments(candidate, {
          tsumo: false,
          sanmaType: "kansai",
        }),
    }).calc();
    expect(score).toMatchObject({ han: 5, fu: 30, ten: 8000 });
    expect(score.yaku).toMatchObject({ candidate1: "3飜", 抜きドラ: "2飜" });
  });

  it("leaves unrelated library instances and the prototype untouched", () => {
    const original = Object.getPrototypeOf(new Riichi("123p456789s1155z+5z"));
    const methods = {
      calcFu: original.calcFu,
      calcTen: original.calcTen,
      calcDora: original.calcDora,
    };
    const first = createRiichiScorer("123p456789s1155z+5z", {
      doubleWindPairFu: 2,
      nukiDora: 2,
    });
    const second = createRiichiScorer("123p456789s1155z+5z");
    expect(Object.hasOwn(first, "calcFu")).toBe(true);
    expect(first.calcFu).not.toBe(second.calcFu);
    expect(original.calcFu).toBe(methods.calcFu);
    expect(original.calcTen).toBe(methods.calcTen);
    expect(original.calcDora).toBe(methods.calcDora);
    expect(new Riichi("123p456789s1155z+5z").calc()).toEqual(second.calc());
    expect(first.calc().han).toBe(second.calc().han + 2);
  });
});
