/**
 * RandomBot — picks a random tile from its hand to discard.
 *
 * Phase 0.5 placeholder. The interface matches the rules-engine
 * signature `(state) => action` so the Phase 5 bot work can swap it
 * out without touching `MatchProcess`.
 */
import type { Tile } from "~/game/rules";
import type { DiscardSource } from "~/game/rules";

export interface RandomBotInput {
  hand: Tile[];
  /** The tile the bot just drew (must be in `hand`). */
  drawn: Tile | null;
}

export interface RandomBotDiscard {
  tile: Tile;
  /** True when the bot discards exactly the tile it just drew. */
  tsumogiri: boolean;
  discardSource: DiscardSource;
}

export function randomBotDiscard(input: RandomBotInput): RandomBotDiscard {
  const { hand, drawn } = input;
  if (hand.length === 0) {
    throw new Error("RandomBot: empty hand");
  }
  const idx = Math.floor(Math.random() * hand.length);
  const tile = hand[idx];
  const tsumogiri =
    drawn !== null && idx === hand.length - 1 && tile === drawn;
  return {
    tile,
    tsumogiri,
    discardSource: tsumogiri ? "draw" : "hand",
  };
}
