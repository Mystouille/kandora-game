import type { GameEvent } from "~/game/protocol/messages";

/**
 * Shared `ReplayLog` shape — Phase 4.5, step 1.
 *
 * One neutral, platform-agnostic representation that the in-app game
 * and the portal-side platform adapters (Majsoul, Tenhou, Riichi
 * City) all produce. Consumed by the replay reducer in
 * `app/game/replay/` — the reducer never branches on `source`.
 *
 * Boundary: this file lives under `app/game/replay/` (game side).
 * Portal-side parsers in `app/api/<platform>/replayAdapter.ts` may
 * import these types because the boundary rule blocks
 * `app/game/**` → portal feature code, not the reverse. The
 * replay reducer must not import platform-specific code.
 *
 * Persistence (step 8): documents live in their own `replaylogs`
 * collection (model in `app/db/models/ReplayLog.ts`), referenced
 * from `Game.replayLogRef` (and produced eagerly by the existing
 * hydration pipeline for league/tournament games, or by
 * `archiveMatch` for in-app games).
 *
 * Trusted internal type: `ReplayLog` is written by our own code,
 * read from our own Mongo, and delivered to the replay route via
 * a React Router loader (not WS). Zod validation lives at the
 * actual untrusted boundaries — WS frames (`GameEventSchema` in
 * `protocol/messages.ts`) and raw platform logs (inside each
 * platform adapter). Re-validating on the read side would be
 * dead weight.
 */

/**
 * Bump whenever the `ReplayLog` shape changes or any platform
 * adapter is fixed in a way that would change byte-equality of
 * the produced documents. Hydration re-parses logs whose
 * `schemaVersion` is older.
 */
export const REPLAY_LOG_SCHEMA_VERSION = 2;

export type ReplaySource = "ingame" | "majsoul" | "tenhou" | "riichicity";

export interface ReplaySeat {
  seat: 0 | 1 | 2 | 3;
  displayName: string;
  finalScore: number;
  place: 1 | 2 | 3 | 4;
}

export interface ReplayLog {
  source: ReplaySource;
  /** Platform's native game id (matchId for in-app, uuid for Majsoul,
   * log id for Tenhou, id for Riichi City). Used as the lookup key
   * together with `source`. */
  sourceGameId: string;
  /** Canonical rule-set name (e.g. `"tenhou-default"`). Adapter-
   * specific flags go in `ruleSetDetails`. */
  ruleSet: string;
  /** Free-form per-platform flags (red fives, kuitan, agari-yame,
   * sanma, etc.). Documented per platform in the fidelity matrix. */
  ruleSetDetails?: Record<string, unknown>;
  /** Epoch ms. */
  startedAt: number;
  /** Epoch ms. */
  endedAt: number;
  /** Always length 4 for 4-player matches. */
  seats: ReplaySeat[];
  /** Replay reducer consumes these the same way the live engine
   * consumes WS `event` frames — same `GameEvent` shape. */
  events: GameEvent[];
  /** Equal to `REPLAY_LOG_SCHEMA_VERSION` at write time. */
  schemaVersion: number;
}

/** Re-export for convenience so adapter code only imports from one place. */
export type { GameEvent };
