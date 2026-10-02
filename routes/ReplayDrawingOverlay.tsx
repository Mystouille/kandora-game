import { useEffect, useRef } from "react";
import type { Stroke } from "~/game/replay/reviewDrawing";
import { ACTIVE_TABLE_LAYOUT } from "~/game/client/pixi/layouts/activeTableLayout";
import {
  fromFocusedDiscardPoint,
  sameFocusedDiscardFrame,
  toFocusedDiscardPoint,
  type FocusedDiscardDrawingFrame,
} from "~/game/client/pixi/geometry/reviewDrawingGeometry";

const MIN_SAMPLE_CSS_PX = 1;
const TABLE_ASPECT =
  ACTIVE_TABLE_LAYOUT.viewport.w / ACTIVE_TABLE_LAYOUT.viewport.h;

interface ReplayDrawingOverlayProps {
  strokes: Stroke[];
  drawing: boolean;
  frame: FocusedDiscardDrawingFrame | null;
  /** Changes when the review event or perspective changes. */
  contextKey?: string;
  color?: string;
  width?: number;
  /** Used only before renderer geometry is available, for legacy strokes. */
  aspectRatio?: number;
  onStrokesChange: (next: Stroke[]) => void;
}

function drawStroke(
  ctx: CanvasRenderingContext2D,
  stroke: Stroke,
  frame: FocusedDiscardDrawingFrame | null,
  w: number,
  h: number
): void {
  if (stroke.space && !frame) {
    return;
  }
  const pts = stroke.points.map((point) => {
    if (stroke.space === "focused-discard" && frame) {
      const projected = fromFocusedDiscardPoint(point, frame);
      return {
        x: ((projected.x - frame.table.x) / frame.table.w) * w,
        y: ((projected.y - frame.table.y) / frame.table.h) * h,
      };
    }
    return { x: point.x * w, y: point.y * h };
  });
  if (pts.length === 0) {
    return;
  }
  ctx.beginPath();
  if (pts.length === 1) {
    ctx.arc(pts[0].x, pts[0].y, ctx.lineWidth / 2, 0, Math.PI * 2);
    ctx.fillStyle = ctx.strokeStyle;
    ctx.fill();
    return;
  }
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length - 1; i++) {
    const p = pts[i];
    const next = pts[i + 1];
    ctx.quadraticCurveTo(p.x, p.y, (p.x + next.x) / 2, (p.y + next.y) / 2);
  }
  const last = pts[pts.length - 1];
  ctx.lineTo(last.x, last.y);
  ctx.stroke();
}

