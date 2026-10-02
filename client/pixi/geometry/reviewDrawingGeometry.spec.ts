import { describe, expect, it } from "vitest";
import { decodeDrawing, encodeDrawing } from "../../../replay/reviewDrawing";
import { tableLayoutFromConfig } from "../tableLayout";
import { layoutDiscards, tilePlacementBounds } from "../tileAreaLayout";
import { tenhouTileDesign as design } from "../tiles/designs/tenhouTileDesign";
import {
  webDiscardLayoutOptions,
  webTableLayoutConfig,
} from "../layouts/webTableLayout";
import {
  mobileDiscardLayoutOptions,
  mobileTableLayout,
} from "../layouts/mobileTableLayout";
import {
  focusedDiscardDrawingFrame,
  fromFocusedDiscardPoint,
  toFocusedDiscardPoint,
} from "./reviewDrawingGeometry";

const layouts = [
  webTableLayoutConfig("standard"),
  webTableLayoutConfig("compact"),
  mobileTableLayout,
].map((config) => {
  const layout = tableLayoutFromConfig(config);
  const options =
    config.id === "mobile"
      ? mobileDiscardLayoutOptions(design, layout)
      : webDiscardLayoutOptions(
          config.id === "compact-web" ? "compact" : "standard",
          design,
          layout
        );
  return { id: config.id, layout, options };
});

describe("focused-discard drawing geometry", () => {
  it("includes table letterboxing, pond padding, and tile scale", () => {
    const { layout, options } = layouts[1];
    const frame = focusedDiscardDrawingFrame(layout, options, {
      x: 45,
      y: 80,
      scale: 2,
    });
    expect(frame.table).toEqual({ x: 45, y: 80, w: 2000, h: 1852 });
    expect(frame.origin).toEqual({
      x: 45 + (layout.discards[0].x + 4) * 2,
      y: 80 + (layout.discards[0].y + 4) * 2,
    });
    expect(frame.scale).toBe(options!.scale! * 2);
    const point = { x: -700.5, y: 1250.125 };
    const restored = toFocusedDiscardPoint(
      fromFocusedDiscardPoint(point, frame),
      frame
    );
    expect(restored.x).toBeCloseTo(point.x, 10);
    expect(restored.y).toBeCloseTo(point.y, 10);
  });

  for (const source of layouts) {
    for (const target of layouts) {
      it(`aligns ${source.id} -> ${target.id}, including riichi and overflow`, () => {
        for (const width of [640, 1280, 1920, 3840]) {
          const sourceFrame = focusedDiscardDrawingFrame(
            source.layout,
            source.options,
            { x: 31, y: 67, scale: width / source.layout.table.w }
          );
          const targetRoot = {
            x: 83,
            y: 19,
            scale: width / target.layout.table.w,
          };
          const targetFrame = focusedDiscardDrawingFrame(
            target.layout,
            target.options,
            targetRoot
          );
          for (const count of [0, 1, 6, 7, 18, 19, 30]) {
            const tiles = Array.from({ length: count }, () => "1m");
            for (const riichi of [null, ...tiles.map((_, i) => i)]) {
              const author = layoutDiscards(
                design,
                0,
                tiles,
                riichi,
                source.options
              );
              const viewer = layoutDiscards(
                design,
                0,
                tiles,
                riichi,
                target.options
              );
              for (let index = 0; index < count; index++) {
                const a = tilePlacementBounds(author[index]);
                const b = tilePlacementBounds(viewer[index]);
                for (const fraction of [0, 0.5, 1]) {
                  const sourcePoint = {
                    x:
                      31 +
                      (source.layout.discards[0].x + a.x + a.w * fraction) *
                        (width / source.layout.table.w),
                    y:
                      67 +
                      (source.layout.discards[0].y + a.y + a.h * fraction) *
                        (width / source.layout.table.w),
                  };
                  const canonical = toFocusedDiscardPoint(
                    sourcePoint,
                    sourceFrame
                  );
                  const expected = {
                    x:
                      targetRoot.x +
                      (target.layout.discards[0].x + b.x + b.w * fraction) *
                        targetRoot.scale,
                    y:
                      targetRoot.y +
                      (target.layout.discards[0].y + b.y + b.h * fraction) *
                        targetRoot.scale,
                  };
                  const projected = fromFocusedDiscardPoint(
                    canonical,
                    targetFrame
                  );
                  expect(Math.abs(projected.x - expected.x)).toBeLessThan(1e-9);
                  expect(Math.abs(projected.y - expected.y)).toBeLessThan(1e-9);
                  const stored = decodeDrawing(
                    encodeDrawing({
                      strokes: [
                        { space: "focused-discard", points: [canonical] },
                      ],
                    })
                  ).strokes[0].points[0];
                  const restored = fromFocusedDiscardPoint(stored, targetFrame);
                  expect(Math.abs(restored.x - expected.x)).toBeLessThan(0.25);
                  expect(Math.abs(restored.y - expected.y)).toBeLessThan(0.25);
                }
              }
            }
          }
        }
      });
    }
  }

  it("rejects invalid frame scales rather than creating unprojectable points", () => {
    for (const scale of [0, -1, NaN, Infinity]) {
      expect(() =>
        focusedDiscardDrawingFrame(layouts[0].layout, undefined, {
          x: 0,
          y: 0,
          scale,
        })
      ).toThrow();
    }
  });
});
