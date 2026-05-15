/**
 * Compact polyline codec for `ReplayReview` freehand drawings.
 *
 * A "drawing" is a list of strokes; each stroke is a list of points
 * in a normalized 256×256 coordinate space (so the same drawing
 * renders correctly regardless of the actual canvas size).
 *
 * Binary layout (little-endian):
 *
 *   byte 0:     version (=1)
 *   byte 1:     stroke count N (max 255)
 *   for each stroke:
 *     bytes 0..1:  point count M (uint16 LE, max 65535)
 *     bytes 2..:   M × (uint8 x, uint8 y)
 *
 * A 50-point stroke costs 2 + 100 = 102 bytes; a typical 5-stroke
 * arrow annotation is well under 1 KB.
 */

export interface Stroke {
  /** Normalized [0..1] point coordinates. */
  points: Array<{ x: number; y: number }>;
}

export interface Drawing {
  strokes: Stroke[];
}

const VERSION = 1;

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
  // Pre-compute the buffer size.
  let size = 2;
  for (const stroke of strokes) {
    const m = Math.min(stroke.points.length, 65535);
    size += 2 + m * 2;
  }
  const buf = new Uint8Array(size);
  buf[0] = VERSION;
  buf[1] = strokes.length;
  let offset = 2;
  for (const stroke of strokes) {
    const m = Math.min(stroke.points.length, 65535);
    buf[offset] = m & 0xff;
    buf[offset + 1] = (m >> 8) & 0xff;
    offset += 2;
    for (let i = 0; i < m; i++) {
      const p = stroke.points[i];
      buf[offset] = Math.round(clamp01(p.x) * 255);
      buf[offset + 1] = Math.round(clamp01(p.y) * 255);
      offset += 2;
    }
  }
  return buf;
}

export function decodeDrawing(buf: Uint8Array): Drawing {
  if (buf.length < 2 || buf[0] !== VERSION) {
    return { strokes: [] };
  }
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
