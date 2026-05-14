/**
 * `PortalAdapter` — the single seam between the in-app Kandora mahjong
 * game and the surrounding portal.
 *
 * All portal-specific reuse (auth, user lookup, optional notifications)
 * goes through this interface. Game code (`app/game/**`, `game-server/**`)
 * MUST NOT import portal auth/user code directly.
 *
 * When the game is extracted into a standalone `kandora-game` repo, only
 * the implementation of this interface needs to change — call sites stay
 * the same. See {@link ./standalone.ts} and `app/game/README.md`.
 */

export interface PortalUserProfile {
  /** Stable user identifier (portal: Mongo `_id` as string). */
  id: string;
  /** Display name shown in seat labels, leaderboards, etc. */
  displayName: string;
  /** Optional avatar URL (full https URL). */
  avatarUrl?: string;
}

export interface VerifiedToken {
  /** Stable user identifier; matches `PortalUserProfile.id`. */
  userId: string;
}

/**
 * Optional summary the game can publish back to the portal when a match
 * ends (e.g. to surface "last played" widgets). The standalone version
 * will simply not implement this hook.
 */
export interface MatchSummary {
  matchId: string;
  endedAt: Date;
  players: Array<{
    userId: string;
    seat: number;
    finalScore: number;
    place: number;
  }>;
}

export interface PortalAdapter {
  /**
   * Ensure the shared Mongo connection is ready. Game-side loaders /
   * server code that read game models (`~/db/models/**`) call this
   * once before any query. Idempotent. The standalone build points
   * this at its own DB.
   */
  ensureDbConnected(): Promise<void>;

  /**
   * Verify an opaque auth token (today: a portal JWT). Returns the
   * resolved user, or `null` if the token is invalid / expired.
   */
  verifyToken(token: string): Promise<VerifiedToken | null>;

  /**
   * Fetch a user's public profile. Used by the game-server when seating
   * players and by spectator UIs.
   */
  getUserProfile(userId: string): Promise<PortalUserProfile | null>;

  /**
   * Optional post-match notification hook. Implementations may use this
   * to update portal-side "recent matches" widgets, push notifications,
   * etc. Game code calls this best-effort and ignores failures.
   */
  publishMatchEnded?(summary: MatchSummary): Promise<void>;
}
