import type { MatchProcess } from "./match";

export interface ActiveMatchSummary {
  matchId: string;
  status: "playing";
  connected: boolean;
}

export class MultipleActiveMatchesError extends Error {
  constructor(
    readonly userId: string,
    readonly matchIds: string[]
  ) {
    super(
      `User ${userId} is seated in multiple active matches: ${matchIds.join(", ")}`
    );
    this.name = "MultipleActiveMatchesError";
  }
}

export function findActiveMatchForUser(
  matches: Iterable<MatchProcess>,
  userId: string,
  excludeMatchId?: string
): ActiveMatchSummary | null {
  const active: ActiveMatchSummary[] = [];
  for (const match of matches) {
    if (
      match.isRelay ||
      match.status !== "playing" ||
      match.matchId === excludeMatchId
    ) {
      continue;
    }
    const seat = match.humanSeatForUser(userId);
    if (seat === null) {
      continue;
    }
    active.push({
      matchId: match.matchId,
      status: "playing",
      connected: match.isHumanConnected(seat),
    });
  }
  if (active.length > 1) {
    throw new MultipleActiveMatchesError(
      userId,
      active.map(({ matchId }) => matchId)
    );
  }
  return active[0] ?? null;
}