export function ReplayDrawingOverlay({
  strokes,
  drawing,
  frame,
  contextKey = "",
  color = "#ff3b3b",
  width = 3,
  aspectRatio = TABLE_ASPECT,
  onStrokesChange,
}: ReplayDrawingOverlayProps) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const configRef = useRef({
    strokes,
    drawing,
    frame,
    contextKey,
    color,
    width,
    aspectRatio,
    onStrokesChange,
  });
  configRef.current = {
    strokes,
    drawing,
    frame,
    contextKey,
    color,
    width,
    aspectRatio,
    onStrokesChange,
  };
  const updateRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const wrapper = wrapperRef.current;
    const canvas = canvasRef.current;
    if (!wrapper || !canvas) {
      return;
    }
    let draft: {
      pointerId: number;
      stroke: Stroke;
      frame: FocusedDiscardDrawingFrame;
      contextKey: string;
    } | null = null;

    const paint = (): void => {
      const config = configRef.current;
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
      ctx.clearRect(0, 0, w, h);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.strokeStyle = config.color;
      ctx.lineWidth = Math.max(1, Math.round(config.width * dpr));
      for (const stroke of config.strokes) {
        drawStroke(ctx, stroke, config.frame, w, h);
      }
      if (draft) {
        drawStroke(ctx, draft.stroke, draft.frame, w, h);
      }
    };

    const finish = (commit: boolean): void => {
      const completed = draft;
      draft = null;
      if (!completed) {
        return;
      }
      if (canvas.hasPointerCapture(completed.pointerId)) {
        canvas.releasePointerCapture(completed.pointerId);
      }
      const config = configRef.current;
      if (
        commit &&
        config.drawing &&
        completed.contextKey === config.contextKey
      ) {
        config.onStrokesChange([...config.strokes, completed.stroke]);
      }
    };

    const fit = (): void => {
      const config = configRef.current;
      const rect = wrapper.getBoundingClientRect();
      let table = config.frame?.table;
      if (!table) {
        const w = Math.min(rect.width, rect.height * config.aspectRatio);
        const h = w / config.aspectRatio;
        table = { x: (rect.width - w) / 2, y: (rect.height - h) / 2, w, h };
      }
      canvas.style.width = `${table.w}px`;
      canvas.style.height = `${table.h}px`;
      canvas.style.left = `${table.x}px`;
      canvas.style.top = `${table.y}px`;
    };

    const update = (): void => {
      const config = configRef.current;
      if (
        draft &&
        (!config.drawing ||
          draft.contextKey !== config.contextKey ||
          !sameFocusedDiscardFrame(draft.frame, config.frame))
      ) {
        finish(true);
      }
      fit();
      paint();
    };
    updateRef.current = update;

    const sample = (
      event: PointerEvent,
      currentFrame: FocusedDiscardDrawingFrame
    ) => {
      const rect = wrapper.getBoundingClientRect();
      return toFocusedDiscardPoint(
        { x: event.clientX - rect.left, y: event.clientY - rect.top },
        currentFrame
      );
    };
    const onDown = (event: PointerEvent): void => {
      const config = configRef.current;
      if (draft || !config.drawing || !config.frame || event.button !== 0) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      canvas.setPointerCapture(event.pointerId);
      draft = {
        pointerId: event.pointerId,
        frame: config.frame,
        contextKey: config.contextKey,
        stroke: {
          space: "focused-discard",
          points: [sample(event, config.frame)],
        },
      };
      paint();
    };
    const onMove = (event: PointerEvent): void => {
      if (!draft || draft.pointerId !== event.pointerId) {
        return;
      }
      const config = configRef.current;
      if (
        !config.drawing ||
        draft.contextKey !== config.contextKey ||
        !sameFocusedDiscardFrame(draft.frame, config.frame)
      ) {
        update();
        return;
      }
      event.preventDefault();
      const coalesced = event.getCoalescedEvents?.();
      const events = coalesced?.length ? coalesced : [event];
      for (const next of events) {
        const point = sample(next, draft.frame);
        const last = draft.stroke.points[draft.stroke.points.length - 1];
        const distance =
          Math.hypot(point.x - last.x, point.y - last.y) * draft.frame.scale;
        if (distance >= MIN_SAMPLE_CSS_PX) {
          draft.stroke.points.push(point);
        }
      }
      paint();
    };
    const onUp = (event: PointerEvent): void => {
      if (draft?.pointerId === event.pointerId) {
        finish(true);
        paint();
      }
    };
    const onResize = (): void => {
      finish(true);
      update();
    };
    const observer = new ResizeObserver(onResize);
    observer.observe(wrapper);
    window.addEventListener("resize", onResize);
    let resolution = window.matchMedia(
      `(resolution: ${window.devicePixelRatio}dppx)`
    );
    const onResolutionChange = (): void => {
      resolution.removeEventListener("change", onResolutionChange);
      resolution = window.matchMedia(
        `(resolution: ${window.devicePixelRatio}dppx)`
      );
      resolution.addEventListener("change", onResolutionChange);
      onResize();
    };
    resolution.addEventListener("change", onResolutionChange);
    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("pointercancel", onUp);
    update();
    return () => {
      finish(false);
      updateRef.current = null;
      observer.disconnect();
      resolution.removeEventListener("change", onResolutionChange);
      window.removeEventListener("resize", onResize);
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointercancel", onUp);
    };
  }, []);

  useEffect(() => {
    updateRef.current?.();
  }, [strokes, drawing, frame, contextKey, color, width, aspectRatio]);

  return (
    <div
      ref={wrapperRef}
      className="absolute inset-0"
      style={{ zIndex: 45, pointerEvents: "none" }}
    >
      <canvas
        ref={canvasRef}
        aria-label="Review drawing"
        style={{
          position: "absolute",
          display: "block",
          pointerEvents: drawing && frame ? "auto" : "none",
          touchAction: "none",
          cursor: drawing && frame ? "crosshair" : "default",
        }}
      />
    </div>
  );
}
