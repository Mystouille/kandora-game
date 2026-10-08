import type { Seat } from "~/game/protocol/seat";
import { tablePositionForSeat } from "../../tableProjection";
import type { NormalWallPlanInput } from "./normalWallPlan";
import {
  centeredWallRunOffset,
  wallTileGeometry,
  wallTilePosition,
  wallTileZIndex,
} from "./wallGeometry";
import type { WallRenderPlan, WallTilePlan } from "./wallRenderPlan";

/** Physical positions stay fixed while the reserve boundary moves into the live tail. */
export function buildSanmaWallPlan(input: NormalWallPlanInput): WallRenderPlan {
  const { view, metrics, layout, showWalls, showUndealtWall } = input;
  const kansai = view.sanmaType === "kansai";
  const stacks = kansai ? [14, 14, 14, 14] : [14, 14, 13, 13];
  const totalStacks = kansai ? 56 : 54;
  const initialDead = kansai ? 10 : 14;
  const initialLive = totalStacks * 2 - initialDead - 39;
  const focus = view.tableProjection?.focus ?? 0;
  const dealer = (view.dealer + focus) % 4;
  const dice = view.dice ?? [3, 4];
  const sum = Math.max(2, Math.min(12, dice[0] + dice[1]));
  const breakSeat = (dealer + sum - 1) % 4;
  const starts = [
    0,
    stacks[0],
    stacks[0] + stacks[1],
    stacks[0] + stacks[1] + stacks[2],
  ];
  const breakStack = starts[breakSeat] + stacks[breakSeat] - sum;
  const replacements = showUndealtWall
    ? 0
    : (view.sanmaWall?.replacementsTaken ?? 0);
  const kans = showUndealtWall ? 0 : (view.sanmaWall?.kanCount ?? 0);
  const reservedTail = kansai ? 2 * kans : replacements;
  const drawn = showUndealtWall ? 0 : 39 + view.liveDrawsTaken;
  const tiles: WallTilePlan[] = [];

  const add = (
    globalStack: number,
    row: 0 | 1,
    sourceIndex: number,
    reserveIndex: number | null,
    archived: string | null
  ): void => {
    globalStack = ((globalStack % totalStacks) + totalStacks) % totalStacks;
    let absoluteSide = 3;
    for (let side = 0; side < 4; side++) {
      if (globalStack < starts[side] + stacks[side]) {
        absoluteSide = side;
        break;
      }
    }
    const seat = tablePositionForSeat(absoluteSide as Seat, focus);
    const stackIndex = globalStack - starts[absoluteSide];
    const geometry = wallTileGeometry(metrics, seat);
    const band = layout.wall[seat];
    const longOffset =
      centeredWallRunOffset(band, seat, stacks[absoluteSide], geometry) +
      stackIndex * geometry.stride;
    const position = wallTilePosition({
      seat,
      row,
      longOffset,
      geometry,
      band,
      showWalls,
    });
    const indicatorIndex =
      reserveIndex !== null && reserveIndex >= 8 && reserveIndex % 2 === 0
        ? (reserveIndex - 8) / 2
        : -1;
    const indicator = view.doraIndicators[indicatorIndex] ?? null;
    const faceUpTile = indicator ?? (showWalls ? archived : null);
    const futureDraw =
      reserveIndex === null &&
      view.mySeat !== null &&
      view.liveDrawSchedule?.[sourceIndex] === view.mySeat;
    tiles.push({
      seat,
      stackIndex,
      groupSlotIndex: stackIndex,
      row,
      kind: reserveIndex === null ? "live" : "dead",
      sourceIndex,
      ...position,
      width: geometry.width,
      height: geometry.height,
      zIndex: wallTileZIndex(
        seat,
        stackIndex,
        stacks[absoluteSide] - 1,
        row,
        showWalls
      ),
      faceUpTile,
      tone:
        showWalls && futureDraw
          ? "future-draw"
          : reserveIndex !== null && indicator === null
            ? "deemphasized"
            : "normal",
      castsShadow: row === 0,
    });
  };

  for (let index = replacements; index < initialDead; index++) {
    add(
      breakStack + Math.floor(index / 2),
      index % 2 === 0 ? 1 : 0,
      index,
      index,
      view.deadWall?.[index] ?? null
    );
  }
  for (let index = drawn; index < totalStacks * 2 - initialDead; index++) {
    const sourceIndex = index - 39;
    const tailIndex = initialLive - 1 - sourceIndex;
    const reserveIndex =
      tailIndex < reservedTail ? initialDead + tailIndex : null;
    add(
      breakStack - 1 - Math.floor(index / 2),
      index % 2 === 0 ? 1 : 0,
      sourceIndex,
      reserveIndex,
      view.liveWall?.[sourceIndex] ?? null
    );
  }
  return { tiles };
}
