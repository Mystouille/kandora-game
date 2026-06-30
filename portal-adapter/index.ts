/**
 * `PortalAdapter` injection point. Single import for game code:
 *
 *     import { adapter } from "~/game/portal-adapter";
 *
 * Defaults to the standalone stub. The host (portal web server,
 * game-server, or a future standalone app) injects its real
 * implementation at startup via `setAdapter(...)`. `adapter` is a
 * live binding, so call sites stay the same.
 */
import { standaloneAdapter } from "./standalone";
import type { PortalAdapter } from "./types";

export let adapter: PortalAdapter = standaloneAdapter;

/** Inject the host's PortalAdapter implementation. Call once at startup. */
export function setAdapter(impl: PortalAdapter): void {
  adapter = impl;
}

export type {
  PortalAdapter,
  PortalUserProfile,
  VerifiedToken,
  MatchSummary,
} from "./types";
