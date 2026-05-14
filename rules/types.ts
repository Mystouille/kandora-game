/**
 * Pure types for the mahjong rules engine.
 *
 * `Tile` is a string in the same notation used on the wire (see
 * `app/game/protocol/messages.ts`):
 *   - suited:  `${1-9}${m|p|s}`, plus `0${m|p|s}` for red fives
 *   - honors:  `${1-7}z` — 1z..4z winds (E/S/W/N), 5z..7z dragons
 *               (haku, hatsu, chun)
 *
 * The wire format owns the Zod regex; the rules engine owns the
 * structural type and the canonical tile constants. Keeping `Tile`
 * a plain string lets rules and protocol share values without one
 * importing the other.
 */

export type Tile = string;

export type Seat = 0 | 1 | 2 | 3;

/** Round wind / seat wind enum (1z..4z). */
export type Wind = "E" | "S" | "W" | "N";

export const SEATS: readonly Seat[] = [0, 1, 2, 3] as const;

export const WIND_TILES: Record<Wind, Tile> = {
  E: "1z",
  S: "2z",
  W: "3z",
  N: "4z",
};

export const DRAGON_TILES = ["5z", "6z", "7z"] as const; // haku, hatsu, chun

export const SUITS = ["m", "p", "s"] as const;
export type Suit = (typeof SUITS)[number];

/**
 * Canonical tile-string sort comparator: man < pin < sou < honors,
 * numeric within suit, red five (`0X`) sorts as 5.
 */
export function compareTiles(a: Tile, b: Tile): number {
  const sa = a[a.length - 1];
  const sb = b[b.length - 1];
  if (sa !== sb) {
    const order = "mpsz";
    return order.indexOf(sa) - order.indexOf(sb);
  }
  const na = a[0] === "0" ? 5 : Number(a[0]);
  const nb = b[0] === "0" ? 5 : Number(b[0]);
  if (na !== nb) {
    return na - nb;
  }
  // Stable: real 5 before red 5 of same suit.
  return a[0] === "0" ? 1 : b[0] === "0" ? -1 : 0;
}
