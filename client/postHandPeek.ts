import type { GameEvent, Seat } from "~/game/protocol/messages";

export const POST_HAND_PEEK_DISCARD_LIMIT = 2;

export function advancePostHandPeekDiscardCount(
  current: number,
  event: GameEvent,
  focusedSeat: Seat | null
): number {
  return event.type === "discard" && event.seat === focusedSeat
    ? current + 1
    : current;
}

export function shouldHidePostHandPeek(discardCount: number): boolean {
  return discardCount >= POST_HAND_PEEK_DISCARD_LIMIT;
}
