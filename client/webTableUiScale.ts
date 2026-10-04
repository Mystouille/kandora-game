import { useEffect, useState, type CSSProperties, type RefObject } from "react";
import "./webTableUi.css";

export const WEB_TABLE_UI_MIN_SCALE = 0.75;
export const WEB_TABLE_UI_REFERENCE_SIZE = { width: 1280, height: 900 };

export function webTableUiScale(width: number, height: number): number {
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    throw new RangeError(
      "Web table UI dimensions must be positive and finite."
    );
  }
  return Math.max(
    WEB_TABLE_UI_MIN_SCALE,
    Math.min(
      1,
      width / WEB_TABLE_UI_REFERENCE_SIZE.width,
      height / WEB_TABLE_UI_REFERENCE_SIZE.height
    )
  );
}

export function webTableUiStyle(scale: number): CSSProperties & {
  "--web-table-ui-scale": number;
} {
  return { "--web-table-ui-scale": scale };
}

export function useWebTableUiScale(
  viewportRef: RefObject<HTMLElement | null>
): number {
  const [scale, setScale] = useState(1);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }
    let frame: number | null = null;
    const measure = (): void => {
      frame = null;
      const { clientWidth: width, clientHeight: height } = viewport;
      if (width > 0 && height > 0) {
        viewport.style.setProperty("--web-table-ui-height", `${height}px`);
        setScale(webTableUiScale(width, height));
      }
    };
    const schedule = (): void => {
      if (frame === null) {
        frame = requestAnimationFrame(measure);
      }
    };
    measure();
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(schedule);
    if (observer) {
      observer.observe(viewport);
    } else {
      window.addEventListener("resize", schedule);
    }
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", schedule);
      viewport.style.removeProperty("--web-table-ui-height");
      if (frame !== null) {
        cancelAnimationFrame(frame);
      }
    };
  }, [viewportRef]);

  return scale;
}
