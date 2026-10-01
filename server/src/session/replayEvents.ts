import type { GameEvent, Seat } from "~/game/protocol/messages";

export function compactRyuukyokuDeclarationsForReplay(
  events: readonly GameEvent[]
): GameEvent[] {
  const compacted: GameEvent[] = [];
  let dealer: Seat | null = null;
  let pending: Array<{ seat: Seat; tenpai: boolean }> = [];

  for (const event of events) {
    if (event.type === "ryuukyoku_declaration") {
      pending.push({ seat: event.seat, tenpai: event.tenpai });
      continue;
    }
    if (event.type === "hand_end" && event.reason === "exhaustive_draw") {
      if (pending.length > 0) {
        if (dealer === null || pending.length !== 4 || !event.tenpai) {
          throw new Error(
            "Cannot compact an incomplete ryuukyoku declaration sequence"
          );
        }
        for (let index = 0; index < 4; index++) {
          const expectedSeat = ((dealer + index) % 4) as Seat;
          const declaration = pending[index];
          if (
            declaration.seat !== expectedSeat ||
            event.tenpai[declaration.seat] !== declaration.tenpai
          ) {
            throw new Error(
              "Cannot compact a misordered ryuukyoku declaration sequence"
            );
          }
        }
        compacted.push({
          ...event,
          declarations: pending.map((d) => ({ ...d })),
        });
        pending = [];
        continue;
      }
      compacted.push(event);
      continue;
    }
    if (pending.length > 0) {
      throw new Error(
        `Ryuukyoku declaration sequence was interrupted by ${event.type}`
      );
    }
    compacted.push(event);
    if (event.type === "hand_start") {
      dealer = event.dealer;
    }
  }
  if (pending.length > 0) {
    throw new Error("Ryuukyoku declaration sequence has no hand_end");
  }
  return compacted;
}
