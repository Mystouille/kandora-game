import type { Seat } from "~/game/protocol/messages";

export type TimeBankSnapshot = [number, number, number, number];

/** Owns the per-hand pool and exact-millisecond debits. */
export class TimeBank {
  private balances: TimeBankSnapshot;

  constructor(initialMs: number) {
    this.balances = [initialMs, initialMs, initialMs, initialMs];
  }

  balance(seat: Seat): number {
    return this.balances[seat];
  }

  snapshot(): TimeBankSnapshot {
    return [...this.balances];
  }

  restore(snapshot: readonly [number, number, number, number]): void {
    this.balances = [...snapshot];
  }

  refill(initialMs: number): void {
    this.balances = [initialMs, initialMs, initialMs, initialMs];
  }

  debitExact(seat: Seat, overageMs: number): number {
    if (!Number.isSafeInteger(overageMs) || overageMs < 0) {
      throw new RangeError("Invalid millisecond time-bank debit");
    }
    const charged = Math.min(this.balances[seat], overageMs);
    this.balances[seat] -= charged;
    return charged;
  }
}
