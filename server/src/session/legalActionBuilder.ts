import type { LegalAction, Seat } from "~/game/protocol/messages";
import {
  isDiscardForbiddenByKuikae,
  step,
  type DiscardSource,
  type MatchState,
  type Tile,
} from "~/game/rules";
import type { MatchDriver } from "../match-drivers/matchDriver";

export function buildDiscardLegals(
  state: MatchState,
  driver: MatchDriver,
  seat: Seat
): LegalAction[] {
  const out: LegalAction[] = [];
  const pushDiscardIfLegal = (
    tile: Tile,
    discardSource: DiscardSource
  ): void => {
    if (isDiscardForbiddenByKuikae(state, seat, tile)) {
      return;
    }
    out.push({
      id: `discard:${discardSource}:${tile}`,
      type: "discard",
      tile,
      discardSource,
    });
  };
  const inRiichi = state.riichiDeclared[seat];
  if (inRiichi) {
    // Riichi locks the discard: the drawn tile must be discarded
    // tsumogiri. Only declarations that don't break tenpai
    // (tsumo, in-riichi-legal ankan) interrupt that flow. The
    // single discard option corresponds to `lastDrawn[seat]`; the
    // turn auto-resolves it from `advanceTurn` when no win/kan is
    // chosen.
    const drawn = state.lastDrawn[seat];
    if (drawn !== null) {
      pushDiscardIfLegal(drawn, "draw");
    }
  } else {
    const hand = state.hands[seat];
    const drawn = state.lastDrawn[seat];
    if (drawn !== null && hand[hand.length - 1] === drawn) {
      pushDiscardIfLegal(drawn, "draw");
    }
    // One hand-source action per unique tile, excluding the
    // appended drawn slot. A duplicate drawn value therefore
    // has both a hand action and a draw action.
    const seen = new Set<string>();
    const handEnd = drawn !== null ? hand.length - 1 : hand.length;
    for (let index = 0; index < handEnd; index++) {
      const tile = hand[index];
      if (seen.has(tile)) {
        continue;
      }
      seen.add(tile);
      pushDiscardIfLegal(tile, "hand");
    }
  }
  // Tsumo: if `step` accepts a tsumo declaration for this seat,
  // surface it. The engine returns an empty event list for a
  // non-agari hand (noop), so a non-zero event count means the
  // current 14-tile hand is winning.
  const tsumoProbe = step(state, { type: "tsumo", seat });
  if (tsumoProbe.events.length > 0) {
    out.push({ id: "tsumo", type: "tsumo" });
  }
  // Self-call kans (ankan / shouminkan). The engine itself
  // rejects in-riichi shouminkan and any ankan that would change
  // the wait shape, so we can safely surface its accepted set.
  for (const opt of buildSelfKanLegals(state, driver, seat)) {
    out.push(opt);
  }
  if (inRiichi) {
    return out;
  }
  // Riichi: enumerate the discardable tiles whose post-discard
  // 13-tile hand leaves the seat in tenpai. The engine's `step`
  // returns an empty event list when the riichi declaration is
  // rejected (already declared, cannot cover the stick under bust
  // rules, < 4 wall, open hand, hand not tenpai after discard,
  // etc.), so a non-zero event
  // count is sufficient to surface the option.
  if (!state.riichiDeclared[seat]) {
    const discardChoices = out.filter(
      (action) => action.type === "discard" && action.tile
    );
    const riichiChoices = [...discardChoices].sort((left, right) => {
      if (left.discardSource === right.discardSource) {
        return 0;
      }
      return left.discardSource === "draw" ? 1 : -1;
    });
    for (const choice of riichiChoices) {
      const tile = choice.tile as Tile;
      const probe = step(state, {
        type: "riichi",
        seat,
        tile,
        discardSource: choice.discardSource,
      });
      if (probe.events.length > 0) {
        out.push({
          id: `riichi:${choice.discardSource ?? "hand"}:${tile}`,
          type: "riichi",
          tile,
          discardSource: choice.discardSource,
        });
      }
    }
  }
  return out;
}

export function buildSelfKanLegals(
  state: MatchState,
  driver: MatchDriver,
  seat: Seat
): LegalAction[] {
  const out: LegalAction[] = [];
  if (state.phase !== "awaiting_discard") {
    return out;
  }
  if (state.liveWall.length === 0) {
    return out;
  }
  if (!driver.canSupplyReplacement(seat)) {
    return out;
  }
  if (state.lastDrawn[seat] === null) {
    return out;
  }
  // Group hand tiles by canonical key (red 5 collapsed to 5).
  const counts = new Map<string, Tile[]>();
  for (const tile of state.hands[seat]) {
    const key = (tile[0] === "0" ? "5" : tile[0]) + tile[1];
    const arr = counts.get(key) ?? [];
    arr.push(tile);
    counts.set(key, arr);
  }
  // Ankan: any group with 4 copies.
  for (const [, group] of counts) {
    if (group.length >= 4) {
      const t = group[0];
      const replacement = driver.peekDraw(seat);
      const probe = step(state, {
        type: "kan",
        seat,
        kind: "ankan",
        tile: t,
        ...(replacement.kind === "tile"
          ? { replacementTile: replacement.tile }
          : {}),
      });
      if (probe.events.length === 0) {
        continue;
      }
      out.push({
        id: `kan:ankan:${t}`,
        type: "kan",
        kanKind: "ankan",
        tiles: [group[0], group[1], group[2]],
      });
    }
  }
  // Shouminkan: existing open pon owned by `seat` whose canonical
  // key matches a tile in hand. Riichi locks out shouminkan
  // declarations entirely.
  if (!state.riichiDeclared[seat]) {
    for (const meld of state.melds[seat]) {
      if (meld.type !== "pon") {
        continue;
      }
      const t = meld.tiles[0];
      const key = (t[0] === "0" ? "5" : t[0]) + t[1];
      const inHand = counts.get(key);
      if (inHand && inHand.length >= 1) {
        out.push({
          id: `kan:shouminkan:${inHand[0]}`,
          type: "kan",
          kanKind: "shouminkan",
          tiles: [inHand[0]],
        });
      }
    }
  }
  return out;
}
