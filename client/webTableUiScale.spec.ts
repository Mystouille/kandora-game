import { createElement, useRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  useWebTableUiScale,
  webTableUiScale,
  webTableUiStyle,
} from "./webTableUiScale";

describe("web table UI sizing", () => {
  it.each([
    [1920, 1080, 1],
    [1280, 900, 1],
    [1024, 768, 0.8],
    [1920, 720, 0.8],
    [960, 675, 0.75],
    [800, 600, 0.75],
    [640, 360, 0.75],
    [390, 844, 0.75],
    [844, 390, 0.75],
    [240, 160, 0.75],
  ])("scales a %i x %i viewport to %f", (width, height, expected) => {
    expect(webTableUiScale(width, height)).toBe(expected);
  });

  it.each([
    [0, 900],
    [1280, 0],
    [-1, 900],
    [NaN, 900],
    [1280, Infinity],
  ])("rejects invalid measured dimensions %s x %s", (width, height) => {
    expect(() => webTableUiScale(width, height)).toThrow(RangeError);
  });

  it("renders at normal size before the viewport can be measured", () => {
    function Viewport() {
      const ref = useRef<HTMLDivElement>(null);
      const scale = useWebTableUiScale(ref);
      return createElement("div", { ref, style: webTableUiStyle(scale) });
    }
    expect(renderToStaticMarkup(createElement(Viewport))).toContain(
      "--web-table-ui-scale:1"
    );
  });
});
