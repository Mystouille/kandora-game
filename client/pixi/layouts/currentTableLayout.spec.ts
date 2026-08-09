import { describe, expect, it } from "vitest";
import { boundingBox } from "../tableGeometry";
import {
  computeTableLayout,
  resolveFelt,
  tableLayoutFromConfig,
  validateTableLayoutConfig,
  type TableLayoutConfig,
} from "../tableLayout";
import { currentTableLayout } from "./currentTableLayout";
import { ACTIVE_TABLE_LAYOUT } from "./activeTableLayout";

const clone = (c: TableLayoutConfig): TableLayoutConfig => structuredClone(c);

describe("currentTableLayout", () => {
  it("validates cleanly", () => {
    expect(validateTableLayoutConfig(currentTableLayout)).toEqual([]);
  });

  it("uses the legacy 1000×926 viewport", () => {
    expect(currentTableLayout.viewport).toEqual({ w: 1000, h: 926 });
  });

  it("reproduces every legacy zone rect", () => {
    const legacy = computeTableLayout();
    expect(currentTableLayout.zones.center).toEqual(legacy.center);
    expect(currentTableLayout.zones.hands).toEqual(legacy.hands);
    expect(currentTableLayout.zones.discards).toEqual(legacy.discards);
    expect(currentTableLayout.zones.walls).toEqual(legacy.wall);
    expect(currentTableLayout.zones.playerInfo).toEqual(legacy.playerInfo);
  });

  it("insets the top hand left edge without moving its right edge", () => {
    const topHand = currentTableLayout.zones.hands[2];
    expect(topHand.x).toBe(61);
    expect(topHand.w).toBe(729);
    expect(topHand.x + topHand.w).toBe(790);
  });

  it("insets the focused hand left edge without moving its right edge", () => {
    const focusedHand = currentTableLayout.zones.hands[0];
    expect(focusedHand.x).toBe(80);
    expect(focusedHand.w).toBe(920);
    expect(focusedHand.x + focusedHand.w).toBe(1000);
  });

  it("extends the side hands toward the bottom edge", () => {
    const rightHand = currentTableLayout.zones.hands[1];
    const leftHand = currentTableLayout.zones.hands[3];
    expect(rightHand.h).toBe(669);
    expect(leftHand.h).toBe(647);
  });

  it("shifts the left wall 10 design pixels left", () => {
    const leftWall = currentTableLayout.zones.walls[3];
    expect(leftWall.x).toBe(46);
    expect(leftWall.w).toBe(135);
  });

  it("derives felt as the bounding box of walls + hands", () => {
    const legacy = computeTableLayout();
    expect(resolveFelt(currentTableLayout)).toEqual(
      boundingBox([...legacy.wall, ...legacy.hands])
    );
  });

  it("is the active layout", () => {
    expect(ACTIVE_TABLE_LAYOUT).toBe(currentTableLayout);
  });

  it("rebuilds a TableLayout byte-identical to computeTableLayout", () => {
    expect(tableLayoutFromConfig(currentTableLayout)).toEqual(
      computeTableLayout()
    );
  });

  it("switches viewport and zones for an alternate preset", () => {
    const synthetic: TableLayoutConfig = {
      ...currentTableLayout,
      id: "synthetic",
      viewport: { w: 1400, h: 900 },
      zones: {
        ...currentTableLayout.zones,
        center: { x: 1, y: 2, w: 3, h: 4 },
      },
    };
    const layout = tableLayoutFromConfig(synthetic);
    expect(layout.table).toEqual({ x: 0, y: 0, w: 1400, h: 900 });
    expect(layout.center).toEqual({ x: 1, y: 2, w: 3, h: 4 });
    // Tile metrics stay fixed (not yet part of the switchable config).
    expect(layout.tileSelf).toEqual(computeTableLayout().tileSelf);
  });

  it("rejects a zone with non-positive size", () => {
    const bad = clone(currentTableLayout);
    bad.zones.hands[0] = { x: 0, y: 0, w: 0, h: 10 };
    expect(
      validateTableLayoutConfig(bad).some((e) => e.includes("hands[0]"))
    ).toBe(true);
  });
});
