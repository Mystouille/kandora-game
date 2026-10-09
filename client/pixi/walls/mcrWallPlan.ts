import type { MatchView } from "../../store";
import type { TableLayout } from "../tableLayout";
import type { Seat } from "../tableGeometry";
import {
  wallTileGeometry,
  wallTilePosition,
  wallTileZIndex,
  type WallPlanMetrics,
} from "./wallGeometry";
import type { WallRenderPlan, WallTilePlan } from "./wallRenderPlan";

export interface McrWallPlanInput {
  layout: TableLayout;
  metrics: WallPlanMetrics;
  showWalls: boolean;
  showUndealtWall: boolean;
  view: Pick<
    MatchView,
    | "dealer"
    | "dice"
    | "drawsTaken"
    | "liveDrawsTaken"
    | "flowerTiles"
    | "liveWall"
    | "mySeat"
    | "rulesFamily"
  > & { wallRemaining?: number };
}

const STACKS_PER_WALL = 18;
const TOTAL_STACKS = 72;
const TOTAL_TILES = 144;
const INITIAL_DEAL_TILES = 53;

function globalStackPosition(seat: number, stackIndex: number): number {
  return seat * STACKS_PER_WALL + stackIndex;
}

function wrap(position: number): number {
  return ((position % TOTAL_STACKS) + TOTAL_STACKS) % TOTAL_STACKS;
}

function consumedPhysicalIndexes(
  headConsumed: number,
  tailConsumed: number
): ReadonlySet<number> {
  const consumed = new Set<number>();
  for (
    let physicalIndex = 0;
    physicalIndex < Math.min(headConsumed, TOTAL_TILES);
    physicalIndex++
  ) {
    consumed.add(physicalIndex);
  }

  let replacementsTaken = 0;
  for (
    let stackIndex = TOTAL_STACKS - 1;
    stackIndex >= 0 && replacementsTaken < tailConsumed;
    stackIndex--
  ) {
    // Replacement draws walk backward by stack but take the upper tile first.
    for (const row of [1, 0] as const) {
      const physicalIndex = stackIndex * 2 + (row === 1 ? 0 : 1);
      if (consumed.has(physicalIndex)) {
        continue;
      }
      consumed.add(physicalIndex);
      replacementsTaken++;
      if (replacementsTaken >= tailConsumed) {
        break;
      }
    }
  }
  return consumed;
}

export function buildMcrWallPlan(input: McrWallPlanInput): WallRenderPlan {
  const { layout, metrics, showWalls, showUndealtWall, view } = input;
  const dice = view.dice ?? [3, 4];
  const diceSum = Math.max(2, Math.min(12, dice[0] + dice[1]));
  const breakSeat = (view.dealer + diceSum - 1) % 4;
  const breakStack = globalStackPosition(breakSeat, STACKS_PER_WALL - diceSum);
  const openingFlowers = (view.flowerTiles ?? []).reduce(
    (total, flowers) => total + flowers.length,
    0
  );
  const headConsumed = showUndealtWall
    ? 0
    : INITIAL_DEAL_TILES + view.liveDrawsTaken;
  const tailConsumed = showUndealtWall
    ? 0
    : Math.max(
        openingFlowers,
        TOTAL_TILES -
          INITIAL_DEAL_TILES -
          (view.wallRemaining ?? 0) -
          view.liveDrawsTaken
      );
  const consumed = consumedPhysicalIndexes(headConsumed, tailConsumed);
  const tiles: WallTilePlan[] = [];

  for (let seatIndex = 0; seatIndex < 4; seatIndex++) {
    const seat = seatIndex as Seat;
    const band = layout.wall[seat];
    const geometry = wallTileGeometry(metrics, seat);
    for (let stackIndex = 0; stackIndex < STACKS_PER_WALL; stackIndex++) {
      const global = globalStackPosition(seat, stackIndex);
      const fromBreak = wrap(breakStack - 1 - global);
      for (const row of [0, 1] as const) {
        const physicalIndex = fromBreak * 2 + (row === 1 ? 0 : 1);
        if (consumed.has(physicalIndex)) {
          continue;
        }
        const sourceIndex = physicalIndex - INITIAL_DEAL_TILES;
        const position = wallTilePosition({
          seat,
          row,
          longOffset: stackIndex * geometry.stride,
          geometry,
          band,
          showWalls,
        });
        tiles.push({
          seat,
          stackIndex,
          groupSlotIndex: stackIndex,
          row,
          kind: "live",
          sourceIndex,
          x: position.x,
          y: position.y,
          width: geometry.width,
          height: geometry.height,
          zIndex: wallTileZIndex(
            seat,
            stackIndex,
            STACKS_PER_WALL - 1,
            row,
            showWalls
          ),
          faceUpTile:
            showWalls && view.liveWall
              ? (view.liveWall[sourceIndex] ?? null)
              : null,
          tone: "normal",
          castsShadow: row === 0,
        });
      }
    }
  }

  return { tiles };
}
