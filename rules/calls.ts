/**
 * `enumerateCalls` — pure helper that lists every legal call (chi /
 * pon / daiminkan / ron) each non-discarder seat may declare on the
 * tile sitting on the table.
 *
 * The orchestrator uses this to surface chi/pon/kan/ron buttons,
 * open a call-priority window, collect responses, and resolve them
 * before issuing the winning action back into `step()`.
 *
 * Pure (no clones, no mutation of input). Legality predicates mirror
 * the validation already performed inside `step.ts` for each call
 * type, so anything `enumerateCalls` returns is guaranteed to be
 * accepted by the engine in the current state.
 */

import type { MatchState } from "./state";
import { isAkaDisabled } from "./ruleSet";
import { scoreHand } from "./score";
import { isWinningShape } from "./shanten";
import { seatWind } from "./step";
import type { Seat, Tile } from "./types";

export type CallOption =
  | { kind: "chi"; tiles: [Tile, Tile] }
  | { kind: "pon"; tiles: [Tile, Tile] }
  | { kind: "daiminkan"; tiles: [Tile, Tile, Tile] }
  | { kind: "ron" };

export interface SeatCallOptions {
  seat: Seat;
  options: CallOption[];
}

/** Numeric tile value (1–9 for m/p/s, 1–7 for z), treating red 5 as 5. */
function valueOf(tile: Tile): number {
  return Number(tile[0] === "0" ? "5" : tile[0]);
}

/** Same-rank/suit (red 5 and white 5 collapse to one identity). */
function sameRank(a: Tile, b: Tile): boolean {
  return a[1] === b[1] && valueOf(a) === valueOf(b);
}

/**
 * Enumerate every legal call seat-by-seat for the discard sitting on
 * the table. Returns one entry per non-discarder seat that has at
 * least one legal option; seats with no options are omitted.
 *
 * Pre-conditions assumed (mirroring `step.ts`): the engine state is
 * in `awaiting_draw` with a non-null `lastDiscard`. If called from any
 * other phase the result is an empty array.
 */
export function enumerateCalls(state: MatchState): SeatCallOptions[] {
  if (state.phase !== "awaiting_draw" || state.lastDiscard === null) {
    return [];
  }
  const discarder = state.lastDiscard.seat;
  const claimed = state.lastDiscard.tile;
  const out: SeatCallOptions[] = [];
  for (let s = 0; s < 4; s++) {
    const seat = s as Seat;
    if (seat === discarder) {
      continue;
    }
    const options: CallOption[] = [];
    // Riichi locks the hand: no chi/pon/daiminkan allowed (only
    // ron — the in-riichi-ankan case is a self-call after a draw,
    // handled elsewhere).
    const inRiichi = state.riichiDeclared[seat];

    if (!inRiichi && state.liveWall.length > 0) {
      pushChi(state, seat, discarder, claimed, options);
      pushPon(state, seat, claimed, options);
      pushDaiminkan(state, seat, claimed, options);
    }
    pushRon(state, seat, claimed, options);

    if (options.length > 0) {
      out.push({ seat, options });
    }
  }
  return out;
}

function pushChi(
  state: MatchState,
  seat: Seat,
  discarder: Seat,
  claimed: Tile,
  out: CallOption[]
): void {
  // Chi only legal from the seat immediately to the discarder's left.
  if (seat !== (discarder + 1) % 4) {
    return;
  }
  const suit = claimed[1];
  if (suit === "z") {
    return;
  }
  const v = valueOf(claimed);
  // Three possible run shapes for the claimed tile:
  //   v-2, v-1 | claimed   ("ura" left-anchored: claimed is right)
  //   v-1, v+1 | claimed   (kanchan: claimed is middle)
  //   v+1, v+2 | claimed   (claimed is left)
  // For each shape, we need both partner tiles to actually be in
  // the caller's hand. Treat red and normal fives as the same rank
  // when finding a run, but preserve their distinct tile strings
  // when surfacing the available choices.
  const hand = state.hands[seat];
  const handByValue = new Map<number, Tile[]>();
  for (const t of hand) {
    if (t[1] !== suit) {
      continue;
    }
    const tv = valueOf(t);
    const arr = handByValue.get(tv) ?? [];
    arr.push(t);
    handByValue.set(tv, arr);
  }
  const shapes: Array<[number, number]> = [
    [v - 2, v - 1],
    [v - 1, v + 1],
    [v + 1, v + 2],
  ];
  for (const [a, b] of shapes) {
    if (a < 1 || b > 9) {
      continue;
    }
    const aTiles = handByValue.get(a);
    const bTiles = handByValue.get(b);
    if (!aTiles || !bTiles) {
      continue;
    }
    // Duplicate normal copies share the same tile string and do not
    // represent a meaningful choice. A red five ("0X") and normal
    // five ("5X"), however, must produce separate legal actions so
    // the player can decide which one the meld consumes.
    for (const aTile of new Set(aTiles)) {
      for (const bTile of new Set(bTiles)) {
        out.push({ kind: "chi", tiles: [aTile, bTile] });
      }
    }
  }
}

