/**
 * Bot call policy — decides whether a bot should claim a discard
 * with chi / pon / daiminkan, and whether to declare an
 * ankan / shouminkan on its own turn.
 *
 * Slice policy (intentionally conservative):
 *   - **Ron** is handled separately by the orchestrator.
 *   - **Pon / Daiminkan**: take only on a *yakuhai* tile — the
 *     seat's own seat wind, the current round wind, or any dragon
 *     (5z / 6z / 7z). These pons are strictly hand-improving (they
 *     guarantee a yaku) so the bot can't accidentally tank its own
 *     hand.
 *   - **Chi**: never. Open chi without a clear plan loses tempo and
 *     yaku; not worth the slice.
 *   - When both pon and daiminkan are offered for the same yakuhai
 *     tile, prefer pon (kan complicates the hand for marginal value
 *     in the slice).
 *   - **Self-kans (own turn)**:
 *       · **Shouminkan**: declare iff the underlying pon was a
 *         yakuhai pon (same yakuhai filter). Always strictly
 *         improving.
 *       · **Ankan**: declare iff the four-of-a-kind is yakuhai
 *         (own seat wind, round wind, or any dragon). Skipping
 *         numbered ankans avoids tearing apart shapes the bot
 *         doesn't reason about. The engine still enforces the
 *         riichi-ankan-legality predicate at apply time.
 */

import type { CallOption } from "~/game/rules/calls";
import type { MatchState } from "~/game/rules/state";
import { seatWind } from "~/game/rules";
import type { Seat, Tile } from "~/game/rules";

const DRAGONS: ReadonlySet<string> = new Set(["5z", "6z", "7z"]);

const WIND_TILES: Record<string, Tile> = {
  E: "1z",
  S: "2z",
  W: "3z",
  N: "4z",
};

/**
 * `true` when `tile` is a yakuhai for `seat` given the round wind
 * (own seat wind, round wind, or any dragon).
 */
function isYakuhaiFor(tile: Tile, seat: Seat, state: MatchState): boolean {
  if (DRAGONS.has(tile)) {
    return true;
  }
  if (tile === WIND_TILES[state.roundWind]) {
    return true;
  }
  const wind = seatWind(seat, state.dealer);
  if (tile === WIND_TILES[wind]) {
    return true;
  }
  return false;
}

export function chooseBotCall(
  state: MatchState,
  seat: Seat,
  options: readonly CallOption[]
): CallOption | null {
  const claimed = state.lastDiscard?.tile;
  if (claimed === undefined) {
    return null;
  }
  if (!isYakuhaiFor(claimed, seat, state)) {
    return null;
  }
  const pon = options.find((o) => o.kind === "pon");
  if (pon) {
    return pon;
  }
  const daiminkan = options.find((o) => o.kind === "daiminkan");
  if (daiminkan) {
    return daiminkan;
  }
  return null;
}

/** A self-kan declaration the bot intends to make on its own turn. */
export type BotSelfKan =
  | { kind: "ankan"; tile: Tile }
  | { kind: "shouminkan"; tile: Tile };

/**
 * Decide whether `seat` (currently in `awaiting_discard`) should
 * declare an ankan or shouminkan instead of discarding. Yakuhai
 * filter: only kans on the bot's own seat wind, the round wind, or
 * any dragon. Returns the first declarable kan or `null`.
 *
 * The engine still validates the declaration on apply (riichi
 * ankan legality, ownership of the matching pon, etc.); this
 * function is concerned with policy, not legality.
 */
export function chooseBotSelfKan(
  state: MatchState,
  seat: Seat
): BotSelfKan | null {
  if (state.phase !== "awaiting_discard") {
    return null;
  }
  // Kan is only legal immediately after a draw (live wall or
  // rinshan), never after a chi/pon. The engine enforces this;
  // skip surfacing kan to the bot to avoid a rejected action.
  if (state.lastDrawn[seat] === null) {
    return null;
  }
  // Group hand tiles by canonical key (red 5 collapsed to 5).
  const counts = new Map<string, Tile[]>();
  for (const tile of state.hands[seat]) {
    const key = (tile[0] === "0" ? "5" : tile[0]) + tile[1];
    const arr = counts.get(key) ?? [];
    arr.push(tile);
    counts.set(key, arr);
  }
  // Shouminkan: any owned pon whose tile sits in hand. Only yakuhai
  // pons qualify under slice policy.
  if (!state.riichiDeclared[seat]) {
    for (const meld of state.melds[seat]) {
      if (meld.type !== "pon") {
        continue;
      }
      const t = meld.tiles[0];
      if (!isYakuhaiFor(t, seat, state)) {
        continue;
      }
      const key = (t[0] === "0" ? "5" : t[0]) + t[1];
      const inHand = counts.get(key);
      if (inHand && inHand.length >= 1) {
        return { kind: "shouminkan", tile: inHand[0] };
      }
    }
  }
  // Ankan: any group of 4 in hand whose canonical tile is yakuhai.
  for (const [, group] of counts) {
    if (group.length < 4) {
      continue;
    }
    if (!isYakuhaiFor(group[0], seat, state)) {
      continue;
    }
    return { kind: "ankan", tile: group[0] };
  }
  return null;
}
