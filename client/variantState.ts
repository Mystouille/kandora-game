import type {
  GameEvent,
  Meld,
  SnapshotState,
  Tile,
} from "~/game/protocol/messages";
import type { PlayerCount, SanmaType } from "~/game/protocol/seat";
import type { RulesFamily } from "~/game/protocol/rulesFamily";
import { seatValues } from "~/game/rules/seats";

export interface VariantView {
  rulesFamily?: RulesFamily;
  playerCount?: PlayerCount;
  sanmaType?: SanmaType;
}

export function snapshotInitialDeadWall(
  snapshot: SnapshotState
): Tile[] | null {
  // Only native sanma snapshots guarantee hand-start (not shifted) reserve order.
  return snapshot.playerCount === 3 && snapshot.deadWall
    ? [...snapshot.deadWall]
    : null;
}

export function emptyParticipantState(playerCount: PlayerCount) {
  return {
    playerCount,
    hands: seatValues(playerCount, () => [] as Array<Tile | null>),
    melds: seatValues(playerCount, () => [] as Meld[]),
    discards: seatValues(playerCount, () => [] as Tile[]),
    discardTsumogiri: seatValues(playerCount, () => [] as boolean[]),
    discardSources: seatValues(
      playerCount,
      () => [] as Array<"hand" | "draw" | null>
    ),
    discardOrdinals: seatValues(playerCount, () => [] as number[]),
    nukiTiles: seatValues(playerCount, () => [] as Tile[]),
    flowerTiles: seatValues(4, () => [] as Tile[]),
    pendingNuki: null,
    pendingFlower: null,
    scores: seatValues(playerCount, () => 25000),
    riichiDeclared: seatValues(playerCount, () => false),
    ryuukyokuDeclarations: seatValues(
      playerCount,
      () => null as boolean | null
    ),
    ryuukyokuTenpaiHands: seatValues(playerCount, () => null as Tile[] | null),
    riichiTileIdx: seatValues(playerCount, () => null as number | null),
    sinking: seatValues(playerCount, () => false),
    furiten: seatValues(playerCount, () => false),
    chips: seatValues(playerCount, () => 0),
    dabuken: seatValues(playerCount, () => false),
  };
}

export function initialLiveWallCount(
  view: VariantView,
  duplicate: boolean = false
): number {
  if (view.rulesFamily === "mcr") {
    return 91;
  }
  if (view.playerCount !== 3) {
    return 70;
  }
  return view.sanmaType === "kansai" ? (duplicate ? 59 : 63) : 55;
}

export interface NukiView {
  hands: Array<Array<Tile | null>>;
  nukiTiles?: Tile[][];
  pendingNuki?: { seat: 0 | 1 | 2 | 3; tile: Tile; opening: boolean } | null;
}

/** A declared North is already outside the hand while opponents can rob it. */
export function applyNukiEvent(
  view: NukiView,
  event: Extract<GameEvent, { type: "nuki" }>
) {
  const hands = view.hands.map((hand) => [...hand]);
  const nukiTiles = view.hands.map((_, seat) => [
    ...(view.nukiTiles?.[seat] ?? []),
  ]);
  const completesPending =
    event.stage === "completed" &&
    view.pendingNuki?.seat === event.seat &&
    view.pendingNuki.tile === event.tile;
  if (!completesPending) {
    const hand = hands[event.seat];
    let index = hand.lastIndexOf(event.tile);
    if (index < 0) {
      index = hand.lastIndexOf(null);
    }
    if (index >= 0) {
      hand.splice(index, 1);
    }
  }
  if (event.stage === "completed") {
    nukiTiles[event.seat].push(event.tile);
  }
  return {
    hands,
    nukiTiles,
    pendingNuki:
      event.stage === "declared" || event.tile !== "4z"
        ? {
            seat: event.seat,
            tile: event.tile,
            opening: event.opening ?? false,
          }
        : null,
  };
}
