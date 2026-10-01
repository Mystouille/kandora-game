import type { Seat } from "~/game/protocol/messages";

export type TimeBankSnapshot = [number, number, number, number];

export interface LegacyBankPolicy {
  readonly baseMs: number;
  readonly graceMs: number;
}

/** Owns the per-hand pool; exact-millisecond billing is a separate policy change. */
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

  consumeLegacyElapsed(
    seat: Seat,
    elapsedMs: number,
    policy: LegacyBankPolicy
  ): void {
    const overageMs = elapsedMs - policy.baseMs - policy.graceMs;
    if (overageMs > 0) {
      const remainingMs = Math.max(0, this.balances[seat] - overageMs);
      // Preserve legacy HUD-aligned flooring until precise accounting is activated.
      this.balances[seat] = Math.floor(remainingMs / 1_000) * 1_000;
    }
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
