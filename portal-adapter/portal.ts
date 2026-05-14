/**
 * `PortalAdapter` implementation backed by the current portal:
 *   - `verifyToken`   → existing `jose` JWT verifier (`app/utils/jwt.server`)
 *   - `getUserProfile` → portal Mongoose `UserModel` (`app/db/User`)
 *   - `publishMatchEnded` is intentionally not implemented here;
 *     left undefined so callers can detect the no-op case via the
 *     optional method.
 *
 * This is the **one place** in the game subtree that imports portal
 * internals. The boundary ESLint rule allows imports from `~/utils/**`
 * and `~/db/**` only inside this file (and its sibling stub). Any other
 * import from portal feature modules is blocked.
 *
 * Extraction note: replace this file with `./standalone.ts` (own JWT
 * issuer + own user store) when the game leaves the portal repo.
 */
import { computeUserName, UserModel } from "~/db/User";
import { verifyToken as verifyJwt } from "~/utils/jwt.server";
import { connectToDatabase } from "~/utils/dbConnection.server";
import type { PortalAdapter, PortalUserProfile, VerifiedToken } from "./types";

export const portalAdapter: PortalAdapter = {
  async ensureDbConnected(): Promise<void> {
    await connectToDatabase();
  },

  async verifyToken(token: string): Promise<VerifiedToken | null> {
    const payload = await verifyJwt(token);
    if (!payload) {
      return null;
    }
    return { userId: payload.sub };
  },

  async getUserProfile(userId: string): Promise<PortalUserProfile | null> {
    await connectToDatabase();
    const user = await UserModel.findById(userId)
      .select("firstName lastName discordIdentity avatarUrl")
      .lean();
    if (!user) {
      return null;
    }
    return {
      id: userId,
      displayName: computeUserName(user),
      avatarUrl: user.avatarUrl ?? undefined,
    };
  },
};
