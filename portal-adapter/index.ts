/**
 * Default `PortalAdapter` export. Single import point for game code:
 *
 *     import { adapter } from "~/game/portal-adapter";
 *
 * Today this is the portal-backed implementation. After extraction it
 * becomes the standalone implementation — call sites do not change.
 */
export { portalAdapter as adapter } from "./portal";
export type {
  PortalAdapter,
  PortalUserProfile,
  VerifiedToken,
  MatchSummary,
} from "./types";
