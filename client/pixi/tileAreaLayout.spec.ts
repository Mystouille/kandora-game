import { describe, expect, it } from "vitest";
import {
  layoutDiscards,
  layoutSideHand,
  layoutTopHand,
  meldTileDims,
  potentialDiscardBounds,
  tilePlacementBounds,
} from "./tileAreaLayout";
import { boundingBox, containsRect } from "./tableGeometry";
import { sideScreen, smallScreen } from "./tiles/tileDesign";
import { tenhouTileDesign as D } from "./tiles/designs/tenhouTileDesign";

const small = smallScreen(D);
const side = sideScreen(D);
const bump = D.metrics.discardUprightBump;
const overlapH = D.spacing.discardRowHoriz;
const overlapV = D.spacing.discardRowVert;

// Legacy-derived expected metrics.
const vLocalW = small.w + bump;
const vLocalH = ((small.w + bump) * small.h) / small.w;
const vRowStride = vLocalH - overlapV;
const hLocalW = side.h;
const hLocalH = side.w;

const seq = (n: number): string[] =>
  Array.from({ length: n }, (_, i) => `${(i % 9) + 1}m`);

describe("layoutDiscards", () => {
  describe("seat 0 (bottom, vertical art)", () => {
    const p = layoutDiscards(D, 0, seq(8), null);

    it("places the first tile flush at the local origin", () => {
      expect(p[0].wrap).toEqual({ x: 0, y: 0, rotation: 0 });
      expect(p[0].sprite).toEqual({
        width: vLocalW,
        height: vLocalH,
        rotation: 0,
        x: vLocalW / 2,
        y: vLocalH / 2,
      });
      expect(p[0].atlasId).toBe("bottomSmall");
    });

    it("advances by the full tile width (vertical tiles butt flush)", () => {
      expect(p[1].wrap.x).toBeCloseTo(vLocalW, 10);
      expect(p[1].wrap.y).toBe(0);
    });

    it("wraps to a nested second row after six tiles", () => {
      expect(p[6].wrap.x).toBe(0);
      expect(p[6].wrap.y).toBeCloseTo(vRowStride, 10);
      expect(p[6].zIndex).toBe(1000);
    });

    it("keeps row-0 tiles at zIndex 0 (row-based stacking)", () => {
      expect(p.slice(0, 6).map((t) => t.zIndex)).toEqual([0, 0, 0, 0, 0, 0]);
    });

    it("keeps overflow tiles on the third row", () => {
      const full = layoutDiscards(D, 0, seq(20), null);
      expect(full[18].wrap.x).toBeCloseTo(6 * vLocalW, 10);
      expect(full[18].wrap.y).toBeCloseTo(2 * vRowStride, 10);
      expect(full[19].wrap.x).toBeCloseTo(7 * vLocalW, 10);
      expect(full[19].wrap.y).toBeCloseTo(2 * vRowStride, 10);
      expect(full[18].zIndex).toBe(2000);
      expect(full[19].zIndex).toBe(2000);
    });
  });

  describe("seat 1 (right, horizontal art)", () => {
    const p = layoutDiscards(D, 1, seq(3), null);

    it("rotates the sprite +pi/2 and swaps its footprint axes", () => {
      expect(p[0].sprite).toEqual({
        width: hLocalH,
        height: hLocalW,
        rotation: Math.PI / 2,
        x: hLocalW / 2,
        y: hLocalH / 2,
      });
      expect(p[0].atlasId).toBe("rightSmall");
    });

    it("overlaps consecutive tiles within a row", () => {
      expect(p[1].wrap.x).toBeCloseTo(hLocalW - overlapH, 10);
    });

    it("stacks lower tiles on top via negative within-row z", () => {
      expect(p.map((t) => t.zIndex)).toEqual([0, -1, -2]);
    });
  });

  describe("seat 3 (left) within-row z is positive", () => {
    const p = layoutDiscards(D, 3, seq(3), null);
    it("uses +i within-row z", () => {
      expect(p.map((t) => t.zIndex)).toEqual([0, 1, 2]);
    });
  });

  describe("seat 2 (top) negates the row multiplier", () => {
    const p = layoutDiscards(D, 2, seq(7), null);
    it("puts row 1 at zIndex -1000", () => {
      expect(p[6].zIndex).toBe(-1000);
    });
  });

  describe("riichi tile", () => {
    it("seat 0: lands landscape from leftSmall and advances by side width", () => {
      const p = layoutDiscards(D, 0, seq(3), 1);
      expect(p[1].isRiichi).toBe(true);
      expect(p[1].atlasId).toBe("leftSmall");
      expect(p[1].sprite.width).toBeCloseTo(side.w, 10);
      expect(p[1].sprite.height).toBeCloseTo(side.h, 10);
      expect(p[1].sprite.rotation).toBe(0);
      expect(p[1].wrap.x).toBeCloseTo(vLocalW, 10); // after one flush tile
      // Next tile advances past the riichi tile's landscape width.
      expect(p[2].wrap.x).toBeCloseTo(vLocalW + side.w, 10);
    });

    it("seat 1: tilts via wrap +pi/2 from bottomSmall", () => {
      const p = layoutDiscards(D, 1, seq(2), 0);
      expect(p[0].atlasId).toBe("bottomSmall");
      expect(p[0].sprite.width).toBeCloseTo(small.w, 10);
      expect(p[0].sprite.height).toBeCloseTo(small.h, 10);
      expect(p[0].sprite.rotation).toBe(0);
      expect(p[0].wrap.rotation).toBe(Math.PI / 2);
      expect(p[0].wrap.x).toBeCloseTo(small.h, 10);
    });

    it("seat 3: flips the riichi sprite by pi so it points outward", () => {
      const p = layoutDiscards(D, 3, seq(1), 0);
      expect(p[0].sprite.rotation).toBe(Math.PI);
      expect(p[0].atlasId).toBe("topSmall");
    });
  });

  it("preserves tile identity and index order", () => {
    const tiles = ["1m", "5p", null, "7z"];
    const p = layoutDiscards(D, 0, tiles, null);
    expect(p.map((t) => t.tile)).toEqual(tiles);
    expect(p.map((t) => t.index)).toEqual([0, 1, 2, 3]);
  });

  it("computes a tight worst-case 18-tile footprint for every seat", () => {
    const expectedVertical = {
      w: 5 * vLocalW + side.w,
      h: 2 * vRowStride + vLocalH,
    };
    const expectedSide = {
      w: 5 * (hLocalW - overlapH) + small.h,
      h: 3 * hLocalH,
    };

    for (const seat of [0, 1, 2, 3] as const) {
      const potential = potentialDiscardBounds(D, seat, 18);
      const expected = seat % 2 === 0 ? expectedVertical : expectedSide;
      expect(potential.x).toBeCloseTo(0, 10);
      expect(potential.y).toBeCloseTo(0, 10);
      expect(potential.w).toBeCloseTo(expected.w, 10);
      expect(potential.h).toBeCloseTo(expected.h, 10);

      for (const riichiIndex of [null, ...Array.from({ length: 18 }, (_, i) => i)]) {
        const actual = boundingBox(
          layoutDiscards(D, seat, seq(18), riichiIndex).map(tilePlacementBounds)
        );
        expect(containsRect(potential, actual, 1e-9)).toBe(true);
      }
    }
  });
});

