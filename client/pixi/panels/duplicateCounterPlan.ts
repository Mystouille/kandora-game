import type { DuplicateWallState, Seat } from "~/game/protocol/messages";
import type { PlayerCount } from "~/game/protocol/seat";

export const DUPLICATE_REMAINING_COLOR = 0x9ca3af;
export const DUPLICATE_LIMITING_COLOR = 0x4ade80;

export interface DuplicatePlayerCounterSpec {
  seat: Seat;
  remaining: number;
  limiting: boolean;
  color: number;
}

export function duplicatePlayerCounterSpecs(
  state: DuplicateWallState | null
): DuplicatePlayerCounterSpec[] {
  if (state === null) {
    return [];
  }
  return state.remaining.map((remaining, index) => {
    const seat = index as Seat;
    const limiting = state.limitingSeat === seat;
    return {
      seat,
      remaining,
      limiting,
      color: limiting ? DUPLICATE_LIMITING_COLOR : DUPLICATE_REMAINING_COLOR,
    };
  });
}

export function displayedTilesRemaining(view: {
  drawsTaken: number;
  duplicateWallState?: DuplicateWallState | null;
  playerCount?: PlayerCount;
  wallRemaining?: number;
}): number {
  return (
    view.duplicateWallState?.estimatedDrawsRemaining ??
    (view.playerCount === 3
      ? Math.max(0, view.wallRemaining ?? 0)
      : Math.max(0, 70 - view.drawsTaken))
  );
}
