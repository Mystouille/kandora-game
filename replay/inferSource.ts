/**
 * Infer the {@link ReplaySource} for a raw `sourceGameId` by inspecting
 * its shape.
 *
 * Phase 4.5 originally routed replays at `/replays/:source/:gameId` so
 * the loader could query the `ReplayLog` collection by `(source,
 * sourceGameId)`. The four supported platforms happen to mint IDs in
 * pairwise-disjoint formats, so the `:source` segment is redundant —
 * we can recover it from the ID alone and route at `/replays/:gameId`.
 *
 * Shapes recognized (case-insensitive where relevant):
 *
 *   - `tenhou`     — contains the literal `gm-` (e.g.
 *                    `2026041906gm-0089-0000-fdd90b73`).
 *   - `majsoul`    — `YYMMDD-<uuid>` (e.g.
 *                    `250913-638affa1-cee0-4aee-869b-69b9cb40c983`).
 *                    The viewer-id suffix `_a<n>` is stripped by the
 *                    connector layer before it reaches us; we don't
 *                    accept it here.
 *   - `riichicity` — 20 lowercase alphanumerics (cuid-style, e.g.
 *                    `cknnf9eai08auidimj2g`). The `@<n>` shard suffix
 *                    is stripped upstream.
 *   - `ingame`     — 24 lowercase hex (Mongo ObjectId).
 *
 * Returns `null` when the shape matches none of the above — callers
 * should treat that as "look up by `sourceGameId` only" rather than
 * 404 immediately, so debug / hand-crafted IDs still resolve when
 * a unique row exists.
 */
import type { ReplaySource } from "./types";

const TENHOU_RE = /gm-/i;
const MAJSOUL_RE =
  /^\d{6}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RIICHICITY_RE = /^[a-z0-9]{20}$/;
const INGAME_RE = /^[a-f0-9]{24}$/i;

export function inferReplaySource(gameId: string): ReplaySource | null {
  if (!gameId) {
    return null;
  }
  // Tenhou check runs first because its `gm-` infix can't collide
  // with the other (anchored) regexes.
  if (TENHOU_RE.test(gameId)) {
    return "tenhou";
  }
  if (MAJSOUL_RE.test(gameId)) {
    return "majsoul";
  }
  if (INGAME_RE.test(gameId)) {
    return "ingame";
  }
  if (RIICHICITY_RE.test(gameId)) {
    return "riichicity";
  }
  return null;
}
