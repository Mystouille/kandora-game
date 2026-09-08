import type { Seat } from "../protocol/messages";

export interface ReplayLocationRequest {
  seat?: number;
  event?: number;
  round?: number;
}

export interface ReplayLocationReview {
  seat?: number | null;
  edits: ReadonlyArray<{ eventIndex: number }>;
}

export interface ReplayInitialLocation {
  seat: Seat;
  index: number;
}

export function normalizeReplaySeat(
  value: number | undefined | null
): Seat {
  if (value === 1 || value === 2 || value === 3) {
    return value;
  }
  return 0;
}

function clampIndex(
  value: number,
  bounds: { min: number; max: number }
): number {
  return Math.max(bounds.min, Math.min(Math.trunc(value), bounds.max));
}

export function replayLocationRequestFromSearchParams(
  searchParams: URLSearchParams
): ReplayLocationRequest {
  const request: ReplayLocationRequest = {};
  const seatRaw = searchParams.get("seat");
  if (seatRaw !== null && seatRaw !== "") {
    const seat = Number(seatRaw);
    if (Number.isFinite(seat)) {
      request.seat = seat;
    }
  }
  const eventRaw = searchParams.get("event");
  if (eventRaw !== null && eventRaw !== "") {
    const event = Number(eventRaw);
    if (Number.isFinite(event)) {
      request.event = event;
    }
  }
  const roundRaw = searchParams.get("round");
  if (roundRaw !== null && roundRaw !== "") {
    const round = Number(roundRaw);
    if (Number.isFinite(round)) {
      request.round = round;
    }
  }
  return request;
}

export function resolveReplayInitialLocation(options: {
  request: ReplayLocationRequest;
  bounds: { min: number; max: number };
  rounds: readonly number[];
  review?: ReplayLocationReview | null;
}): ReplayInitialLocation {
  const { request, bounds, rounds, review = null } = options;
  const seat = normalizeReplaySeat(review?.seat ?? request.seat);

  if (request.event !== undefined && Number.isFinite(request.event)) {
    return { seat, index: clampIndex(request.event, bounds) };
  }
  if (request.round !== undefined && Number.isFinite(request.round)) {
    const roundIndex = Math.trunc(request.round) - 1;
    const eventIndex = rounds[roundIndex];
    if (eventIndex !== undefined) {
      return { seat, index: clampIndex(eventIndex, bounds) };
    }
  }
  if (review !== null && review.edits.length > 0) {
    const firstEditIndex = review.edits.reduce(
      (minimum, edit) => Math.min(minimum, edit.eventIndex),
      review.edits[0].eventIndex
    );
    return { seat, index: clampIndex(firstEditIndex, bounds) };
  }
  return {
    seat,
    index: clampIndex(rounds[0] ?? bounds.min, bounds),
  };
}