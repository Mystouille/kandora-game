import { useEffect, useRef } from "react";
import type { Stroke } from "~/game/replay/reviewDrawing";
import {
  DESIGN_W as TABLE_DESIGN_W,
  DESIGN_H as TABLE_DESIGN_H,
} from "~/game/client/pixi/tableLayout";

/**
 * Minimum spacing, in CSS pixels, between consecutive captured stroke
 * points. Small enough to keep curves smooth and faithful to the
 * pointer path, large enough to avoid storing redundant samples.
 */
const MIN_SAMPLE_CSS_PX = 1;

interface ReplayDrawingOverlayProps {
  /** Strokes to render. Coordinates are in normalized [0..1] space. */
  strokes: Stroke[];
  /**
   * When true, the overlay captures pointer events and starts
   * appending new strokes to the array via `onStrokesChange`. When
   * false the overlay is purely decorative (`pointer-events: none`).
   */
  drawing: boolean;
  /** Stroke color (CSS). Defaults to a high-contrast red. */
  color?: string;
  /** Stroke width in CSS pixels. Defaults to 3. */
  width?: number;
  /**
   * Aspect ratio (width / height) the drawable area should be
   * letterboxed to within the parent container. Defaults to the
   * Pixi table's design aspect (`tableLayout.DESIGN_W /
   * DESIGN_H`, ≈ 1.08 — close to a square) so the strokes stay
   * locked to the table when the window resizes. Stored stroke
   * coordinates are normalized against this letterboxed area,
   * not the raw container, so the artwork follows the table
   * through any resize.
   */
  aspectRatio?: number;
  onStrokesChange: (next: Stroke[]) => void;
}

/**
 * Absolute-positioned `<canvas>` overlay used by the replay review
 * cartridge. It does two jobs:
 *
 *   1. **Render** the saved strokes for the current event (always).
 *   2. **Capture** new strokes while the user is in "pen" mode.
 *
 * Coordinates are stored in normalized `[0..1]` so the same drawing
 * renders correctly regardless of the actual container size. Each
 * pointer-down starts a new stroke; pointer-move appends points;
 * pointer-up / -cancel ends it and notifies the parent.
 *
 * The component owns its canvas backing-store size (CSS rect × DPR)
 * but is a controlled component for the stroke list: the parent is
 * the source of truth.
 */
