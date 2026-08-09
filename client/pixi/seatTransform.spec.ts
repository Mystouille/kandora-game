import { describe, expect, it } from "vitest";
import { SEATS, type Rect, type Seat } from "./tableGeometry";
import {
  localToTable,
  SEAT_TRANSFORMS,
  seatTransform,
  tableToLocal,
} from "./seatTransform";

const RECT: Rect = { x: 100, y: 200, w: 300, h: 140 };

describe("seatTransform", () => {
  it("anchors the local origin at the legacy container corner", () => {
    // Corners the renderer positioned hand/discard containers at.
    expect(SEAT_TRANSFORMS[0].origin(RECT)).toEqual({ x: 100, y: 200 });
    expect(SEAT_TRANSFORMS[1].origin(RECT)).toEqual({ x: 100, y: 340 });
    expect(SEAT_TRANSFORMS[2].origin(RECT)).toEqual({ x: 400, y: 340 });
    expect(SEAT_TRANSFORMS[3].origin(RECT)).toEqual({ x: 400, y: 200 });
  });

  it("maps local (0,0) to the origin corner for every seat", () => {
    for (const seat of SEATS) {
      const t = seatTransform(seat);
      expect(localToTable(t, RECT, { x: 0, y: 0 })).toEqual(t.origin(RECT));
    }
  });

  it("sends local +x in the seat's reading direction", () => {
    // Seat 0 (bottom): +x → screen +x.
    expect(localToTable(seatTransform(0), RECT, { x: 10, y: 0 })).toEqual({
      x: 110,
      y: 200,
    });
    // Seat 1 (right): +x → screen -y (upward from bottom-left).
    expect(localToTable(seatTransform(1), RECT, { x: 10, y: 0 })).toEqual({
      x: 100,
      y: 330,
    });
    // Seat 2 (top): +x → screen -x (leftward from bottom-right).
    expect(localToTable(seatTransform(2), RECT, { x: 10, y: 0 })).toEqual({
      x: 390,
      y: 340,
    });
    // Seat 3 (left): +x → screen +y (downward from top-right).
    expect(localToTable(seatTransform(3), RECT, { x: 10, y: 0 })).toEqual({
      x: 400,
      y: 210,
    });
  });

  it("round-trips table→local→table exactly for every seat", () => {
    const probes = [
      { x: 0, y: 0 },
      { x: 37, y: 0 },
      { x: 0, y: 21 },
      { x: 55, y: 66 },
    ];
    for (const seat of SEATS) {
      const t = seatTransform(seat);
      for (const local of probes) {
        const table = localToTable(t, RECT, local);
        expect(tableToLocal(t, RECT, table)).toEqual(local);
      }
    }
  });

  it("stacks side seats within a row and bottom/top by row", () => {
    const signs = SEATS.map((s) => seatTransform(s).overlapZSign);
    expect(signs).toEqual([0, -1, 0, 1]);
  });
});
