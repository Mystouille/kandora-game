/* eslint no-redeclare: "off", "@typescript-eslint/no-redeclare": "error" */
import type { MatchView } from "./store";
import type { PlayerCount, Seat } from "~/game/protocol/seat";
import type { Wind } from "~/game/rules/types";
import { windForSeat } from "~/game/rules/seats";

export type TableSlots<T> = [T, T, T, T];

export interface TableProjection {
  playerCount: PlayerCount;
  focus: Seat;
  /** The absent physical side is explicit; it is not a fourth participant. */
  slots: TableSlots<{ seat: Seat; wind: Wind } | null>;
}

/** Render-only arrays are indexed by physical side, unlike raw MatchView arrays. */
export interface TableMatchView extends MatchView {
  tableProjection: TableProjection;
}

export function tablePositionForSeat(seat: Seat, focus: Seat): Seat {
  return ((seat - focus + 4) % 4) as Seat;
}

export function logicalSeatForPosition(
  position: Seat,
  focus: Seat,
  playerCount: PlayerCount
): Seat | null {
  const seat = ((position + focus) % 4) as Seat;
  return seat < playerCount ? seat : null;
}

export function createTableProjection(
  playerCount: PlayerCount,
  focus: Seat,
  dealer: Seat
): TableProjection {
  if (focus >= playerCount || dealer >= playerCount) {
    throw new Error("Cannot focus or deal an inactive seat");
  }
  const slot = (position: Seat) => {
    const seat = logicalSeatForPosition(position, focus, playerCount);
    return seat === null
      ? null
      : { seat, wind: windForSeat(seat, dealer, playerCount) };
  };
  return { playerCount, focus, slots: [slot(0), slot(1), slot(2), slot(3)] };
}

export function isTableSeatActive(
  view: Pick<MatchView, "playerCount" | "tableProjection">,
  position: number
): boolean {
  return view.tableProjection
    ? view.tableProjection.slots[position] != null
    : position >= 0 && position < (view.playerCount ?? 4);
}

export function tableSeatWind(
  view: Pick<MatchView, "playerCount" | "tableProjection" | "dealer">,
  position: Seat,
  dealer: Seat = view.dealer
): Wind | null {
  if (!isTableSeatActive(view, position)) {
    return null;
  }
  const projection = view.tableProjection;
  if (!projection) {
    return windForSeat(position, dealer, view.playerCount ?? 4);
  }
  if (dealer === view.dealer) {
    return projection.slots[position]?.wind ?? null;
  }
  const seat = projection.slots[position]?.seat;
  const absoluteDealer = projection.slots[dealer]?.seat;
  return seat !== undefined && absoluteDealer !== undefined
    ? windForSeat(seat, absoluteDealer, projection.playerCount)
    : null;
}

export function rotateSeatValues<T>(
  values: readonly [T, T, T, T],
  focus: Seat
): TableSlots<T>;
export function rotateSeatValues<T>(
  values: readonly T[],
  focus: Seat,
  empty: T
): TableSlots<T>;
export function rotateSeatValues<T>(
  values: readonly T[],
  focus: Seat
): TableSlots<T | null>;
export function rotateSeatValues<T>(
  values: readonly T[],
  focus: Seat,
  empty: T | null = null
): TableSlots<T | null> {
  const at = (side: number) => values[(side + focus) % 4] ?? empty;
  return [at(0), at(1), at(2), at(3)];
}

export function rotateHandResult(
  result: NonNullable<MatchView["lastHandResult"]>,
  focus: Seat
): NonNullable<MatchView["lastHandResult"]> {
  const rot = (seat: Seat) => tablePositionForSeat(seat, focus);
  return {
    ...result,
    dealer: result.dealer != null ? rot(result.dealer) : result.dealer,
    delta: result.delta
      ? rotateSeatValues(result.delta, focus, 0)
      : result.delta,
    tenpai: result.tenpai
      ? rotateSeatValues(result.tenpai, focus, false)
      : result.tenpai,
    nagashi: result.nagashi
      ? rotateSeatValues(result.nagashi, focus, false)
      : result.nagashi,
    scores: result.scores
      ? rotateSeatValues(result.scores, focus, 0)
      : result.scores,
    waits: result.waits
      ? rotateSeatValues(result.waits, focus, null)
      : result.waits,
    tenpaiHands: result.tenpaiHands
      ? rotateSeatValues(result.tenpaiHands, focus, null)
      : result.tenpaiHands,
    declarations: result.declarations?.map((declaration) => ({
      ...declaration,
      seat: rot(declaration.seat),
    })),
    wins: result.wins?.map((win) => ({
      ...win,
      seat: rot(win.seat),
      loser: win.loser != null ? rot(win.loser) : win.loser,
      melds: win.melds?.map((meld) => ({
        ...meld,
        from: meld.from != null ? rot(meld.from) : meld.from,
      })),
    })),
    buuChombo: result.buuChombo
      ? {
          ...result.buuChombo,
          seat: rot(result.buuChombo.seat),
          chipDelta: rotateSeatValues(result.buuChombo.chipDelta, focus, 0),
          chips: rotateSeatValues(result.buuChombo.chips, focus, 0),
        }
      : result.buuChombo,
  };
}

