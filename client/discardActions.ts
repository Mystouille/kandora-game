import type { LegalAction } from "~/game/protocol/messages";

export type DiscardSource = NonNullable<LegalAction["discardSource"]>;

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