describe("layoutSideHand", () => {
  const back = D.metrics.sideHandBack;
  const faceDownStride = back.h - D.spacing.sideHand;
  const opts = { canReveal: false, isFreshlyDrawn: false, hiddenSlot: null };

  describe("face-down (concealed)", () => {
    const p = layoutSideHand(D, 1, [null, null, null], opts);

    it("draws the back sheet with portrait dims, no tile", () => {
      expect(p[0].atlasId).toBe("sideHandR");
      expect(p[0].tile).toBeNull();
      expect(p[0].sprite).toEqual({
        width: back.w,
        height: back.h,
        rotation: Math.PI / 2,
        x: back.h / 2,
        y: back.w / 2,
      });
    });

    it("strides by (back height - side overlap)", () => {
      expect(p[1].wrap.x).toBeCloseTo(faceDownStride, 10);
    });

    it("stacks seat 1 with -i and seat 3 with +i", () => {
      expect(p.map((t) => t.zIndex)).toEqual([0, -1, -2]);
      const p3 = layoutSideHand(D, 3, [null, null, null], opts);
      expect(p3.map((t) => t.zIndex)).toEqual([0, 1, 2]);
      expect(p3[0].atlasId).toBe("sideHandL");
      expect(p3[0].sprite.rotation).toBe(-Math.PI / 2);
    });
  });

  describe("revealed", () => {
    const side = sideScreen(D);
    const p = layoutSideHand(D, 1, ["1m", "2p"], {
      canReveal: true,
      isFreshlyDrawn: false,
      hiddenSlot: null,
    });

    it("draws the discard face sheet sized to the side tile", () => {
      expect(p[0].atlasId).toBe("rightSmall");
      expect(p[0].tile).toBe("1m");
      expect(p[0].sprite.width).toBeCloseTo(side.w, 10);
      expect(p[0].sprite.height).toBeCloseTo(side.h, 10);
      expect(p[0].sprite.rotation).toBeCloseTo(Math.PI / 2, 10);
    });

    it("strides like a side discard row", () => {
      expect(p[1].wrap.x).toBeCloseTo(side.h - D.spacing.discardRowHoriz, 10);
    });
  });

  it("skips the hidden slot but keeps absolute slot positions", () => {
    const p = layoutSideHand(D, 1, [null, null, null], {
      ...opts,
      hiddenSlot: 1,
    });
    expect(p.map((t) => t.index)).toEqual([0, 2]);
    expect(p[1].wrap.x).toBeCloseTo(2 * faceDownStride, 10);
  });

  it("adds the tsumo gap to the last tile when freshly drawn", () => {
    const p = layoutSideHand(D, 1, [null, null], {
      ...opts,
      isFreshlyDrawn: true,
    });
    expect(p[1].wrap.x).toBeCloseTo(faceDownStride + D.spacing.tsumoGap, 10);
  });
});

