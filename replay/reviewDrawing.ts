/**
 * Compact polyline codec for `ReplayReview` freehand drawings.
 *
 * A "drawing" is a list of strokes; each stroke is a list of points
 * in either legacy table-normalized space or focused-discard space.
 *
 * Three on-the-wire versions exist:
 *
 *   v1 (legacy, decode-only): 8 bits per axis — only 256 distinct
 *   steps across the whole drawing. On a large canvas that grid is
 *   several physical pixels wide, which is what made older saved
 *   annotations look "pixelated" once decoded. Still read so existing
 *   reviews keep rendering.
 *
 *   v2 (legacy, encode + decode): 16 bits per normalized axis.
 *   Legacy-only drawings continue to encode as v2.
 *
 *   v3: per-stroke space tag, followed by a uint16 point count.
 *   Tag 0 stores legacy uint16 pairs; tag 1 stores signed float32
 *   pairs in unscaled focused-discard coordinates. Mixed drawings
 *   preserve old strokes without inferring or migrating their targets.
 *
 * Binary layout (little-endian):
 *
 *   byte 0:     version (1, 2 or 3)
 *   byte 1:     stroke count N (max 255)
 *   for each stroke:
 *     v3 only:  space tag (0=legacy table, 1=focused discard)
 *     bytes 0..1:  point count M (uint16 LE, max 65535)
 *     bytes 2..:   M × coordinate pair
 *                    v1: (uint8  x,      uint8  y)      — 2 bytes/point
 *                    v2: (uint16 x LE,   uint16 y LE)   — 4 bytes/point
 *                    v3 tag 1: (float32 x, float32 y)  — 8 bytes/point
 *
 * A 50-point v2 stroke costs 2 + 200 = 202 bytes; a typical 5-stroke
 * arrow annotation is still comfortably under 2 KB.
 */

export interface Stroke {
  /** Absent for legacy table-normalized strokes. */
  space?: "focused-discard";
  /** Focused-discard points are signed and may extend outside the pond. */
  points: Array<{ x: number; y: number }>;
}

export interface Drawing {
  strokes: Stroke[];
}

export const MAX_DRAWING_BYTES = 64 * 1024;

export class ReviewDrawingError extends Error {
  constructor(readonly code: "bad-drawing" | "drawing-too-large") {
    super(code);
    this.name = "ReviewDrawingError";
  }
}

/**
 * Per-reviewer color palette for the collaborative review overlay.
 * A reviewer's index is their position in the review's ordered
 * `reviewers` list (i.e. the order in which they first contributed a
 * text note or drawing), so the 1st reviewer is always orange, the
 * 2nd blue, etc. Applied to both the reviewer's freehand strokes and
 * their bold name in the text bubble. Indices beyond the palette wrap
 * around so we never run out of colors.
 */
export const REVIEWER_COLORS: readonly string[] = [
  "#f97316", // orange
  "#3b82f6", // blue
  "#22c55e", // green
  "#a855f7", // purple
  "#ec4899", // pink
  "#14b8a6", // teal
];

/** Resolve a reviewer's stroke / label color from their order index. */
export function reviewerColor(index: number): string {
  if (!Number.isFinite(index) || index < 0) {
    return REVIEWER_COLORS[0];
  }
  return REVIEWER_COLORS[index % REVIEWER_COLORS.length];
}

/** Legacy 8-bit-per-axis format. Decoded for backward compatibility. */
const VERSION_V1 = 1;
/** Legacy 16-bit-per-axis format. */
const VERSION_V2 = 2;
const VERSION_V3 = 3;
/** Max quantized value for the v2 16-bit-per-axis grid. */
const V2_SCALE = 65535;

const clamp01 = (v: number): number => {
  if (v < 0) {
    return 0;
  }
  if (v > 1) {
    return 1;
  }
  return v;
};

export function encodeDrawing(drawing: Drawing): Uint8Array {
  if (drawing.strokes.some((stroke) => stroke.space === "focused-discard")) {
    return encodeV3(drawing);
  }
  return encodeV2(drawing);
}

