import { describe, expect, it } from "vitest";
import { TimeBank } from "./timeBank";

describe("TimeBank", () => {
  it("grants independent per-seat balances and refills without stacking", () => {
    const bank = new TimeBank(20_000);
    expect(bank.debitExact(1, 1_000)).toBe(1_000);
    expect(bank.snapshot()).toEqual([20_000, 19_000, 20_000, 20_000]);
    bank.refill(20_000);
    expect(bank.snapshot()).toEqual([20_000, 20_000, 20_000, 20_000]);
  });

  it("charges exact milliseconds and reports the charged amount", () => {
    const bank = new TimeBank(20_000);
    expect(bank.debitExact(0, 100)).toBe(100);
    expect(bank.debitExact(0, 1_201)).toBe(1_201);
    expect(bank.balance(0)).toBe(18_699);
  });

  it("clamps an exhausted bank to zero", () => {
    const bank = new TimeBank(20_000);
    expect(bank.debitExact(3, 60_000)).toBe(20_000);
    expect(bank.balance(3)).toBe(0);
  });

  it("rejects invalid debits", () => {
    const bank = new TimeBank(20_000);
    expect(() => bank.debitExact(0, -1)).toThrow(RangeError);
    expect(() => bank.debitExact(0, 1.5)).toThrow(RangeError);
  });

  it("restores known balances exactly and does not expose writable storage", () => {
    const bank = new TimeBank(20_000);
    const saved: [number, number, number, number] = [1_234, 0, 19_000, 20_000];
    bank.restore(saved);
    saved[0] = 0;
    const snapshot = bank.snapshot();
    snapshot[2] = 0;
    expect(bank.snapshot()).toEqual([1_234, 0, 19_000, 20_000]);
  });
});
