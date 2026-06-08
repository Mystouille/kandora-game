/**
 * Normalize whatever the user pasted (raw id, share link, link with
 * viewer-suffix) down to the canonical `sourceGameId` shape that
 * `inferReplaySource` and the DB lookup expect.
 *
 * Handles:
 *   - Tenhou share URL: `https://tenhou.net/<n>/?log=<id>(&tw=<n>)?`
 *   - Majsoul share URL: any `…?paipu=<id>` (e.g.
 *     `https://mahjongsoul.game.yo-star.com/?paipu=<id>`,
 *     `https://game.mahjongsoul.com/?paipu=<id>`).
 *   - Majsoul `_a<n>` viewer suffix.
 *   - Riichi City `@<n>` viewer suffix.
 */
export function normalizeReplayId(raw: string): string {
  let id = raw.trim();
  // Tenhou: extract the `log` query param from any tenhou.net URL.
  const tenhouLogMatch = /[?&]log=([^&\s#]+)/i.exec(id);
  if (tenhouLogMatch && /tenhou\.net/i.test(id)) {
    id = decodeURIComponent(tenhouLogMatch[1]);
  }
  // Majsoul: extract the `paipu` query param from any share URL.
  // The param name is unique enough to Majsoul that we don't need
  // to gate on the host; this also covers regional mirrors
  // (mahjongsoul.game.yo-star.com, game.mahjongsoul.com,
  // game.maj-soul.com, …).
  const majsoulPaipuMatch = /[?&]paipu=([^&\s#]+)/i.exec(id);
  if (majsoulPaipuMatch) {
    id = decodeURIComponent(majsoulPaipuMatch[1]);
  }
  const majsoulSuffix = /_a\d+$/.exec(id);
  if (majsoulSuffix) {
    id = id.slice(0, majsoulSuffix.index);
  }
  const rcSuffix = /@([0-3])$/.exec(id);
  if (rcSuffix) {
    id = id.slice(0, rcSuffix.index);
  }
  return id;
}

/**
/**
 * Extract the Riichi City `@<n>` viewer-suffix value (0–3) from a
 * raw replay id / share link, or `null` if absent. Mirrors the
 * stripping logic in `normalizeReplayId` so callers can re-attach
 * the suffix when forwarding the user to the in-app replay viewer.
 *
 * The returned number is NOT an absolute seat: RC encodes the
 * round-1 wind position (0=E, 1=S, 2=W, 3=N), and the absolute
 * seat depends on `dealer_pos` of round 1. The `/replays/:gameId`
 * loader resolves the actual seat against the parsed log; callers
 * shouldn't try to translate it themselves.
 */
export function extractRiichiCityWind(raw: string): number | null {
  const match = /@([0-3])$/.exec(raw.trim());
  if (!match) {
    return null;
  }
  return Number(match[1]);
}
