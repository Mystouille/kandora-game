/**
 * Self-contained feature gate for the in-app Kandora mahjong game.
 *
 * This is the engine-submodule copy: unlike the host apps' `~/utils/feature-gate`
 * (which reads the `config` module), it reads `GAME_ENABLED` straight from the
 * environment so the shared `kandora-game` engine has no dependency on any host
 * app's config. The game is **off by default** — opt in with `GAME_ENABLED=true`.
 *
 * Server-side only: every game-route loader calls `requireGameEnabled()` first.
 * The client never imports this directly — it receives the sanitized flag via
 * loader data (`getClientGameFlag()`).
 */
const gameEnabled = process.env.GAME_ENABLED === "true";

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
