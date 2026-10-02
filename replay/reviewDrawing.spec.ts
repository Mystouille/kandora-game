import { describe, expect, it } from "vitest";
import {
  decodeDrawing,
  encodeDrawing,
  MAX_DRAWING_BYTES,
  ReviewDrawingError,
  smoothDrawingForDisplay,
  type Drawing,
  type Stroke,
} from "./reviewDrawing";

const anchored = (points = [{ x: -375.125, y: 1200.5 }]): Stroke => ({
  space: "focused-discard",
  points,
});

describe("review drawing codec", () => {
  it("retains v1 decoding and legacy-only v2 encoding", () => {
    expect(decodeDrawing(new Uint8Array([1, 1, 1, 0, 0, 255]))).toEqual({
      strokes: [{ points: [{ x: 0, y: 1 }] }],
    });
    const drawing: Drawing = {
      strokes: [
        {
          points: [
            { x: 0, y: 1 },
            { x: 0.5, y: 0.25 },
          ],
        },
      ],
    };
    const bytes = encodeDrawing(drawing);
    expect(bytes[0]).toBe(2);
    const decoded = decodeDrawing(bytes);
    expect(decoded.strokes[0].space).toBeUndefined();
    expect(decoded.strokes[0].points[1].x).toBeCloseTo(0.5, 4);
  });

  it("preserves signed, out-of-pond coordinates and mixed coordinate spaces", () => {
    const legacy: Stroke = { points: [{ x: 0, y: 1 }] };
    const stroke = anchored([
      { x: -375.125, y: 1200.5 },
      { x: 0.123456, y: -0.123456 },
    ]);
    const bytes = encodeDrawing({ strokes: [legacy, stroke] });
    expect(bytes[0]).toBe(3);
    const decoded = decodeDrawing(bytes);
    expect(decoded.strokes[0]).toEqual(legacy);
    expect(decoded.strokes[1].space).toBe("focused-discard");
    expect(decoded.strokes[1].points[0]).toEqual(stroke.points[0]);
    expect(decoded.strokes[1].points[1].x).toBeCloseTo(0.123456, 6);
    expect(decoded.strokes[1].points[1].y).toBeCloseTo(-0.123456, 6);
  });

  it("does not smooth anchored coordinates using the legacy normalized heuristic", () => {
    const stroke = anchored([
      { x: -10, y: 0 },
      { x: 0, y: 20 },
      { x: 10, y: 0 },
    ]);
    expect(smoothDrawingForDisplay({ strokes: [stroke] }).strokes[0]).toBe(
      stroke
    );
  });

  it("handles sliced buffers without reading outside their byte offset", () => {
    const bytes = encodeDrawing({ strokes: [anchored()] });
    const padded = new Uint8Array(bytes.length + 6);
    padded.set(bytes, 3);
    expect(decodeDrawing(padded.subarray(3, -3))).toEqual({
      strokes: [anchored()],
    });
  });

  it("rejects incomplete headers, truncated records, invalid tags and trailing bytes", () => {
    const valid = encodeDrawing({ strokes: [anchored()] });
    const invalidTag = valid.slice();
    invalidTag[2] = 255;
    const trailing = new Uint8Array(valid.length + 1);
    trailing.set(valid);
    for (const bytes of [
      new Uint8Array([3]),
      valid.subarray(0, 3),
      valid.subarray(0, -1),
      invalidTag,
      trailing,
      new Uint8Array([99]),
      new Uint8Array([99, 0]),
    ]) {
      expect(() => decodeDrawing(bytes)).toThrow(ReviewDrawingError);
    }
  });

  it.each([NaN, Infinity, -Infinity, Number.MAX_VALUE])(
    "rejects unrepresentable coordinates (%s)",
    (x) => {
      expect(() =>
        encodeDrawing({ strokes: [anchored([{ x, y: 0 }])] })
      ).toThrow("bad-drawing");
    }
  );

  it("rejects non-finite coordinates in a v3 payload", () => {
    const bytes = encodeDrawing({ strokes: [anchored()] });
    new DataView(bytes.buffer).setFloat32(5, NaN, true);
    expect(() => decodeDrawing(bytes)).toThrow("bad-drawing");
  });

  it("enforces the payload ceiling without truncating strokes or points", () => {
    const fitting = anchored(
      Array.from({ length: 8191 }, () => ({ x: -1, y: 2 }))
    );
    const bytes = encodeDrawing({ strokes: [fitting] });
    expect(bytes.length).toBeLessThanOrEqual(MAX_DRAWING_BYTES);
    expect(decodeDrawing(bytes).strokes[0].points).toHaveLength(8191);
    expect(() =>
      encodeDrawing({
        strokes: [anchored([...fitting.points, { x: 0, y: 0 }])],
      })
    ).toThrow("drawing-too-large");
    expect(() =>
      encodeDrawing({ strokes: Array.from({ length: 256 }, () => anchored()) })
    ).toThrow("drawing-too-large");
    expect(() =>
      encodeDrawing({
        strokes: [
          anchored(Array.from({ length: 65536 }, () => ({ x: 0, y: 0 }))),
        ],
      })
    ).toThrow("drawing-too-large");
    const oversized = new Uint8Array(MAX_DRAWING_BYTES + 1);
    oversized[0] = 3;
    expect(() => decodeDrawing(oversized)).toThrow("drawing-too-large");
  });
});
