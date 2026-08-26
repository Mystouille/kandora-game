import { describe, expect, it } from "vitest";
import { containsRect } from "../tableGeometry";
import { localRectToTable, seatTransform } from "../seatTransform";
import {
  tableLayoutFromConfig,
  validateTableLayoutConfig,
} from "../tableLayout";
import {
  potentialDiscardBounds,
} from "../tileAreaLayout";
import { tenhouTileDesign } from "../tiles/designs/tenhouTileDesign";
import { compactWebTableLayout } from "./compactWebTableLayout";
import { currentTableLayout } from "./currentTableLayout";
import {
  COMPACT_DISCARD_PANEL_PADDING,
  webDiscardLayoutOptions,
  webTableLayoutConfig,
} from "./webTableLayout";

describe("compactWebTableLayout", () => {
  const layout = tableLayoutFromConfig(compactWebTableLayout);

  it("defines a valid secondary layout with regular web hands", () => {
    expect(validateTableLayoutConfig(compactWebTableLayout)).toEqual([]);
    expect(compactWebTableLayout.viewport).toEqual({ w: 1000, h: 926 });
    expect(compactWebTableLayout.felt).toEqual({
      x: 0,
      y: 0,
      w: 1000,
      h: 926,
    });
    expect(layout.hands).toEqual(currentTableLayout.zones.hands);
  });

  it("packs a symmetric discard cross around the enlarged center", () => {
    const [bottom, right, top, left] = layout.discards;
    const center = layout.center;

    expect(center).toEqual({ x: 350, y: 306, w: 300, h: 260 });
    expect(top.y + top.h).toBe(center.y);
    expect(bottom.y).toBe(center.y + center.h);
    expect(left.x + left.w).toBe(center.x);
    expect(right.x).toBe(center.x + center.w);
    expect(bottom.x).toBe(top.x);
    expect(left.y).toBe(right.y);
  });

  it("contains every 18-tile riichi pond in its discard zone", () => {
    for (const seat of [0, 1, 2, 3] as const) {
      const localBounds = potentialDiscardBounds(
        tenhouTileDesign,
        seat,
        18
      );
      const tableBounds = localRectToTable(
        seatTransform(seat),
        layout.discards[seat],
        localBounds
      );
      expect(
        containsRect(layout.discards[seat], tableBounds, 1e-9),
        `seat ${seat}: ${JSON.stringify(tableBounds)}`
      ).toBe(true);
    }
  });

  it("scales compact discard mats to the matching center edge", () => {
    const panelPadding = COMPACT_DISCARD_PANEL_PADDING;
    for (const seat of [0, 1, 2, 3] as const) {
      const targetPanelSpan =
        seat % 2 === 0 ? layout.center.w : layout.center.h;
      const options = webDiscardLayoutOptions(
        "compact",
        tenhouTileDesign,
        layout,
        seat
      );
      expect(options).toBeDefined();
      const localBounds = potentialDiscardBounds(
        tenhouTileDesign,
        seat,
        18,
        options
      );
      const tableBounds = localRectToTable(
        seatTransform(seat),
        layout.discards[seat],
        localBounds
      );
      const panelBounds = {
        x: tableBounds.x - panelPadding,
        y: tableBounds.y - panelPadding,
        w: tableBounds.w + panelPadding * 2,
        h: tableBounds.h + panelPadding * 2,
      };
      const panelSpan = seat % 2 === 0 ? panelBounds.w : panelBounds.h;

      expect(options?.scale).toBeGreaterThan(1);
      expect(panelSpan).toBeCloseTo(targetPanelSpan, 8);
      expect(
        containsRect(layout.discards[seat], panelBounds, 1e-8),
        `seat ${seat}: ${JSON.stringify(panelBounds)}`
      ).toBe(true);
    }
  });

  it("leaves clearance between full ponds and regular hand strips", () => {
    expect(layout.discards[2].y - (layout.hands[2].y + layout.hands[2].h)).toBe(
      54
    );
    expect(layout.hands[0].y - (layout.discards[0].y + layout.discards[0].h)).toBe(
      35
    );
    expect(layout.discards[3].x - (layout.hands[3].x + layout.hands[3].w)).toBe(
      112
    );
    expect(layout.hands[1].x - (layout.discards[1].x + layout.discards[1].w)).toBe(
      112
    );
  });

  it("selects standard and compact configs through one web contract", () => {
    expect(webTableLayoutConfig("standard")).toBe(currentTableLayout);
    expect(webTableLayoutConfig("compact")).toBe(compactWebTableLayout);
  });
});