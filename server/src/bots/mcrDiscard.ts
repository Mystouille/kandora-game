import {
  mcrAcceptanceTiles,
  mcrShanten,
} from "~/core/mahjong/rules/mcrShanten";
import type { DiscardSource, Tile } from "~/game/rules";

export interface McrBotDiscard {
  tile: Tile;
  discardSource: DiscardSource;
}

export function chooseMcrBotDiscard(input: {
  hand: readonly Tile[];
  drawn: Tile | null;
  meldCount: number;
  random: () => number;
  isDiscardAllowed?: (discard: McrBotDiscard) => boolean;
}): McrBotDiscard {
  const candidates: Array<
    McrBotDiscard & { shanten: number; acceptance: number }
  > = [];
  for (let index = 0; index < input.hand.length; index++) {
    const tile = input.hand[index];
    const discardSource: DiscardSource =
      input.drawn !== null &&
      index === input.hand.length - 1 &&
      tile === input.drawn
        ? "draw"
        : "hand";
    const discard = { tile, discardSource };
    if (input.isDiscardAllowed?.(discard) === false) {
      continue;
    }
    const remaining = input.hand.filter((_, handIndex) => handIndex !== index);
    candidates.push({
      ...discard,
      shanten: mcrShanten(remaining, input.meldCount),
      acceptance: mcrAcceptanceTiles(remaining, input.meldCount).length,
    });
  }
  if (candidates.length === 0) {
    throw new Error("MCR bot has no legal discard");
  }
  const bestShanten = Math.min(
    ...candidates.map((candidate) => candidate.shanten)
  );
  const closest = candidates.filter(
    (candidate) => candidate.shanten === bestShanten
  );
  const bestAcceptance = Math.max(
    ...closest.map((candidate) => candidate.acceptance)
  );
  const best = closest.filter(
    (candidate) => candidate.acceptance === bestAcceptance
  );
  const selected = best[Math.floor(input.random() * best.length)];
  return {
    tile: selected.tile,
    discardSource: selected.discardSource,
  };
}
