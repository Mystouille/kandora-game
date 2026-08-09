import { describe, expect, it } from "vitest";
import {
  boundingBox,
  containsRect,
  isSideSeat,
  overflowOf,
  SEATS,
  seatOrientation,
  type Rect,
} from "./tableGeometry";

describe("tableGeometry", () => {
  describe("seat helpers", () => {
    it("maps every seat to its screen orientation", () => {
      expect(SEATS.map(seatOrientation)).toEqual([
        "bottom",
        "right",
        "top",
        "left",
      ]);
    });

    it("treats only seats 1 and 3 as side seats", () => {
      expect(SEATS.map(isSideSeat)).toEqual([false, true, false, true]);
    });
  });

  describe("boundingBox", () => {
    it("unions rects into their axis-aligned bounds", () => {
      const box = boundingBox([
        { x: 10, y: 20, w: 30, h: 40 },
        { x: 5, y: 50, w: 10, h: 10 },
      ]);
      expect(box).toEqual({ x: 5, y: 20, w: 35, h: 40 });
    });

    it("throws on an empty list", () => {
      expect(() => boundingBox([])).toThrow();
    });
  });

  describe("overflowOf", () => {
    const outer: Rect = { x: 0, y: 0, w: 100, h: 100 };

    it("reports zero overflow for a contained rect", () => {
      expect(overflowOf(outer, { x: 10, y: 10, w: 50, h: 50 })).toEqual({
        left: 0,
        top: 0,
        right: 0,
        bottom: 0,
        any: 0,
      });
    });

    it("measures per-edge overspill", () => {
      const report = overflowOf(outer, { x: -5, y: 0, w: 110, h: 100 });
      expect(report.left).toBe(5);
      expect(report.right).toBe(5);
      expect(report.top).toBe(0);
      expect(report.bottom).toBe(0);
      expect(report.any).toBe(5);
    });
  });

  describe("containsRect", () => {
    const outer: Rect = { x: 0, y: 0, w: 250, h: 150 };

    it("rejects a row that is 1.7px too wide by default", () => {
      const row: Rect = { x: 0, y: 0, w: 251.7, h: 150 };
      expect(containsRect(outer, row)).toBe(false);
    });

    it("accepts the same overspill when an epsilon allows it", () => {
      const row: Rect = { x: 0, y: 0, w: 251.7, h: 150 };
      expect(containsRect(outer, row, 2)).toBe(true);
    });
  });
});
