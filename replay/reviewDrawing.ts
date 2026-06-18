/**
 * Compact polyline codec for `ReplayReview` freehand drawings.
 *
 * A "drawing" is a list of strokes; each stroke is a list of points
 * in a normalized coordinate space (so the same drawing renders
 * correctly regardless of the actual canvas size).
 *
 * Two on-the-wire versions exist:
 *
 *   v1 (legacy, decode-only): 8 bits per axis — only 256 distinct
 *   steps across the whole drawing. On a large canvas that grid is
 *   several physical pixels wide, which is what made older saved
 *   annotations look "pixelated" once decoded. Still read so existing
 *   reviews keep rendering.
 *
 *   v2 (current, encode + decode): 16 bits per axis (65536 steps),
 *   removing the visible quantization grid. All new drawings encode
 *   as v2.
 *
 * Binary layout (little-endian):
 *
 *   byte 0:     version (1 or 2)
 *   byte 1:     stroke count N (max 255)
 *   for each stroke:
 *     bytes 0..1:  point count M (uint16 LE, max 65535)
 *     bytes 2..:   M × coordinate pair
 *                    v1: (uint8  x,      uint8  y)      — 2 bytes/point
 *                    v2: (uint16 x LE,   uint16 y LE)   — 4 bytes/point
 *
 * A 50-point v2 stroke costs 2 + 200 = 202 bytes; a typical 5-stroke
 * arrow annotation is still comfortably under 2 KB.
 */

export interface Stroke {
  /** Normalized [0..1] point coordinates. */
  points: Array<{ x: number; y: number }>;
}

export interface Drawing {
  strokes: Stroke[];
}

/** Legacy 8-bit-per-axis format. Decoded for backward compatibility. */
const VERSION_V1 = 1;
/** Current 16-bit-per-axis format. All new drawings encode as v2. */
const VERSION_V2 = 2;
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
  if (buf.length < 2) {
    return { strokes: [] };
  }
  switch (buf[0]) {
    case VERSION_V1:
      return decodeV1(buf);
    case VERSION_V2:
      return decodeV2(buf);
    default:
      return { strokes: [] };
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
