import type { DuplicateWallState, Seat } from "~/game/protocol/messages";

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
  return ([0, 1, 2, 3] as Seat[]).map((seat) => {
    const limiting = state.limitingSeat === seat;
    return {
      seat,
      remaining: state.remaining[seat],
      limiting,
      color: limiting
        ? DUPLICATE_LIMITING_COLOR
        : DUPLICATE_REMAINING_COLOR,
    };
  });
}

export function displayedTilesRemaining(view: {
  drawsTaken: number;
  duplicateWallState?: DuplicateWallState | null;
}): number {
  return view.duplicateWallState?.estimatedDrawsRemaining ??
    Math.max(0, 70 - view.drawsTaken);
}