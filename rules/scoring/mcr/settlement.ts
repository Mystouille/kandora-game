import type { McrSeatDeltas, McrSettlementInput } from "./types";

/** Pure four-player MCR settlement. Returned deltas always sum to zero. */
export function settleMcrWin(input: McrSettlementInput): McrSeatDeltas {
  if (!Number.isInteger(input.winner) || input.winner < 0 || input.winner > 3) {
    throw new RangeError("winner must be a seat from zero through three");
  }
  if (
    input.discarder !== undefined &&
    (!Number.isInteger(input.discarder) ||
      input.discarder < 0 ||
      input.discarder > 3)
  ) {
    throw new RangeError("discarder must be a seat from zero through three");
  }
  if (!Number.isInteger(input.totalFan) || input.totalFan < 0) {
    throw new RangeError("totalFan must be a non-negative integer");
  }
  if (!Number.isInteger(input.nonFlowerFan) || input.nonFlowerFan < 8) {
    throw new RangeError("Settlement requires at least eight non-flower points");
  }
  if (input.nonFlowerFan > input.totalFan) {
    throw new RangeError("nonFlowerFan cannot exceed totalFan");
  }

  const deltas = [0, 0, 0, 0];
  if (input.method === "self-draw") {
    if (input.discarder !== undefined) {
      throw new Error("A self-draw settlement cannot have a discarder");
    }
    const payment = input.totalFan + 8;
    for (let seat = 0; seat < 4; seat++) {
      if (seat !== input.winner) {
        deltas[seat] = -payment;
        deltas[input.winner] += payment;
      }
    }
  } else {
    if (input.discarder === undefined || input.discarder === input.winner) {
      throw new Error("A discard settlement needs a different discarder");
    }
    for (let seat = 0; seat < 4; seat++) {
      if (seat === input.winner) {
        continue;
      }
      const payment = seat === input.discarder ? input.totalFan + 8 : 8;
      deltas[seat] = -payment;
      deltas[input.winner] += payment;
    }
  }

  if (deltas.reduce((sum, value) => sum + value, 0) !== 0) {
    throw new Error("Internal MCR settlement imbalance");
  }
  return Object.freeze(deltas) as McrSeatDeltas;
}
