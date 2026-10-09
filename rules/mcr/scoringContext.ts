import { scoreMcr, type McrScoreResult } from "../scoring/mcr";
import { windForSeat } from "../seats";
import type { MatchState } from "../state";
import type { Seat, Tile } from "../types";

function sameTile(a: Tile, b: Tile): boolean {
  const normalize = (tile: Tile): string =>
    `${tile[0] === "0" ? "5" : tile[0]}${tile.slice(1)}`;
  return normalize(a) === normalize(b);
}

function isLastCopy(
  state: MatchState,
  winTile: Tile,
  method: "discard" | "self-draw"
): boolean {
  let visible = 0;
  for (const discards of state.discards) {
    visible += discards.filter((tile) => sameTile(tile, winTile)).length;
  }
  for (const melds of state.melds) {
    for (const meld of melds) {
      visible += meld.tiles.filter((tile) => sameTile(tile, winTile)).length;
    }
  }
  if (method === "self-draw") {
    visible++;
  }
  return visible >= 4;
}

export function scoreMcrForState(
  state: MatchState,
  seat: Seat,
  winTile: Tile,
  method: "discard" | "self-draw",
  options: {
    replacementTile?: boolean;
    robbingPromotedKong?: boolean;
  } = {}
): McrScoreResult {
  const hand = [...state.hands[seat]];
  if (method === "self-draw") {
    const winIndex = hand.lastIndexOf(winTile);
    if (winIndex < 0) {
      return {
        isWinningShape: false,
        fans: [],
        totalFan: 0,
        nonFlowerFan: 0,
        meetsMinimum: false,
      };
    }
    hand.splice(winIndex, 1);
  }
  return scoreMcr({
    hand,
    winTile,
    melds: state.melds[seat],
    context: {
      method,
      roundWind: state.roundWind,
      prevalentWind: state.roundWind,
      seatWind: windForSeat(seat, state.dealer, state.ruleSet.playerCount),
      flowerCount: state.flowerTiles[seat].length,
      lastCopy: isLastCopy(state, winTile, method),
      lastTileDraw:
        method === "self-draw" &&
        state.liveWall.length === 0 &&
        !options.replacementTile,
      lastTileClaim:
        method === "discard" &&
        state.liveWall.length === 0 &&
        !options.robbingPromotedKong,
      replacementTile: options.replacementTile,
      robbingPromotedKong: options.robbingPromotedKong,
    },
  });
}

export function isQualifiedMcrScore(
  score: McrScoreResult
): score is Extract<McrScoreResult, { isWinningShape: true }> {
  return score.isWinningShape && score.meetsMinimum;
}
