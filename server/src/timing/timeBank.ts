import type { ReadonlySeatValues } from "~/game/protocol/seat";
import { type SeatValues } from "~/game/protocol/seat";
import type { Seat } from "~/game/protocol/messages";
import {
  copySeatValues,
  isActiveSeat,
  seatValues,
  type PlayerCount,
} from "~/game/rules/seats";

export type TimeBankSnapshot = SeatValues<number>;

/** Owns the per-hand pool and exact-millisecond debits. */
export class TimeBank {
  private balances: TimeBankSnapshot;

  constructor(
    initialMs: number,
    readonly playerCount: PlayerCount = 4
  ) {
    this.balances = seatValues(playerCount, () => initialMs);
  }

  balance(seat: Seat): number {
    if (!isActiveSeat(seat, this.playerCount)) {
      throw new Error(`TimeBank: seat ${seat} is not active`);
    }
    return this.balances[seat];
  }

  snapshot(): TimeBankSnapshot {
    return copySeatValues(this.balances);
  }

  restore(snapshot: ReadonlySeatValues<number>): void {
    if (snapshot.length !== this.playerCount) {
      throw new Error("TimeBank: restored participant count does not match");
    }
    this.balances = copySeatValues(snapshot);
  }

  refill(initialMs: number): void {
    this.balances = seatValues(this.playerCount, () => initialMs);
  }

  debitExact(seat: Seat, overageMs: number): number {
    if (!Number.isSafeInteger(overageMs) || overageMs < 0) {
      throw new RangeError("Invalid millisecond time-bank debit");
    }
    const charged = Math.min(this.balance(seat), overageMs);
    this.balances[seat] -= charged;
    return charged;
  }
}
