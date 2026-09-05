import { describe, expect, it } from "vitest";
import { localRectToTable, seatTransform } from "../seatTransform";
import {
  tableLayoutFromConfig,
  validateTableLayoutConfig,
} from "../tableLayout";
import { potentialDiscardBounds } from "../tileAreaLayout";
import { tenhouTileDesign } from "../tiles/designs/tenhouTileDesign";
import {
  MOBILE_DISCARD_PANEL_PADDING,
  MOBILE_PLAY_AREA_INSET,
  mobileDiscardLayoutOptions,
  mobileTableLayout,
} from "./mobileTableLayout";

describe("mobileTableLayout", () => {
  it("defines a valid landscape layout", () => {
    expect(validateTableLayoutConfig(mobileTableLayout)).toEqual([]);
    expect(mobileTableLayout.viewport.w).toBeGreaterThan(
      mobileTableLayout.viewport.h
    );
  });

  it("gives the focused hand the full viewport width", () => {
    const layout = tableLayoutFromConfig(mobileTableLayout);

    expect(layout.hands[0]).toMatchObject({
      x: 0,
      y: 585,
      w: mobileTableLayout.viewport.w,
      h: 135,
    });
  });

  it("packs full discard ponds between the top and focused hands", () => {
    const layout = tableLayoutFromConfig(mobileTableLayout);

    expect(layout.discards[2].y).toBe(105);
    expect(layout.center.y).toBe(225);
    expect(layout.discards[0].y).toBe(425);
    expect(layout.hands[0].y).toBe(585);
  });

  it("narrows and recenters the center cross", () => {
    const layout = tableLayoutFromConfig(mobileTableLayout);

    expect(layout.center).toEqual({ x: 512, y: 225, w: 256, h: 200 });
    expect(layout.center.x + layout.center.w / 2).toBe(640);
    expect(layout.discards[3].x + layout.discards[3].w).toBe(
      layout.center.x
    );
    expect(layout.discards[1].x).toBe(layout.center.x + layout.center.w);
  });

  it("uses one discard scale with no inner mat padding", () => {
    const layout = tableLayoutFromConfig(mobileTableLayout);
    const options = mobileDiscardLayoutOptions(tenhouTileDesign, layout);

    expect(MOBILE_DISCARD_PANEL_PADDING).toBe(0);
    expect(options.scale).toBeGreaterThan(0);
    expect(options.offsetX).toBeUndefined();
    expect(options.offsetY).toBeUndefined();
  });

  it("keeps every full discard mat flush with its center-facing edge", () => {
    const layout = tableLayoutFromConfig(mobileTableLayout);
    const panels = ([0, 1, 2, 3] as const).map((seat) => {
      const options = mobileDiscardLayoutOptions(tenhouTileDesign, layout);
      const localBounds = potentialDiscardBounds(
        tenhouTileDesign,
        seat,
        18,
        options
      );
      const bounds = localRectToTable(
        seatTransform(seat),
        layout.discards[seat],
        localBounds
      );
      return {
        x: bounds.x - MOBILE_DISCARD_PANEL_PADDING,
        y: bounds.y - MOBILE_DISCARD_PANEL_PADDING,
        w: bounds.w + MOBILE_DISCARD_PANEL_PADDING * 2,
        h: bounds.h + MOBILE_DISCARD_PANEL_PADDING * 2,
      };
    });

    expect(panels[0].w).toBeCloseTo(layout.center.w, 8);
    expect(panels[2].w).toBeCloseTo(layout.center.w, 8);
    expect(panels[1].h).toBeCloseTo(panels[3].h, 8);
    expect(panels[1].h).toBeGreaterThan(layout.center.h);
    expect(panels[0].y).toBeCloseTo(
      layout.center.y + layout.center.h,
      8
    );
    expect(panels[1].x).toBeCloseTo(
      layout.center.x + layout.center.w,
      8
    );
    expect(panels[2].y + panels[2].h).toBeCloseTo(layout.center.y, 8);
    expect(panels[3].x + panels[3].w).toBeCloseTo(layout.center.x, 8);
    expect(panels[0].y + panels[0].h).toBeLessThan(layout.hands[0].y);
    expect(panels[2].y).toBeGreaterThan(
      layout.hands[2].y + layout.hands[2].h
    );
  });

  it("narrows the play area while leaving the focused hand full-width", () => {
    expect(mobileTableLayout.felt).toEqual({
      x: MOBILE_PLAY_AREA_INSET,
      y: 0,
      w: 1280 - MOBILE_PLAY_AREA_INSET * 2,
      h: 720,
    });
    expect(mobileTableLayout.zones.hands[0]).toMatchObject({ x: 0, w: 1280 });
    expect(mobileTableLayout.zones.hands[3].x).toBe(MOBILE_PLAY_AREA_INSET);
    expect(
      mobileTableLayout.zones.hands[1].x +
        mobileTableLayout.zones.hands[1].w
    ).toBe(1280 - MOBILE_PLAY_AREA_INSET);
    expect(Math.max(...mobileTableLayout.zones.walls.map((wall) => wall.w))).toBe(
      680
    );
    expect(Math.min(...mobileTableLayout.zones.walls.map((wall) => wall.h))).toBe(
      10
    );
  });
});