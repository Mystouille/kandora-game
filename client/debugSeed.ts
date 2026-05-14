/**
 * Storage helpers for the lobby's debug-seed handoff to the game route.
 *
 * The lobby stores a `MatchDebug` object in `sessionStorage` keyed by
 * `matchId`; the game route reads it once on mount and passes it to the
 * WS `hello` frame. `sessionStorage` is per-tab and survives the
 * navigation, which is exactly what we want here.
 */
import type { MatchDebug } from "~/game/protocol/messages";

const KEY = (matchId: string): string => `kandora-game-debug:${matchId}`;

export function saveMatchDebug(matchId: string, debug: MatchDebug): void {
  if (typeof window === "undefined") {
    return;
  }
  if (!debug) {
    window.sessionStorage.removeItem(KEY(matchId));
    return;
  }
  window.sessionStorage.setItem(KEY(matchId), JSON.stringify(debug));
}

export function takeMatchDebug(matchId: string): MatchDebug {
  if (typeof window === "undefined") {
    return undefined;
  }
  const raw = window.sessionStorage.getItem(KEY(matchId));
  if (!raw) {
    return undefined;
  }
  window.sessionStorage.removeItem(KEY(matchId));
  try {
    return JSON.parse(raw) as MatchDebug;
  } catch {
    return undefined;
  }
}

const TILE_RE = /^([0-9][mps]|[1-7]z)$/;

/**
 * Parse a free-form tile list. Accepts whitespace-, comma-, or
 * newline-separated tokens; ignores empties; lowercases. Each token
 * may be either:
 *
 *   - A single tile in protocol notation (`5m`, `1z`, `0p`).
 *   - A compact group like `1234s45p7z` — digits inherit the next
 *     suit letter, so `1234s45p7z` expands to
 *     `1s 2s 3s 4s 4p 5p 7z`. For honors, only `1`–`7` are valid.
 *
 * Returns the list of valid tiles plus a list of invalid tokens so
 * the UI can surface them to the user.
 */
export function parseTileList(input: string): {
  tiles: string[];
  invalid: string[];
} {
  const tokens = input
    .split(/[\s,]+/)
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 0);
  const tiles: string[] = [];
  const invalid: string[] = [];
  for (const tok of tokens) {
    if (TILE_RE.test(tok)) {
      tiles.push(tok);
      continue;
    }
    const expanded = expandCompact(tok);
    if (expanded) {
      tiles.push(...expanded);
    } else {
      invalid.push(tok);
    }
  }
  return { tiles, invalid };
}

/**
 * Expand a compact-notation token (e.g. `1234s45p7z`) into individual
 * tiles. Returns `null` if the token doesn't fully consume into
 * digit-run + suit groups, or if any honor digit is outside `1`–`7`.
 */
function expandCompact(token: string): string[] | null {
  if (!/^[0-9mpsz]+$/.test(token)) {
    return null;
  }
  const out: string[] = [];
  let digits = "";
  for (const ch of token) {
    if (ch >= "0" && ch <= "9") {
      digits += ch;
      continue;
    }
    // suit char
    if (digits.length === 0) {
      return null;
    }
    if (ch === "z") {
      for (const d of digits) {
        if (d < "1" || d > "7") {
          return null;
        }
        out.push(`${d}z`);
      }
    } else {
      for (const d of digits) {
        out.push(`${d}${ch}`);
      }
    }
    digits = "";
  }
  if (digits.length > 0) {
    return null;
  }
  return out.length > 0 ? out : null;
}