/** Quarter-turn projection. Logical winds are computed before moving any seats. */
export function rotateMatchView(view: MatchView, focus: Seat): TableMatchView {
  if (view.tableProjection) {
    if (view.tableProjection.focus === focus) {
      return view as TableMatchView;
    }
    throw new Error("Project raw match state, not an already projected table");
  }
  const projection = createTableProjection(
    view.playerCount ?? 4,
    focus,
    view.dealer
  );
  const rot = (seat: Seat) => tablePositionForSeat(seat, focus);
  const window = (value: MatchView["actionWindow"]) =>
    value
      ? { ...value, seat: value.seat === null ? null : rot(value.seat) }
      : value;
  return {
    ...view,
    tableProjection: projection,
    mySeat: 0,
    hands: rotateSeatValues(view.hands, focus, []),
    melds: rotateSeatValues(view.melds, focus, []).map((melds) =>
      melds.map((meld) => ({
        ...meld,
        from: meld.from != null ? rot(meld.from) : meld.from,
      }))
    ),
    discards: rotateSeatValues(view.discards, focus, []),
    discardTsumogiri: rotateSeatValues(view.discardTsumogiri, focus, []),
    discardSources: view.discardSources
      ? rotateSeatValues(view.discardSources, focus, [])
      : view.discardSources,
    discardOrdinals: rotateSeatValues(view.discardOrdinals, focus, []),
    nukiTiles: view.nukiTiles
      ? rotateSeatValues(view.nukiTiles, focus, [])
      : undefined,
    flowerTiles: view.flowerTiles
      ? rotateSeatValues(view.flowerTiles, focus, [])
      : undefined,
    pendingNuki: view.pendingNuki
      ? { ...view.pendingNuki, seat: rot(view.pendingNuki.seat) }
      : null,
    pendingFlower: view.pendingFlower
      ? { ...view.pendingFlower, seat: rot(view.pendingFlower.seat) }
      : null,
    liveDrawSchedule: view.liveDrawSchedule?.map(rot) ?? null,
    duplicateWallState: view.duplicateWallState
      ? {
          ...view.duplicateWallState,
          initial: rotateSeatValues(view.duplicateWallState.initial, focus, 0),
          remaining: rotateSeatValues(
            view.duplicateWallState.remaining,
            focus,
            0
          ),
          limitingSeat:
            view.duplicateWallState.limitingSeat !== null
              ? rot(view.duplicateWallState.limitingSeat)
              : null,
        }
      : null,
    duplicateDrawQueues: view.duplicateDrawQueues
      ? rotateSeatValues(view.duplicateDrawQueues, focus, [])
      : null,
    scores: rotateSeatValues(view.scores, focus, 0),
    seatNames: view.seatNames
      ? rotateSeatValues(view.seatNames, focus, "")
      : null,
    dealer: rot(view.dealer),
    turn: view.turn !== undefined ? rot(view.turn) : undefined,
    riichiDeclared: rotateSeatValues(view.riichiDeclared, focus, false),
    ryuukyokuDeclarations: rotateSeatValues(
      view.ryuukyokuDeclarations,
      focus,
      null
    ),
    ryuukyokuTenpaiHands: rotateSeatValues(
      view.ryuukyokuTenpaiHands,
      focus,
      null
    ),
    riichiTileIdx: rotateSeatValues(view.riichiTileIdx, focus, null),
    sinking: rotateSeatValues(view.sinking, focus, false),
    chips: rotateSeatValues(view.chips, focus, 0),
    dabuken: rotateSeatValues(view.dabuken, focus, false),
    furiten: rotateSeatValues(view.furiten, focus, false),
    currentWaits: view.currentWaits
      ? rotateSeatValues(view.currentWaits, focus, [])
      : null,
    lastHandResult: view.lastHandResult
      ? rotateHandResult(view.lastHandResult, focus)
      : null,
    freshlyDrawnSeat:
      view.freshlyDrawnSeat !== null ? rot(view.freshlyDrawnSeat) : null,
    freshlyDiscardedSeat:
      view.freshlyDiscardedSeat !== null
        ? rot(view.freshlyDiscardedSeat)
        : null,
    pendingDiscard: view.pendingDiscard
      ? { ...view.pendingDiscard, seat: rot(view.pendingDiscard.seat) }
      : null,
    actionWindow: window(view.actionWindow),
    promptWindow: window(view.promptWindow),
    readyCheck: view.readyCheck
      ? {
          ...view.readyCheck,
          acked: rotateSeatValues(view.readyCheck.acked, focus, false),
        }
      : null,
    matchEnded: view.matchEnded
      ? {
          ...view.matchEnded,
          finalScores: view.matchEnded.finalScores.map((score) => ({
            ...score,
            seat: rot(score.seat),
          })),
          ...(view.matchEnded.chips
            ? { chips: rotateSeatValues(view.matchEnded.chips, focus, 0) }
            : {}),
          ...(view.matchEnded.dabuken
            ? {
                dabuken: rotateSeatValues(
                  view.matchEnded.dabuken,
                  focus,
                  false
                ),
              }
            : {}),
          ...(view.matchEnded.chipsDelta
            ? {
                chipsDelta: rotateSeatValues(
                  view.matchEnded.chipsDelta,
                  focus,
                  0
                ),
              }
            : {}),
        }
      : null,
    roomState: view.roomState
      ? {
          ...view.roomState,
          mySeat:
            view.roomState.mySeat != null ? rot(view.roomState.mySeat) : null,
          hostSeat:
            view.roomState.hostSeat != null
              ? rot(view.roomState.hostSeat)
              : null,
          seats: view.roomState.seats
            .filter((seat) => seat.seat < projection.playerCount)
            .map((seat) => ({ ...seat, seat: rot(seat.seat) }))
            .sort((left, right) => left.seat - right.seat),
        }
      : null,
  };
}