function encodeV2(drawing: Drawing): Uint8Array {
  const strokes = drawing.strokes.slice(0, 255);
  // Pre-compute the buffer size (v2 stores 4 bytes per point).
  let size = 2;
  for (const stroke of strokes) {
    const m = Math.min(stroke.points.length, 65535);
    size += 2 + m * 4;
  }
  const buf = new Uint8Array(size);
  buf[0] = VERSION_V2;
  buf[1] = strokes.length;
  let offset = 2;
  for (const stroke of strokes) {
    const m = Math.min(stroke.points.length, 65535);
    buf[offset] = m & 0xff;
    buf[offset + 1] = (m >> 8) & 0xff;
    offset += 2;
    for (let i = 0; i < m; i++) {
      const p = stroke.points[i];
      const x = Math.round(clamp01(p.x) * V2_SCALE);
      const y = Math.round(clamp01(p.y) * V2_SCALE);
      buf[offset] = x & 0xff;
      buf[offset + 1] = (x >> 8) & 0xff;
      buf[offset + 2] = y & 0xff;
      buf[offset + 3] = (y >> 8) & 0xff;
      offset += 4;
    }
  }
  return buf;
}

function encodeV3(drawing: Drawing): Uint8Array {
  if (drawing.strokes.length > 255) {
    throw new ReviewDrawingError("drawing-too-large");
  }
  let size = 2;
  for (const stroke of drawing.strokes) {
    if (stroke.points.length > 65535) {
      throw new ReviewDrawingError("drawing-too-large");
    }
    size += 3 + stroke.points.length * (stroke.space ? 8 : 4);
  }
  if (size > MAX_DRAWING_BYTES) {
    throw new ReviewDrawingError("drawing-too-large");
  }
  const buf = new Uint8Array(size);
  const view = new DataView(buf.buffer);
  buf[0] = VERSION_V3;
  buf[1] = drawing.strokes.length;
  let offset = 2;
  for (const stroke of drawing.strokes) {
    const anchored = stroke.space === "focused-discard";
    buf[offset] = anchored ? 1 : 0;
    view.setUint16(offset + 1, stroke.points.length, true);
    offset += 3;
    for (const point of stroke.points) {
      if (
        !Number.isFinite(Math.fround(point.x)) ||
        !Number.isFinite(Math.fround(point.y))
      ) {
        throw new ReviewDrawingError("bad-drawing");
      }
      if (anchored) {
        view.setFloat32(offset, point.x, true);
        view.setFloat32(offset + 4, point.y, true);
        offset += 8;
      } else {
        view.setUint16(offset, Math.round(clamp01(point.x) * V2_SCALE), true);
        view.setUint16(
          offset + 2,
          Math.round(clamp01(point.y) * V2_SCALE),
          true
        );
        offset += 4;
      }
    }
  }
  return buf;
}

function decodeV3(buf: Uint8Array): Drawing {
  if (buf.length > MAX_DRAWING_BYTES) {
    throw new ReviewDrawingError("drawing-too-large");
  }
  if (buf.length < 2) {
    throw new ReviewDrawingError("bad-drawing");
  }
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const strokes: Stroke[] = [];
  let offset = 2;
  for (let s = 0; s < buf[1]; s++) {
    if (offset + 3 > buf.length) {
      throw new ReviewDrawingError("bad-drawing");
    }
    const tag = buf[offset];
    const count = view.getUint16(offset + 1, true);
    offset += 3;
    if (tag !== 0 && tag !== 1) {
      throw new ReviewDrawingError("bad-drawing");
    }
    const stride = tag === 1 ? 8 : 4;
    if (offset + count * stride > buf.length) {
      throw new ReviewDrawingError("bad-drawing");
    }
    const stroke: Stroke = { points: [] };
    if (tag === 1) {
      stroke.space = "focused-discard";
    }
    for (let i = 0; i < count; i++) {
      const x =
        tag === 1
          ? view.getFloat32(offset, true)
          : view.getUint16(offset, true) / V2_SCALE;
      const y =
        tag === 1
          ? view.getFloat32(offset + 4, true)
          : view.getUint16(offset + 2, true) / V2_SCALE;
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        throw new ReviewDrawingError("bad-drawing");
      }
      stroke.points.push({ x, y });
      offset += stride;
    }
    strokes.push(stroke);
  }
  if (offset !== buf.length) {
    throw new ReviewDrawingError("bad-drawing");
  }
  return { strokes };
}

/** Decode the legacy v1 payload (8 bits per axis). */
function decodeV1(buf: Uint8Array): Drawing {
  const strokeCount = buf[1];
  const strokes: Stroke[] = [];
  let offset = 2;
  for (let s = 0; s < strokeCount; s++) {
    if (offset + 2 > buf.length) {
      break;
    }
    const m = buf[offset] | (buf[offset + 1] << 8);
    offset += 2;
    const points: Array<{ x: number; y: number }> = [];
    for (let i = 0; i < m; i++) {
      if (offset + 2 > buf.length) {
        break;
      }
      points.push({
        x: buf[offset] / 255,
        y: buf[offset + 1] / 255,
      });
      offset += 2;
    }
    strokes.push({ points });
  }
  return { strokes };
}

