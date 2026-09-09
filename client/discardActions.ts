import type { LegalAction, Seat } from "~/game/protocol/messages";

export type DiscardSource = NonNullable<LegalAction["discardSource"]>;

export interface AutoDiscardWindowIdentity {
  matchId: string | null;
  seat: Seat;
  lastSeq: number;
  actionDeadline: number | null;
  actionId: string;
}

export function isCurrentAutoDiscardWindow(
  state: {
    matchId: string | null;
    mySeat: Seat | null;
    lastSeq: number;
    actionDeadline: number | null;
    freshlyDrawnSeat: Seat | null;
    legalActions: readonly LegalAction[];
  },
  expected: AutoDiscardWindowIdentity
): boolean {
  return (
    state.matchId === expected.matchId &&
    state.mySeat === expected.seat &&
    state.lastSeq === expected.lastSeq &&
    state.actionDeadline === expected.actionDeadline &&
    state.freshlyDrawnSeat === expected.seat &&
    state.legalActions.some((action) => action.id === expected.actionId)
  );
}

export function discardSourceForRawIndex(
  rawIndex: number,
  rawHandLength: number,
  hasFreshDraw: boolean
): DiscardSource {
  return hasFreshDraw && rawIndex === rawHandLength - 1 ? "draw" : "hand";
}

export function findTileAction(
  actions: readonly LegalAction[],
  type: "discard" | "riichi",
  tile: string,
  source: DiscardSource
): LegalAction | undefined {
  const exact = actions.find(
    (action) =>
      action.type === type &&
      action.tile === tile &&
      action.discardSource === source
  );
  return (
    exact ??
    actions.find(
      (action) =>
        action.type === type &&
        action.tile === tile &&
        action.discardSource === undefined
    )
  );
}

export function discardIndexForSource(
  hand: ReadonlyArray<string | null>,
  tile: string,
  source: DiscardSource | null | undefined,
  hasFreshDraw: boolean
): number {
  const drawnIndex = hasFreshDraw ? hand.length - 1 : -1;
  if (source === "draw") {
    return hand[drawnIndex] === tile ? drawnIndex : -1;
  }
  if (source === "hand") {
    const lastHandIndex = drawnIndex >= 0 ? drawnIndex - 1 : hand.length - 1;
    for (let index = lastHandIndex; index >= 0; index--) {
      if (hand[index] === tile) {
        return index;
      }
    }
    return -1;
  }
  return hand.lastIndexOf(tile);
}