/**
 * Ankan-during-riichi legality.
 *
 * Standard rule: a riichi seat may declare ankan only if doing so
 * does not eliminate ANY winning interpretation of the tenpai hand.
 *
 * Equivalently: across every (winning-tile `w`, decomposition of the
 * 14-tile hand `hand13 + w` into pair + 4 melds), the 3 pre-drawn
 * copies of the kan tile must always appear together as a concealed
 * triplet meld — never split into a run, and the kan tile must
 * never be the pair.
 *
 * Counterexample handled here:
 *
 *   `11122333p99m789s` (waits {2p, 9m}).
 *
 *   Reading A: `111p 22p 333p / 99m / 789s` (shanpon).
 *   Reading B: `123p 123p 13p / 99m / 789s` (kanchan on 2p).
 *
 *   The wait set is the same in both, but declaring kan on 1p (or
 *   3p) after the draw destroys reading B — so this function
 *   returns `false` for `kanTile = "1p" | "3p"`.
 */

import type { Tile } from "./types";
import {
  countsFromTiles,
  tileToIndex,
  waits,
  type HandCounts,
} from "./shanten";

type SuitMeld = { kind: "triplet" | "run"; start: number };

/**
 * Yield every way to fully partition `counts` into melds. A meld is
 * a triplet (3 identical) or a run (3 consecutive, suits only).
 *
 * Mutates `counts` while iterating; always restores it before yielding.
 */
function* enumSuitDecomps(
  counts: number[],
  isHonor: boolean,
  start = 0
): Generator<SuitMeld[]> {
  let i = start;
  while (i < counts.length && counts[i] === 0) {
    i++;
  }
  if (i >= counts.length) {
    yield [];
    return;
  }
  if (counts[i] >= 3) {
    counts[i] -= 3;
    for (const rest of enumSuitDecomps(counts, isHonor, i)) {
      yield [{ kind: "triplet", start: i }, ...rest];
    }
    counts[i] += 3;
  }
  if (
    !isHonor &&
    i <= 6 &&
    counts[i] >= 1 &&
    counts[i + 1] >= 1 &&
    counts[i + 2] >= 1
  ) {
    counts[i]--;
    counts[i + 1]--;
    counts[i + 2]--;
    for (const rest of enumSuitDecomps(counts, isHonor, i)) {
      yield [{ kind: "run", start: i }, ...rest];
    }
    counts[i]++;
    counts[i + 1]++;
    counts[i + 2]++;
  }
}

function suitDecomposable(
  counts: readonly number[],
  isHonor: boolean
): boolean {
  const work = [...counts];
  for (const _ of enumSuitDecomps(work, isHonor)) {
    return true;
  }
  return false;
}

function hasSuitDecompWithRunCovering(
  counts: readonly number[],
  kanIdx: number
): boolean {
  const work = [...counts];
  for (const decomp of enumSuitDecomps(work, false)) {
    for (const meld of decomp) {
      if (
        meld.kind === "run" &&
        kanIdx >= meld.start &&
        kanIdx <= meld.start + 2
      ) {
        return true;
      }
    }
  }
  return false;
}

function allSuitsDecomposable(counts: HandCounts): boolean {
  return (
    suitDecomposable(counts.m, false) &&
    suitDecomposable(counts.p, false) &&
    suitDecomposable(counts.s, false) &&
    suitDecomposable(counts.z, true)
  );
}

/**
 * Does any pair-and-melds decomposition of `counts` use the kan
 * tile (`kanSuit`, `kanIdx`) in a non-triplet position — i.e. as
 * the pair, or inside a run?
 */
function existsBadDecomp(
  counts: HandCounts,
  kanSuit: "m" | "p" | "s" | "z",
  kanIdx: number
): boolean {
  const suits = ["m", "p", "s", "z"] as const;
  for (const pSuit of suits) {
    const isHonor = pSuit === "z";
    const len = isHonor ? 7 : 9;
    for (let pi = 0; pi < len; pi++) {
      if (counts[pSuit][pi] < 2) {
        continue;
      }
      counts[pSuit][pi] -= 2;

      const pairIsKan = pSuit === kanSuit && pi === kanIdx;

      if (pairIsKan) {
        if (allSuitsDecomposable(counts)) {
          counts[pSuit][pi] += 2;
          return true;
        }
      } else if (kanSuit !== "z") {
        // Need every non-kan suit decomposable AND the kan suit to
        // have a decomposition that places a run on `kanIdx`.
        // (`kanSuit` is narrowed to "m"|"p"|"s" here.)
        const nonKanOK =
          (kanSuit === "m" || suitDecomposable(counts.m, false)) &&
          (kanSuit === "p" || suitDecomposable(counts.p, false)) &&
          (kanSuit === "s" || suitDecomposable(counts.s, false)) &&
          suitDecomposable(counts.z, true);
        if (nonKanOK && hasSuitDecompWithRunCovering(counts[kanSuit], kanIdx)) {
          counts[pSuit][pi] += 2;
          return true;
        }
      }
      counts[pSuit][pi] += 2;
    }
  }
  return false;
}

/**
 * Returns `true` iff calling ankan on `kanTile` is legal for a seat
 * in riichi holding `hand13` (the 13-tile concealed hand) plus the
 * drawn 4th copy of `kanTile`.
 *
 * Preconditions enforced:
 *   - `hand13` contains exactly 3 copies of `kanTile`.
 *   - `hand13` is tenpai (at least one wait).
 */
export function isAnkanLegalDuringRiichi(
  hand13: readonly Tile[],
  kanTile: Tile
): boolean {
  const counts = countsFromTiles(hand13);
  const { suit: kanSuit, index: kanIdx } = tileToIndex(kanTile);
  if (counts[kanSuit][kanIdx] !== 3) {
    return false;
  }
  const waitSet = waits(hand13);
  if (waitSet.length === 0) {
    return false;
  }
  for (const w of waitSet) {
    const { suit: wSuit, index: wIdx } = tileToIndex(w);
    if (counts[wSuit][wIdx] >= 4) {
      continue;
    }
    counts[wSuit][wIdx]++;
    const bad = existsBadDecomp(counts, kanSuit, kanIdx);
    counts[wSuit][wIdx]--;
    if (bad) {
      return false;
    }
  }
  return true;
}