describe("layoutTopHand", () => {
  const t = D.metrics.topHand;
  const opts = { canReveal: false, isFreshlyDrawn: false, hiddenSlot: null };

  it("draws face-down topSmall backs rotated 180deg", () => {
    const p = layoutTopHand(D, [null, null], opts);
    expect(p[0].atlasId).toBe("topSmall");
    expect(p[0].tile).toBeNull();
    expect(p[0].sprite).toEqual({
      width: t.w,
      height: t.h,
      rotation: Math.PI,
      x: t.w / 2,
      y: t.h / 2,
    });
    expect(p[0].wrap).toEqual({ x: 0, y: 0, rotation: 0 });
  });

  it("strides by the tile width and keeps zIndex flat", () => {
    const p = layoutTopHand(D, [null, null, null], opts);
    expect(p[1].wrap.x).toBeCloseTo(t.w, 10);
    expect(p[2].wrap.x).toBeCloseTo(2 * t.w, 10);
    expect(p.map((x) => x.zIndex)).toEqual([0, 0, 0]);
  });

  it("shows the face cell when revealed", () => {
    const p = layoutTopHand(D, ["3s"], {
      canReveal: true,
      isFreshlyDrawn: false,
      hiddenSlot: null,
    });
    expect(p[0].tile).toBe("3s");
    expect(p[0].atlasId).toBe("topSmall");
  });

  it("skips the hidden slot and applies the tsumo gap", () => {
    const p = layoutTopHand(D, [null, null, null], {
      canReveal: false,
      isFreshlyDrawn: true,
      hiddenSlot: 1,
    });
    expect(p.map((x) => x.index)).toEqual([0, 2]);
    expect(p[1].wrap.x).toBeCloseTo(2 * t.w + D.spacing.tsumoGap, 10);
  });
});

describe("meldTileDims", () => {
  it("uses small-tile dims for bottom/top seats", () => {
    const small = smallScreen(D);
    expect(meldTileDims(D, 0)).toEqual({ w: small.w, h: small.h });
    expect(meldTileDims(D, 2)).toEqual({ w: small.w, h: small.h });
  });

  it("swaps side-tile axes for side seats", () => {
    const side = sideScreen(D);
    expect(meldTileDims(D, 1)).toEqual({ w: side.h, h: side.w });
    expect(meldTileDims(D, 3)).toEqual({ w: side.h, h: side.w });
  });
});
