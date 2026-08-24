import { describe, expect, it } from "vitest";
import {
  tableLayoutFromConfig,
  validateTableLayoutConfig,
} from "../tableLayout";
import {
  MOBILE_PLAY_AREA_INSET,
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
      w: mobileTableLayout.viewport.w,
    });
  });

  it("packs full discard ponds between the top and focused hands", () => {
    const layout = tableLayoutFromConfig(mobileTableLayout);

    expect(layout.discards[2].y).toBe(105);
    expect(layout.center.y).toBe(225);
    expect(layout.discards[0].y).toBe(445);
    expect(layout.hands[0].y).toBe(605);
  });

  it("narrows and recenters the center cross", () => {
    const layout = tableLayoutFromConfig(mobileTableLayout);

    expect(layout.center).toEqual({ x: 508, y: 225, w: 264, h: 220 });
    expect(layout.center.x + layout.center.w / 2).toBe(640);
    expect(layout.discards[3].x + layout.discards[3].w).toBe(
      layout.center.x
    );
    expect(layout.discards[1].x).toBe(layout.center.x + layout.center.w);
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