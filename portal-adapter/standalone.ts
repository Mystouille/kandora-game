/**
 * `PortalAdapter` stub for the future standalone `kandora-game` build.
 *
 * When the game is extracted into its own repository, this implementation
 * replaces `./portal.ts`. The standalone version must:
 *
 *   1. Verify tokens issued by the game-app's own auth service (e.g. a
 *      dedicated JWT issuer, or an OAuth/OIDC provider). It must NOT
 *      depend on the portal's `jose` secret or cookie name.
 *   2. Look up users from the game-app's own user store. Day one this
 *      may be a thin mirror replicated from the portal; long-term it
 *      becomes the source of truth.
 *   3. Optionally implement `publishMatchEnded` to call back into the
 *      portal via a public webhook / event bus, if the two products
 *      remain linked. Otherwise leave it undefined.
 *
 * Keeping this file in-repo (even as a throwing stub) makes the
 * extraction contract explicit and lets us typecheck the seam.
 */
import type { PortalAdapter, PortalUserProfile, VerifiedToken } from "./types";

const NOT_IMPLEMENTED =
  "PortalAdapter standalone build is not implemented in the portal-hosted bundle. " +
  "Use `./portal.ts` instead, or replace this stub when extracting the game.";

export const standaloneAdapter: PortalAdapter = {
  ensureDbConnected(): Promise<void> {
    throw new Error(NOT_IMPLEMENTED);
  },
  verifyToken(_token: string): Promise<VerifiedToken | null> {
    throw new Error(NOT_IMPLEMENTED);
  },
  getUserProfile(_userId: string): Promise<PortalUserProfile | null> {
    throw new Error(NOT_IMPLEMENTED);
  },
};
