import { describe, expect, it } from "vitest";
import { TimeBank } from "./timeBank";

describe("legacy TimeBank", () => {
  const policy = { baseMs: 5_000, graceMs: 200 };

  it("grants independent per-seat balances and refills without stacking", () => {
    const bank = new TimeBank(20_000);
    bank.consumeLegacyElapsed(1, 6_200, policy);
    expect(bank.snapshot()).toEqual([20_000, 19_000, 20_000, 20_000]);
    bank.refill(20_000);
    expect(bank.snapshot()).toEqual([20_000, 20_000, 20_000, 20_000]);
  });

  it("keeps the base and grace free through their exact boundary", () => {
    const bank = new TimeBank(20_000);
    bank.consumeLegacyElapsed(0, 5_199, policy);
    bank.consumeLegacyElapsed(0, 5_200, policy);
    expect(bank.balance(0)).toBe(20_000);
  });

  it("retains legacy whole-second flooring rather than activating precise billing", () => {
    const bank = new TimeBank(20_000);
    bank.consumeLegacyElapsed(0, 5_300, policy);
    expect(bank.balance(0)).toBe(19_000);
    bank.consumeLegacyElapsed(0, 6_201, policy);
    expect(bank.balance(0)).toBe(17_000);
  });

  it("clamps an exhausted bank to zero", () => {
    const bank = new TimeBank(20_000);
    bank.consumeLegacyElapsed(3, 60_000, policy);
    expect(bank.balance(3)).toBe(0);
  });

  it("restores known legacy balances exactly and does not expose writable storage", () => {
    const bank = new TimeBank(20_000);
    const saved: [number, number, number, number] = [1_234, 0, 19_000, 20_000];
    bank.restore(saved);
    saved[0] = 0;
    const snapshot = bank.snapshot();
    snapshot[2] = 0;
    expect(bank.snapshot()).toEqual([1_234, 0, 19_000, 20_000]);
  });
});