/** Decode the current v2 payload (16 bits per axis). */
function decodeV2(buf: Uint8Array): Drawing {
  const strokeCount = buf[1];
  const strokes: Stroke[] = [];
  let offset = 2;
  for (let s = 0; s < strokeCount; s++) {
    if (offset + 2 > buf.length) {
      break;
    }
    const m = buf[offset] | (buf[offset + 1] << 8);
    offset += 2;
    const points: Array<{ x: number; y: number }> = [];
    for (let i = 0; i < m; i++) {
      if (offset + 4 > buf.length) {
        break;
      }
      const x = buf[offset] | (buf[offset + 1] << 8);
      const y = buf[offset + 2] | (buf[offset + 3] << 8);
      points.push({
        x: x / V2_SCALE,
        y: y / V2_SCALE,
      });
      offset += 4;
    }
    strokes.push({ points });
  }
  return { strokes };
}

export function decodeDrawing(buf: Uint8Array): Drawing {
  switch (buf[0]) {
    case VERSION_V1:
      return buf.length < 2 ? { strokes: [] } : decodeV1(buf);
    case VERSION_V2:
      return buf.length < 2 ? { strokes: [] } : decodeV2(buf);
    case VERSION_V3:
      return decodeV3(buf);
    default:
      if (buf.length === 0) {
        return { strokes: [] };
      }
      throw new ReviewDrawingError("bad-drawing");
  }
}

/** Average-segment length (normalized) above which a stroke reads as
 * "coarse". Legacy v1 captures were forced at least 1/256 apart, so
 * they always clear this bar; high-precision v2 captures sit well
 * below it and are therefore left untouched. */
const COARSE_AVG_SEG = 1 / 300;
/** Chaikin passes applied to a coarse stroke (each pass ×2 detail). */
const SMOOTH_ITERATIONS = 2;

/**
 * One Chaikin corner-cutting pass over an open polyline. Endpoints are
 * preserved; each interior corner is replaced by two points at the
 * 1/4 and 3/4 marks of its adjacent edge, which rounds the corner.
 */
function chaikinPass(
  pts: Array<{ x: number; y: number }>
): Array<{ x: number; y: number }> {
  const out: Array<{ x: number; y: number }> = [pts[0]];
  for (let i = 0; i < pts.length - 1; i++) {
    const p = pts[i];
    const q = pts[i + 1];
    out.push({ x: p.x * 0.75 + q.x * 0.25, y: p.y * 0.75 + q.y * 0.25 });
    out.push({ x: p.x * 0.25 + q.x * 0.75, y: p.y * 0.25 + q.y * 0.75 });
  }
  out.push(pts[pts.length - 1]);
  return out;
}

function smoothStrokeForDisplay(stroke: Stroke): Stroke {
  if (stroke.space === "focused-discard") {
    return stroke;
  }
  const pts = stroke.points;
  // Dots and single segments carry no curvature to smooth.
  if (pts.length < 3) {
    return stroke;
  }
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    const dx = pts[i].x - pts[i - 1].x;
    const dy = pts[i].y - pts[i - 1].y;
    total += Math.sqrt(dx * dx + dy * dy);
  }
  // Dense strokes already render smoothly; smoothing them would only
  // round off intentional detail and waste work.
  if (total / (pts.length - 1) < COARSE_AVG_SEG) {
    return stroke;
  }
  let cur = pts;
  for (let i = 0; i < SMOOTH_ITERATIONS; i++) {
    cur = chaikinPass(cur);
  }
  return { points: cur };
}

/**
 * Smooth a decoded drawing for display by rounding off the coarse
 * quantization staircase left by the legacy v1 (8-bit grid) codec.
 *
 * Chaikin corner-cutting is applied only to strokes whose samples are
 * sparse enough that the grid is visible. Dense strokes — notably
 * everything captured under the high-precision v2 path — fall below
 * the threshold and are returned untouched, so intentional sharp
 * corners and fine detail are preserved and no needless work is done.
 */
export function smoothDrawingForDisplay(drawing: Drawing): Drawing {
  return { strokes: drawing.strokes.map(smoothStrokeForDisplay) };
}

/** Base64 helpers (browser + Node compatible). */
export function bytesToBase64(buf: Uint8Array): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(buf).toString("base64");
  }
  let s = "";
  for (let i = 0; i < buf.length; i++) {
    s += String.fromCharCode(buf[i]);
  }
  return btoa(s);
}

export function base64ToBytes(b64: string): Uint8Array {
  if (typeof Buffer !== "undefined") {
    return new Uint8Array(Buffer.from(b64, "base64"));
  }
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}
