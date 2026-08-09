import { describe, expect, it } from "vitest";
import {
  artScreen,
  atlasCellSize,
  bigScreen,
  frameRect,
  resolveTileFrame,
  sideScreen,
  smallScreen,
  validateTileDesign,
  type TileDesign,
} from "./tileDesign";
import { tenhouTileDesign } from "./designs/tenhouTileDesign";

const clone = (d: TileDesign): TileDesign => structuredClone(d);

describe("tileDesign contract", () => {
  it("accepts the Tenhou design", () => {
    expect(validateTileDesign(tenhouTileDesign)).toEqual([]);
  });

  describe("category screen sizes reproduce the legacy constants", () => {
    const scale = 0.5 * (1 - 0.094);

    it("small = 86×130 × scale", () => {
      const s = smallScreen(tenhouTileDesign);
      expect(s.w).toBeCloseTo(86 * scale, 10);
      expect(s.h).toBeCloseTo(130 * scale, 10);
    });

    it("side = 116×107 × scale", () => {
      const s = sideScreen(tenhouTileDesign);
      expect(s.w).toBeCloseTo(116 * scale, 10);
      expect(s.h).toBeCloseTo(107 * scale, 10);
    });

    it("big = 131×198 × 0.51", () => {
      const s = bigScreen(tenhouTileDesign);
      expect(s.w).toBeCloseTo(131 * 0.51, 10);
      expect(s.h).toBeCloseTo(198 * 0.51, 10);
    });

    it("artScreen preserves source aspect", () => {
      const art = { source: { w: 200, h: 100 }, scale: 0.25 };
      expect(artScreen(art)).toEqual({ w: 50, h: 25 });
    });
  });

  describe("seat sheet maps match the legacy renderer", () => {
    const s = tenhouTileDesign.sheets;
    it("uses each seat's pre-rotated discard sheet", () => {
      expect(s.discard).toEqual({
        0: "bottomSmall",
        1: "rightSmall",
        2: "topSmall",
        3: "leftSmall",
      });
    });
    it("reads riichi tiles from a perpendicular sheet", () => {
      expect(s.riichiDiscard[0]).toBe("leftSmall");
      expect(s.riichiDiscard[1]).toBe("bottomSmall");
    });
    it("shares the seat-0/2 back sheet for wall backs and ankan backs", () => {
      expect(s.wallBack[2]).toBe("bottomSmall");
      expect(s.meldFaceDown[2]).toBe("bottomSmall");
      expect(s.meldFaceDown[3]).toBe("rightSmall");
    });
  });

  describe("resolveTileFrame mirrors the legacy tileSheetCell", () => {
    const atlas = tenhouTileDesign.atlases.bottomSmall;

    it("maps numbered and red-five tiles to (suitRow, number)", () => {
      expect(resolveTileFrame(atlas, "1m")).toEqual({ row: 0, col: 1 });
      expect(resolveTileFrame(atlas, "0m")).toEqual({ row: 0, col: 0 });
      expect(resolveTileFrame(atlas, "9s")).toEqual({ row: 2, col: 9 });
      expect(resolveTileFrame(atlas, "5z")).toEqual({ row: 3, col: 5 });
    });

    it("maps null and unknown tiles to the back cell", () => {
      expect(resolveTileFrame(atlas, null)).toEqual({ row: 3, col: 0 });
      expect(resolveTileFrame(atlas, "xz")).toEqual({ row: 3, col: 0 });
    });

    it("returns null for single-image atlases", () => {
      expect(
        resolveTileFrame(tenhouTileDesign.atlases.sideHandL, "1m")
      ).toBeNull();
    });
  });

  describe("atlas frame math (texture-store core)", () => {
    const grid = tenhouTileDesign.atlases.bottomSmall;

    it("derives grid cell size by dividing the loaded texture", () => {
      // A 10×4 sheet loaded at 860×520 → 86×130 cells.
      expect(atlasCellSize(grid, 860, 520)).toEqual({ w: 86, h: 130 });
    });

    it("uses the whole texture for single-image atlases", () => {
      expect(
        atlasCellSize(tenhouTileDesign.atlases.sideHandR, 116, 107)
      ).toEqual({ w: 116, h: 107 });
    });

    it("insets the frame rect on every side", () => {
      expect(frameRect({ row: 0, col: 1 }, 86, 130, 0.5)).toEqual({
        x: 86.5,
        y: 0.5,
        w: 85,
        h: 129,
      });
    });

    it("composes resolveTileFrame + frameRect for a real tile", () => {
      const cell = resolveTileFrame(grid, "5z");
      expect(cell).not.toBeNull();
      const r = frameRect(cell!, 86, 130, 0);
      expect(r).toEqual({ x: 5 * 86, y: 3 * 130, w: 86, h: 130 });
    });
  });

  describe("validateTileDesign rejects malformed designs", () => {
    it("flags an unknown atlas reference", () => {
      const bad = clone(tenhouTileDesign);
      bad.sheets.discard[0] = "does-not-exist";
      expect(validateTileDesign(bad)).toContain(
        'sheets.discard[0] references unknown atlas "does-not-exist"'
      );
    });

    it("flags a non-positive scale", () => {
      const bad = clone(tenhouTileDesign);
      bad.categories.big.scale = 0;
      expect(validateTileDesign(bad).some((e) => e.includes("big"))).toBe(true);
    });

    it("flags a grid atlas missing a suit row", () => {
      const bad = clone(tenhouTileDesign);
      const atlas = bad.atlases.bottomSmall;
      if (atlas.kind === "grid") {
        delete (atlas.suitRows as Record<string, number>).z;
      }
      expect(validateTileDesign(bad).some((e) => e.includes("suit"))).toBe(
        true
      );
    });

    it("flags an out-of-range shadow alpha", () => {
      const bad = clone(tenhouTileDesign);
      bad.effects.shadow = {
        small: "bottomSmall",
        side: "rightSmall",
        big: "ownHand",
        uprightSmall: "topSmall",
        long: "bottomSmall",
        depth: 14,
        cap: 0.28,
        offsetX: 1,
        offsetY: 1,
        alpha: 2,
      };
      expect(validateTileDesign(bad).some((e) => e.includes("alpha"))).toBe(
        true
      );
    });
  });
});
