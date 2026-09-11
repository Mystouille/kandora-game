import type { MatchView } from "../../store";
import type { TableLayout } from "../tableLayout";
import type { Seat } from "../tableGeometry";
import {
  centeredWallRunOffset,
  wallTileGeometry,
  wallTilePosition,
  wallTileZIndex,
  type WallPlanMetrics,
} from "./wallGeometry";
import type { WallRenderPlan, WallTilePlan } from "./wallRenderPlan";

export interface DuplicateWallPlanInput {
  layout: TableLayout;
  metrics: WallPlanMetrics;
  showWalls: boolean;
  view: Pick<
    MatchView,
    | "dealer"
    | "doraIndicators"
    | "deadWall"
    | "duplicateDrawQueues"
    | "duplicateWallState"
  >;
}

const PERSONAL_STACKS = 9;
const DEAD_STACKS = 5;
const DEALER_GAP_SLOTS = 1;
const DEALER_GROUP_SLOTS = DEAD_STACKS + DEALER_GAP_SLOTS + PERSONAL_STACKS;

function personalTileSlot(
  queueIndex: number,
  initialCount: number
): { stackIndex: number; row: 0 | 1 } {
  const stackFromRight = Math.floor(queueIndex / 2);
  const stackIndex = PERSONAL_STACKS - 1 - stackFromRight;
  const isLoneOddTile = initialCount % 2 === 1 && queueIndex === initialCount - 1;
  const row = isLoneOddTile ? 0 : queueIndex % 2 === 0 ? 1 : 0;
  return { stackIndex, row };
}

export function buildDuplicateWallPlan(
  input: DuplicateWallPlanInput
): WallRenderPlan {
  const { layout, metrics, showWalls, view } = input;
  const state = view.duplicateWallState;
  if (state === null) {
    return { tiles: [] };
  }
  const tiles: WallTilePlan[] = [];

  for (let seatIndex = 0; seatIndex < 4; seatIndex++) {
    const seat = seatIndex as Seat;
    const band = layout.wall[seat];
    const geometry = wallTileGeometry(metrics, seat);
    const isDealer = seat === view.dealer;
    const groupSlots = isDealer ? DEALER_GROUP_SLOTS : PERSONAL_STACKS;
    const groupOffset = centeredWallRunOffset(
      band,
      seat,
      groupSlots,
      geometry
    );
    const personalGroupOffset = isDealer
      ? DEAD_STACKS + DEALER_GAP_SLOTS
      : 0;
    const initialCount = state.initial[seat];
    const remainingCount = state.remaining[seat];
    const consumedCount = Math.max(
      0,
      Math.min(initialCount, initialCount - remainingCount)
    );

    for (let queueIndex = consumedCount; queueIndex < initialCount; queueIndex++) {
      const { stackIndex, row } = personalTileSlot(queueIndex, initialCount);
      const groupSlotIndex = personalGroupOffset + stackIndex;
      const position = wallTilePosition({
        seat,
        row,
        longOffset: groupOffset + groupSlotIndex * geometry.stride,
        geometry,
        band,
        showWalls,
      });
      const faceUpTile =
        showWalls && view.duplicateDrawQueues
          ? (view.duplicateDrawQueues[seat][queueIndex] ?? null)
          : null;
      tiles.push({
        seat,
        stackIndex,
        groupSlotIndex,
        row,
        kind: "live",
        sourceIndex: queueIndex,
        x: position.x,
        y: position.y,
        width: geometry.width,
        height: geometry.height,
        zIndex: wallTileZIndex(
          seat,
          groupSlotIndex,
          groupSlots - 1,
          row,
          showWalls
        ),
        faceUpTile,
        tone: "normal",
        castsShadow: row === 0,
      });
    }

    if (!isDealer) {
      continue;
    }
    for (let stackIndex = 0; stackIndex < DEAD_STACKS; stackIndex++) {
      for (const row of [0, 1] as const) {
        const groupSlotIndex = stackIndex;
        const sourceIndex = 4 + stackIndex * 2 + (row === 1 ? 0 : 1);
        const naturalIndicator =
          row === 1 ? (view.doraIndicators[stackIndex] ?? null) : null;
        const revealedFromArchive =
          showWalls && view.deadWall
            ? (view.deadWall[sourceIndex] ?? null)
            : null;
        const faceUpTile = naturalIndicator ?? revealedFromArchive;
        const position = wallTilePosition({
          seat,
          row,
          longOffset: groupOffset + groupSlotIndex * geometry.stride,
          geometry,
          band,
          showWalls,
        });
        tiles.push({
          seat,
          stackIndex,
          groupSlotIndex,
          row,
          kind: "dead",
          sourceIndex,
          x: position.x,
          y: position.y,
          width: geometry.width,
          height: geometry.height,
          zIndex: wallTileZIndex(
            seat,
            groupSlotIndex,
            groupSlots - 1,
            row,
            showWalls
          ),
          faceUpTile,
          tone:
            naturalIndicator === null && revealedFromArchive !== null
              ? "deemphasized"
              : "normal",
          castsShadow: row === 0,
        });
      }
    }
  }

  return { tiles };
}