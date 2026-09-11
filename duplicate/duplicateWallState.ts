import type {
  DuplicateWallState,
  GameEvent,
  Seat,
  Tile,
} from "~/game/protocol/messages";
import {
  estimateDuplicateExhaustion,
  type DuplicateDrawCounts,
} from "./duplicateExhaustion";

export type DuplicateDrawQueues = [Tile[], Tile[], Tile[], Tile[]];

export function cloneDuplicateWallState(
  state: DuplicateWallState
): DuplicateWallState {
  return {
    initial: [...state.initial],
    remaining: [...state.remaining],
    limitingSeat: state.limitingSeat,
    estimatedDrawsRemaining: state.estimatedDrawsRemaining,
  };
}

export function cloneDuplicateDrawQueues(
  queues: readonly (readonly Tile[])[]
): DuplicateDrawQueues {
  return queues.map((queue) => [...queue]) as DuplicateDrawQueues;
}

function stateFromCounts(
  initial: DuplicateDrawCounts,
  remaining: DuplicateDrawCounts,
  context: Parameters<typeof estimateDuplicateExhaustion>[1]
): DuplicateWallState {
  const forecast = estimateDuplicateExhaustion(remaining, context);
  return {
    initial: [...initial],
    remaining: [...remaining],
    limitingSeat: forecast?.limitingSeat ?? null,
    estimatedDrawsRemaining: forecast?.estimatedDrawsRemaining ?? null,
  };
}

export function duplicateWallStateFromQueues(
  queues: DuplicateDrawQueues,
  dealer: Seat
): DuplicateWallState {
  const initial = queues.map((queue) => queue.length) as DuplicateDrawCounts;
  return stateFromCounts(initial, initial, {
    phase: "awaiting_draw",
    turn: dealer,
    pendingReplacementSeat: null,
  });
}

export function duplicateWallStateAfterEvent(
  current: DuplicateWallState | null,
  event: GameEvent
): DuplicateWallState | null {
  if ("duplicateWallState" in event && event.duplicateWallState) {
    return cloneDuplicateWallState(event.duplicateWallState);
  }
  if (event.type === "match_start") {
    return null;
  }
  if (event.type === "hand_start") {
    return event.duplicateDrawQueues
      ? duplicateWallStateFromQueues(
          cloneDuplicateDrawQueues(event.duplicateDrawQueues),
          event.dealer
        )
      : null;
  }
  if (event.type === "hand_end" || event.type === "match_end") {
    return current === null
      ? null
      : {
          ...cloneDuplicateWallState(current),
          limitingSeat: null,
          estimatedDrawsRemaining: null,
        };
  }
  if (current === null) {
    return null;
  }
  if (event.type === "draw") {
    const remaining = [...current.remaining] as DuplicateDrawCounts;
    remaining[event.seat] = Math.max(0, remaining[event.seat] - 1);
    return stateFromCounts(current.initial, remaining, {
      phase: "awaiting_discard",
      turn: event.seat,
      pendingReplacementSeat: null,
    });
  }
  if (event.type === "discard") {
    return stateFromCounts(current.initial, current.remaining, {
      phase: "awaiting_draw",
      turn: ((event.seat + 1) % 4) as Seat,
      pendingReplacementSeat: null,
    });
  }
  if (event.type === "call") {
    const replacementPending =
      event.meld.type === "ankan" ||
      event.meld.type === "daiminkan" ||
      event.meld.type === "shouminkan";
    return stateFromCounts(current.initial, current.remaining, {
      phase: replacementPending ? "awaiting_chankan" : "awaiting_discard",
      turn: event.seat,
      pendingReplacementSeat: replacementPending ? event.seat : null,
    });
  }
  return cloneDuplicateWallState(current);
}