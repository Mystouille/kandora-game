/**
 * Feature gate for the in-app Kandora mahjong game.
 *
 * The game ships into the portal codebase but is **off by default in
 * every environment**. Contributors opt in locally with `GAME_ENABLED=true`.
 *
 * Server-side: all game-route loaders (and the game-server WS upgrade
 * handler, once that exists) must call `requireGameEnabled()` first.
 *
 * Client-side: the navigation hides game entry points by reading the
 * sanitized flag returned by `getClientGameFlag()`. The client flag is
 * a UX nicety — never trust it for access control; the server gate is
 * the source of truth.
 */
import { gameEnabled } from "config";

/**
 * Server-side guard. Call from every game-route loader.
 *
 * Throws a 404 Response when the game is disabled so React Router
 * surfaces the standard not-found behavior — same as if the route did
 * not exist at all.
 */
export function requireGameEnabled(): void {
  if (!gameEnabled) {
    throw new Response("Not Found", { status: 404 });
  }
}

/**
 * Returns the sanitized client-facing feature flag. Safe to embed in
 * loader return values.
 */
export function getClientGameFlag(): { gameEnabled: boolean } {
  return { gameEnabled };
}

/**
 * Server-side boolean read of the flag (no throw). Use only in places
 * where a redirect / 404 is not appropriate (e.g. conditional nav
 * rendering on the server).
 */
export function isGameEnabled(): boolean {
  return gameEnabled;
}
