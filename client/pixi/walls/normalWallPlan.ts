import type { MatchView } from "../../store";
import type { TableLayout } from "../tableLayout";
import type { Seat } from "../tableGeometry";
import {
  wallTileGeometry,
  wallTilePosition,
  wallTileZIndex,
  type WallPlanMetrics,
} from "./wallGeometry";
import type {
  WallRenderPlan,
  WallTileKind,
  WallTilePlan,
} from "./wallRenderPlan";

export interface NormalWallPlanInput {
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
    | "doraIndicators"
    | "liveWall"
    | "deadWall"
    | "liveDrawSchedule"
    | "mySeat"
  >;
}

type WallRole =
  | { kind: "dead"; indexFromBreak: number }
  | { kind: "live"; drawStackIndex: number };

const STACKS_PER_WALL = 17;
const TOTAL_STACKS = 68;
const LIVE_STACKS = 61;
const DEAD_STACKS = 7;
const INITIAL_DEAL_TILES = 52;
const WALL_SECTION_GAP = 6;

function globalStackPosition(seat: number, stackIndex: number): number {
  return seat * STACKS_PER_WALL + stackIndex;
}

function wrapGlobalStack(position: number): number {
  return ((position % TOTAL_STACKS) + TOTAL_STACKS) % TOTAL_STACKS;
}

function normalWallRoles(view: NormalWallPlanInput["view"]): Map<number, WallRole> {
  const dice = view.dice ?? [3, 4];
  const diceSum = Math.max(2, Math.min(12, dice[0] + dice[1]));
  const breakSeat = (view.dealer + diceSum - 1) % 4;
  const breakStack = globalStackPosition(breakSeat, 17 - diceSum);
  const roles = new Map<number, WallRole>();

  for (let indexFromBreak = 0; indexFromBreak < DEAD_STACKS; indexFromBreak++) {
    roles.set(wrapGlobalStack(breakStack + indexFromBreak), {
      kind: "dead",
      indexFromBreak,
    });
  }
  for (let drawStackIndex = 0; drawStackIndex < LIVE_STACKS; drawStackIndex++) {
    roles.set(wrapGlobalStack(breakStack - 1 - drawStackIndex), {
      kind: "live",
      drawStackIndex,
    });
  }
  return roles;
}

function stackLongOffsets(
  seat: Seat,
  roles: ReadonlyMap<number, WallRole>,
  stride: number
): number[] {
  const offsets = new Array<number>(STACKS_PER_WALL);
  let cursor = 0;
  let previousKind: WallTileKind | null = null;
  for (let stackIndex = 0; stackIndex < STACKS_PER_WALL; stackIndex++) {
    const role = roles.get(globalStackPosition(seat, stackIndex));
    if (role && previousKind !== null && previousKind !== role.kind) {
      cursor += WALL_SECTION_GAP;
    }
    offsets[stackIndex] = cursor;
    cursor += stride;
    previousKind = role?.kind ?? null;
  }
  return offsets;
}

export function buildNormalWallPlan(
  input: NormalWallPlanInput
): WallRenderPlan {
  const { layout, metrics, showWalls, showUndealtWall, view } = input;
  const roles = normalWallRoles(view);
  const initialDealTiles = showUndealtWall ? 0 : INITIAL_DEAL_TILES;
  const liveDrawsConsumed = view.liveDrawsTaken ?? view.drawsTaken;
  const drawsTaken = liveDrawsConsumed + initialDealTiles;
  const kanCount = showUndealtWall
    ? 0
    : Math.max(0, Math.min(4, view.drawsTaken - liveDrawsConsumed));
  const tiles: WallTilePlan[] = [];

  for (let seatIndex = 0; seatIndex < 4; seatIndex++) {
    const seat = seatIndex as Seat;
    const band = layout.wall[seat];
    const geometry = wallTileGeometry(metrics, seat);
    const longOffsets = stackLongOffsets(seat, roles, geometry.stride);

    for (let stackIndex = 0; stackIndex < STACKS_PER_WALL; stackIndex++) {
      const role = roles.get(globalStackPosition(seat, stackIndex));
      if (!role) {
        continue;
      }
      for (const row of [0, 1] as const) {
        let sourceIndex: number;
        let livePulledToDead = false;
        if (role.kind === "live") {
          const tileDrawIndex =
            role.drawStackIndex * 2 + (row === 1 ? 0 : 1);
          if (tileDrawIndex < drawsTaken) {
            continue;
          }
          sourceIndex = tileDrawIndex - initialDealTiles;
          livePulledToDead =
            kanCount > 0 && tileDrawIndex >= 122 - kanCount;
        } else {
          if (role.indexFromBreak <= 1 && kanCount > 0) {
            const rinshanOrder =
              role.indexFromBreak * 2 + (row === 1 ? 0 : 1);
            if (rinshanOrder < kanCount) {
              continue;
            }
          }
          sourceIndex = role.indexFromBreak * 2 + row;
        }

        let faceUpTile: string | null = null;
        let greyOutDeadWall = false;
        let highlightFutureDraw = false;
        if (role.kind === "dead" && row === 1) {
          const rank = role.indexFromBreak + 1;
          if (rank === 3) {
            faceUpTile = view.doraIndicators[0] ?? null;
          } else if (rank >= 4 && rank <= 7) {
            faceUpTile = view.doraIndicators[rank - 3] ?? null;
          }
        }
        if (
          showWalls &&
          view.deadWall &&
          role.kind === "dead" &&
          faceUpTile === null &&
          sourceIndex >= 0 &&
          sourceIndex < view.deadWall.length
        ) {
          faceUpTile = view.deadWall[sourceIndex];
          greyOutDeadWall = true;
        }
        if (
          showWalls &&
          view.liveWall &&
          role.kind === "live" &&
          faceUpTile === null &&
          sourceIndex >= 0 &&
          sourceIndex < view.liveWall.length
        ) {
          faceUpTile = view.liveWall[sourceIndex];
          highlightFutureDraw =
            view.mySeat !== null &&
            view.liveDrawSchedule?.[sourceIndex] === view.mySeat;
        }

        const position = wallTilePosition({
          seat,
          row,
          longOffset: longOffsets[stackIndex],
          geometry,
          band,
          showWalls,
        });

        tiles.push({
          seat,
          stackIndex,
          groupSlotIndex: stackIndex,
          row,
          kind: role.kind,
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
          faceUpTile,
          tone: highlightFutureDraw
            ? "future-draw"
            : greyOutDeadWall || livePulledToDead
              ? "deemphasized"
              : "normal",
          castsShadow: row === 0,
        });
      }
    }
  }

  return { tiles };
}