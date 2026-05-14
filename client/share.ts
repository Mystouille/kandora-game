/**
 * Canonical share-URL helpers for in-game surfaces.
 *
 * Every share link the game produces (replay sheet, "copy match
 * link" button, social embeds) **must** go through these helpers
 * so that:
 *
 *   1. The format stays consistent (`/replays/:source/:gameId`,
 *      `/game/:matchId`, `/profile/:userId` — paths the routing
 *      layer already understands).
 *   2. The host we share matches the canonical public origin, not
 *      whatever the client happens to be running on. This is the
 *      single thing that breaks naively in a Capacitor WebView:
 *      `window.location.origin` there is `capacitor://localhost`
 *      (iOS) or `https://localhost` (Android) — useless to anyone
 *      else.
 *   3. Universal Links (iOS) and App Links (Android) work without
 *      ever exposing a `kandora://` scheme to users. Share an
 *      https URL; the OS routes installed-app vs. web on its own.
 *
 * Resolution order for the public origin:
 *
 *   - `import.meta.env.VITE_PUBLIC_BASE_URL` (build-time, set
 *     explicitly for the mobile shell build and optionally for
 *     prod web builds; this is the canonical answer).
 *   - `window.location.origin` (web fallback — fine for desktop
 *     and mobile-web, wrong inside Capacitor).
 *
 * See `docs/mahjong-game-plan.md` Phase M prereq #5 for the wider
 * mobile-shell rationale.
 */

/**
 * The canonical https origin shared content should reference.
 *
 * In the browser this is whatever the user is currently on, unless
 * the build has been pinned to a specific host via
 * `VITE_PUBLIC_BASE_URL` (recommended once a stable public hostname
 * exists, mandatory for Capacitor builds).
 *
 * Exported as a function (not a constant) so callers always see
 * the up-to-date `window.location.origin` in case the helper is
 * imported before `window` is defined (SSR safety).
 */
export function publicBaseUrl(): string {
  const fromEnv = import.meta.env.VITE_PUBLIC_BASE_URL;
  if (typeof fromEnv === "string" && fromEnv.length > 0) {
    return fromEnv.replace(/\/$/, "");
  }
  if (typeof window !== "undefined") {
    return window.location.origin;
  }
  // SSR with no env override: return an empty string so callers
  // get root-relative URLs, which still work in the browser.
  return "";
}

/** Canonical URL for a finished-match replay page. The replay
 * route infers the platform from the id shape, so callers only
 * need to pass the native game id (or the in-app matchId). */
export function replayShareUrl(gameId: string): string {
  return `${publicBaseUrl()}/replays/${encodeURIComponent(gameId)}`;
}

/** Canonical URL for a live match page (lobby invite / spectate). */
export function matchShareUrl(matchId: string): string {
  return `${publicBaseUrl()}/game/${encodeURIComponent(matchId)}`;
}

/** Canonical URL for a user profile page. */
export function profileShareUrl(userId: string): string {
  return `${publicBaseUrl()}/profile/${encodeURIComponent(userId)}`;
}
