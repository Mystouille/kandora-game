import { beforeEach, describe, expect, it } from "vitest";
import type { SnapshotState } from "~/game/protocol/messages";
import { useMatchStore } from "./store";
import { parseTileList } from "./debugSeed";

function snapshot(overrides: Partial<SnapshotState> = {}): SnapshotState {
  return {
    mySeat: 0,
    hands: [["1m"], [null], [null], [null]],
    discards: [["1m", "2m"], [], [], []],
    melds: [[], [], [], []],
    wallRemaining: 69,
    doraIndicators: ["1z"],
    turn: 1,
    dealer: 0,
    roundWind: "E",
    roundNumber: 1,
    honba: 0,
    riichiSticks: 0,
    scores: [25000, 25000, 25000, 25000],
    riichiDeclared: [false, false, false, false],
    lastDiscard: { seat: 0, tile: "2m" },
    phase: "awaiting_draw",
    ...overrides,
  };
}

describe("snapshot discard metadata", () => {
  beforeEach(() => {
    useMatchStore.getState().reset();
  });

  it("hydrates tsumogiri flags supplied by the server", () => {
    const state = snapshot({
      discardTsumogiri: [[true, false], [], [], []],
    });

    useMatchStore.getState().hydrateSnapshot(state, 2);

    expect(useMatchStore.getState().discardTsumogiri).toEqual([
      [true, false],
      [],
      [],
      [],
    ]);
  });

  it("defaults missing legacy flags to false", () => {
    useMatchStore.getState().hydrateSnapshot(snapshot(), 2);

    expect(useMatchStore.getState().discardTsumogiri).toEqual([
      [false, false],
      [],
      [],
      [],
    ]);
  });

  it.each(["5p", "9s"])(
    "restores MCR's opening %s as a separate draw and removes it once",
    (firstDraw) => {
      const hand = parseTileList("123789m123p1239s").tiles;
      useMatchStore.getState().hydrateSnapshot(
        snapshot({
          rulesFamily: "mcr",
          hands: [[...hand, firstDraw], [], [], []],
          discards: [[], [], [], []],
          scores: [0, 0, 0, 0],
          doraIndicators: [],
          turn: 0,
          phase: "awaiting_discard",
          freshlyDrawnSeat: 0,
          lastDiscard: null,
        }),
        2
      );
      expect(useMatchStore.getState().freshlyDrawnSeat).toBe(0);
      useMatchStore.getState().applyEvent(
        {
          type: "discard",
          seat: 0,
          tile: firstDraw,
          tsumogiri: true,
          discardSource: "draw",
        },
        3
      );
      expect(useMatchStore.getState().hands[0]).toEqual(hand);
      expect(useMatchStore.getState().freshlyDrawnSeat).toBeNull();
    }
  );
});