export function ReplayDrawingOverlay({
  strokes,
  drawing,
  color = "#ff3b3b",
  width = 3,
  aspectRatio = TABLE_DESIGN_W / TABLE_DESIGN_H,
  onStrokesChange,
}: ReplayDrawingOverlayProps) {
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const draftStrokeRef = useRef<Stroke | null>(null);
  // Latest committed strokes, accessible from the pointer-handler
  // effect's stable closure. Without this the live repaint during
  // a stroke would have to redraw using a stale `strokes` array.
  const strokesRef = useRef<Stroke[]>(strokes);
  strokesRef.current = strokes;

  /**
   * Render a single stroke as a smooth poly-curve using quadratic
   * Bezier midpoint smoothing. For each interior sample we treat
   * the sample as a control point and the midpoint with the next
   * sample as the curve endpoint — a cheap, well-known technique
   * that turns a noisy polyline into a curve that visually
   * interpolates the samples without overshooting them.
   */
  const drawStroke = (
    ctx: CanvasRenderingContext2D,
    stroke: Stroke,
    w: number,
    h: number
  ): void => {
    const pts = stroke.points;
    if (pts.length === 0) {
      return;
    }
    if (pts.length === 1) {
      // Single-tap: render as a filled dot so it's visible.
      const p = pts[0];
      ctx.beginPath();
      ctx.arc(p.x * w, p.y * h, ctx.lineWidth / 2, 0, Math.PI * 2);
      const prevFill = ctx.fillStyle;
      ctx.fillStyle = ctx.strokeStyle;
      ctx.fill();
      ctx.fillStyle = prevFill;
      return;
    }
    if (pts.length === 2) {
      ctx.beginPath();
      ctx.moveTo(pts[0].x * w, pts[0].y * h);
      ctx.lineTo(pts[1].x * w, pts[1].y * h);
      ctx.stroke();
      return;
    }
    ctx.beginPath();
    ctx.moveTo(pts[0].x * w, pts[0].y * h);
    for (let i = 1; i < pts.length - 1; i++) {
      const p = pts[i];
      const next = pts[i + 1];
      // Endpoint is the midpoint between the current and next
      // sample; the current sample becomes the curve's control
      // point. The chain of curves is C1-continuous at the
      // midpoints, which is what makes the path read as smooth.
      const midX = ((p.x + next.x) / 2) * w;
      const midY = ((p.y + next.y) / 2) * h;
      ctx.quadraticCurveTo(p.x * w, p.y * h, midX, midY);
    }
    // Close out with a straight segment to the final sample so
    // the curve actually reaches the user's last point.
    const last = pts[pts.length - 1];
    ctx.lineTo(last.x * w, last.y * h);
    ctx.stroke();
  };

  /** Full canvas repaint: clear + draw all committed + draft strokes. */
  const paintAll = (): void => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(rect.width * dpr));
    const h = Math.max(1, Math.round(rect.height * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return;
    }
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = color;
    // Snap the device-space width to a whole pixel (min 1) so the
    // stroke renders evenly on fractional-DPR displays (e.g. 1.5×),
    // where `width * dpr` would otherwise land on a half pixel and
    // read as a slightly soft, uneven line.
    ctx.lineWidth = Math.max(1, Math.round(width * dpr));
    for (const stroke of strokesRef.current) {
      drawStroke(ctx, stroke, canvas.width, canvas.height);
    }
    if (draftStrokeRef.current) {
      drawStroke(ctx, draftStrokeRef.current, canvas.width, canvas.height);
    }
  };

  /**
   * Resize the canvas's CSS box to the largest rectangle of the
   * configured `aspectRatio` that fits inside the wrapper, and
   * center it. Strokes are normalized to this box, so locking it
   * to the table's design aspect keeps the drawing aligned with
   * the table through every window/container resize.
   */
  const fitCanvasToWrapper = (): void => {
    const canvas = canvasRef.current;
    const wrapper = wrapperRef.current;
    if (!canvas || !wrapper) {
      return;
    }
    const rect = wrapper.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return;
    }
    const containerAspect = rect.width / rect.height;
    let cssW: number;
    let cssH: number;
    if (containerAspect > aspectRatio) {
      // Container is wider than the target — letterbox on the sides.
      cssH = rect.height;
      cssW = cssH * aspectRatio;
    } else {
      // Container is taller — letterbox on top/bottom.
      cssW = rect.width;
      cssH = cssW / aspectRatio;
    }
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;
    canvas.style.left = `${(rect.width - cssW) / 2}px`;
    canvas.style.top = `${(rect.height - cssH) / 2}px`;
  };

  // Repaint whenever the strokes change or the canvas resizes.
  useEffect(() => {
    fitCanvasToWrapper();
    paintAll();
    const wrapper = wrapperRef.current;
    if (!wrapper) {
      return;
    }
    const ro = new ResizeObserver(() => {
      fitCanvasToWrapper();
      paintAll();
    });
    ro.observe(wrapper);
    return () => {
      ro.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [strokes, color, width, aspectRatio]);

  // Pointer handlers — only active when `drawing` is true.
  useEffect(() => {
    if (!drawing) {
      draftStrokeRef.current = null;
      return;
    }
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    let activePointerId: number | null = null;

    const toNormalized = (
      clientX: number,
      clientY: number
    ): { x: number; y: number } => {
      const rect = canvas.getBoundingClientRect();
      const x = (clientX - rect.left) / Math.max(1, rect.width);
      const y = (clientY - rect.top) / Math.max(1, rect.height);
      return { x, y };
    };

    const onDown = (e: PointerEvent) => {
      if (activePointerId !== null) {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      activePointerId = e.pointerId;
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch {
        /* some browsers reject capture on already-captured pointers */
      }
      const pt = toNormalized(e.clientX, e.clientY);
      draftStrokeRef.current = { points: [pt] };
      paintAll();
    };
    const onMove = (e: PointerEvent) => {
      if (e.pointerId !== activePointerId || !draftStrokeRef.current) {
        return;
      }
      e.preventDefault();
      // PointerEvent.getCoalescedEvents() reports the sub-frame
      // pointer samples the browser bundled into this event.
      // Reading them gives us many more raw points per move
      // notification — the single biggest contribution to stroke
      // smoothness on high-refresh-rate pointers.
      const coalesced =
        typeof e.getCoalescedEvents === "function"
          ? e.getCoalescedEvents()
          : null;
      const events = coalesced && coalesced.length > 0 ? coalesced : [e];
      const points = draftStrokeRef.current.points;
      // Subsample using a CSS-pixel distance threshold so the captured
      // point density stays consistent regardless of the canvas size.
      // The v2 codec stores 16-bit coordinates, so this sub-pixel
      // spacing survives encode/decode without quantization loss —
      // unlike the old normalized 1/256 grid which both starved the
      // curve of points and snapped them to a coarse lattice.
      const rect = canvas.getBoundingClientRect();
      const cssW = Math.max(1, rect.width);
      const cssH = Math.max(1, rect.height);
      const minCssDistSq = MIN_SAMPLE_CSS_PX * MIN_SAMPLE_CSS_PX;
      for (const ev of events) {
        const pt = toNormalized(ev.clientX, ev.clientY);
        const last = points[points.length - 1];
        const dxPx = (pt.x - last.x) * cssW;
        const dyPx = (pt.y - last.y) * cssH;
        if (dxPx * dxPx + dyPx * dyPx < minCssDistSq) {
          continue;
        }
        points.push(pt);
      }
      paintAll();
    };
    const onUp = (e: PointerEvent) => {
      if (e.pointerId !== activePointerId) {
        return;
      }
      activePointerId = null;
      try {
        canvas.releasePointerCapture(e.pointerId);
      } catch {
        /* already released */
      }
      const draft = draftStrokeRef.current;
      draftStrokeRef.current = null;
      if (draft && draft.points.length > 0) {
        onStrokesChange([...strokesRef.current, draft]);
      }
    };

    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("pointercancel", onUp);
    return () => {
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointercancel", onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawing, onStrokesChange, color, width]);

  return (
    <div
      ref={wrapperRef}
      className="absolute inset-0"
      style={{
        // Sits above the Pixi canvas and HUD (z-30) but below the
        // cartridge buttons (z-50) so the user can always reach
        // the toolbar to cancel / save. The wrapper is full-bleed
        // so we can measure its size for the letterbox math, but
        // it never captures pointer events itself — only the
        // letterboxed canvas does, and only while drawing.
        zIndex: 45,
        pointerEvents: "none",
      }}
    >
      <canvas
        ref={canvasRef}
        style={{
          position: "absolute",
          display: "block",
          // Concrete CSS dimensions and offsets are written by
          // `fitCanvasToWrapper` so the canvas covers exactly the
          // letterboxed table area inside the wrapper.
          pointerEvents: drawing ? "auto" : "none",
          touchAction: "none",
          cursor: drawing ? "crosshair" : "default",
        }}
      />
    </div>
  );
}
