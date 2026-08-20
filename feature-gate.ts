/**
 * Self-contained feature gate for the in-app Kandora mahjong game.
 *
 * This is the engine-submodule copy: unlike the host apps' `~/utils/feature-gate`
 * (which reads the `config` module), it reads `GAME_ENABLED` straight from the
 * environment so the shared `kandora-game` engine has no dependency on any host
 * app's config. The game is **off by default** — opt in with `GAME_ENABLED=true`.
 *
 * Every game-route loader calls `requireGameEnabled()` first. Route modules are
 * also evaluated during browser hydration, so the environment read itself must
 * remain browser-safe; clients receive the sanitized flag via loader data.
 */
const gameEnabled =
  typeof process !== "undefined" && process.env.GAME_ENABLED === "true";

/**
 * Server-side guard. Call from every game-route loader. Throws a 404 Response
 * when the game is disabled so React Router surfaces the standard not-found
 * behavior — same as if the route did not exist.
 */
export function requireGameEnabled(): void {
  if (!gameEnabled) {
    throw new Response("Not Found", { status: 404 });
  }
}

/**
 * Returns the sanitized client-facing feature flag. Safe to embed in loader
 * return values.
 */
export function getClientGameFlag(): { gameEnabled: boolean } {
  return { gameEnabled };
}

/**
 * Server-side boolean read of the flag (no throw).
 */
export function isGameEnabled(): boolean {
  return gameEnabled;
}