function pushPon(
  state: MatchState,
  seat: Seat,
  claimed: Tile,
  out: CallOption[]
): void {
  const matches: Tile[] = [];
  for (const t of state.hands[seat]) {
    if (sameRank(t, claimed)) {
      matches.push(t);
    }
  }
  if (matches.length < 2) {
    return;
  }
  // Physical red and normal fives are interchangeable by rank but not by
  // value: with 0p,5p,5p the caller may consume either 0p+5p or 5p+5p.
  // Keep red-consuming choices first to preserve the existing default order,
  // while collapsing duplicate physical copies with the same tile string.
  matches.sort(
    (a, b) => Number(b[0] === "0") - Number(a[0] === "0")
  );
  const seen = new Set<string>();
  for (let first = 0; first < matches.length - 1; first += 1) {
    for (let second = first + 1; second < matches.length; second += 1) {
      const tiles = [matches[first], matches[second]] as [Tile, Tile];
      const key = tiles.join(",");
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      out.push({ kind: "pon", tiles });
    }
  }
}

function pushDaiminkan(
  state: MatchState,
  seat: Seat,
  claimed: Tile,
  out: CallOption[]
): void {
  const matches: Tile[] = [];
  for (const t of state.hands[seat]) {
    if (sameRank(t, claimed)) {
      matches.push(t);
    }
  }
  if (matches.length < 3) {
    return;
  }
  out.push({
    kind: "daiminkan",
    tiles: [matches[0], matches[1], matches[2]],
  });
}

function pushRon(
  state: MatchState,
  seat: Seat,
  claimed: Tile,
  out: CallOption[]
): void {
  // Furiten check (mirrors `isFuritenForRon` in step.ts):
  //   - permanent (riichi) missed-ron lock blocks all rons.
  //   - temporary missed-ron lock blocks all rons until the seat's
  //     next discard.
  //   - any wait tile sitting in own discards blocks all rons.
  if (state.furitenLocked[seat] || state.furitenTemp[seat]) {
    return;
  }
  // Fast shape gate: if `claimed` doesn't even complete the hand,
  // skip the expensive `scoreHand` call entirely. This is the hot
  // path — runs after every discard for every non-discarder seat.
  if (!isWinningShape(state.hands[seat], state.melds[seat], claimed)) {
    return;
  }
  const ownDiscards = state.discards[seat];
  if (ownDiscards.length > 0) {
    const seen = new Set<string>();
    for (const d of ownDiscards) {
      const key = (d[0] === "0" ? "5" : d[0]) + d[1];
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      const probe = (key[0] + key[1]) as Tile;
      // Same shape gate for the furiten probe.
      if (!isWinningShape(state.hands[seat], state.melds[seat], probe)) {
        continue;
      }
      const probeScore = scoreHand({
        hand: state.hands[seat],
        winTile: probe,
        tsumo: false,
        roundWind: state.roundWind,
        seatWind: seatWind(seat, state.dealer),
        doraIndicators: state.doraIndicators,
        uraDoraIndicators:
          state.ruleSet.uraDora && state.riichiDeclared[seat]
            ? state.uraDoraIndicators
            : undefined,
        riichi: state.riichiDeclared[seat],
        doubleRiichi: state.doubleRiichi[seat],
        ippatsu: state.ippatsuEligible[seat],
        melds: state.melds[seat],
        noKuitan: !state.ruleSet.kuitan,
        noAka: isAkaDisabled(state.ruleSet),
        haiteiOrHoutei: state.liveWall.length === 0,
      });
      if (
        probeScore.isAgari &&
        (probeScore.han > 0 || probeScore.yakumanCount > 0)
      ) {
        return;
      }
    }
  }
  const score = scoreHand({
    hand: state.hands[seat],
    winTile: claimed,
    tsumo: false,
    roundWind: state.roundWind,
    seatWind: seatWind(seat, state.dealer),
    doraIndicators: state.doraIndicators,
    uraDoraIndicators:
      state.ruleSet.uraDora && state.riichiDeclared[seat]
        ? state.uraDoraIndicators
        : undefined,
    riichi: state.riichiDeclared[seat],
    doubleRiichi: state.doubleRiichi[seat],
    ippatsu: state.ippatsuEligible[seat],
    melds: state.melds[seat],
    noKuitan: !state.ruleSet.kuitan,
    noAka: isAkaDisabled(state.ruleSet),
    haiteiOrHoutei: state.liveWall.length === 0,
  });
  if (score.isAgari && (score.han > 0 || score.yakumanCount > 0)) {
    out.push({ kind: "ron" });
  }
}
