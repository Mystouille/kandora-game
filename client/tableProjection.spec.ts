import { describe, expect, it } from "vitest";
import type { Seat } from "~/game/protocol/seat";
import { initialView, replayViewToMatchView } from "~/game/replay/player";
import { useMatchStore, type MatchView } from "./store";
import {
  createTableProjection,
  isTableSeatActive,
  logicalSeatForPosition,
  rotateMatchView,
  tablePositionForSeat,
  tableSeatWind,
} from "./tableProjection";

describe("fixed initial-East sanma table projection", () => {
  for (const focus of [0, 1, 2] as const) {
    for (const dealer of [0, 1, 2] as const) {
      it(`keeps the gap fixed at focus ${focus}, dealer ${dealer}`, () => {
        const raw: MatchView = {
          ...useMatchStore.getInitialState(),
          ...initialView({ playerCount: 3 }),
          mySeat: focus,
          dealer,
          hands: [["1m"], ["2p"], ["3s"]],
          scores: [23000, 25000, 27000],
          seatNames: ["East", "South", "West"],
          nukiTiles: [["4z"], [], ["4z", "4z"]],
          melds: [
            [],
            [
              {
                type: "pon",
                tiles: ["1m", "1m", "1m"],
                claimedTile: "1m",
                from: 2,
              },
            ],
            [],
          ],
        };
        const before = JSON.stringify(raw);
        const projected = rotateMatchView(raw, focus);
        const gap = tablePositionForSeat(3, focus);
        expect(gap).toBe([3, 2, 1][focus]);
        expect(
          projected.tableProjection.slots.map((slot) => slot?.seat ?? null)
        ).toEqual(
          [
            [0, 1, 2, null],
            [1, 2, null, 0],
            [2, null, 0, 1],
          ][focus]
        );
        expect(isTableSeatActive(projected, gap)).toBe(false);
        expect(projected.tableProjection.slots[gap]).toBeNull();
        expect(projected.hands[gap]).toEqual([]);
        expect(projected.nukiTiles?.[gap]).toEqual([]);
        expect(projected.seatNames?.[gap]).toBe("");
        expect(projected.tableProjection.slots.filter(Boolean)).toHaveLength(3);
        for (const absolute of [0, 1, 2] as const) {
          const side = tablePositionForSeat(absolute, focus);
          expect(logicalSeatForPosition(side, focus, 3)).toBe(absolute);
          expect(projected.hands[side]).toEqual(raw.hands[absolute]);
          expect(projected.scores[side]).toBe(raw.scores[absolute]);
          expect(tableSeatWind(projected, side)).toBe(
            ["E", "S", "W"][(absolute - dealer + 3) % 3]
          );
        }
        expect(projected.melds[tablePositionForSeat(1, focus)][0].from).toBe(
          tablePositionForSeat(2, focus)
        );
        expect(JSON.stringify(raw)).toBe(before);
        expect(raw.hands).toHaveLength(3);
      });
    }
  }

  it("preserves four-player rotations and rejects focus on an absent seat", () => {
    const view = initialView();
    for (const focus of [0, 1, 2, 3] as const) {
      const projected = replayViewToMatchView(view, {
        index: 0,
        mySeat: focus,
      });
      expect(projected.hands).toHaveLength(4);
      for (const side of [0, 1, 2, 3] as const) {
        expect(isTableSeatActive(projected, side)).toBe(true);
      }
    }
    expect(() => createTableProjection(3, 3, 0)).toThrow("inactive seat");
  });

  it("maps result participants and declarer windows without creating an extra result", () => {
    const raw: MatchView = {
      ...useMatchStore.getInitialState(),
      ...initialView({ playerCount: 3 }),
      mySeat: 2,
      dealer: 1,
      pendingNuki: { seat: 0, tile: "4z", opening: false },
      lastHandResult: {
        reason: "ron",
        dealer: 1,
        delta: [-4000, 4000, 0],
        declarations: [
          { seat: 0, tenpai: true },
          { seat: 1, tenpai: false },
          { seat: 2, tenpai: true },
        ],
        wins: [{ seat: 1, loser: 0, han: 2, ten: 4000 }],
      },
      matchEnded: {
        reason: "round_limit",
        finalScores: [0, 1, 2].map((seat) => ({
          seat: seat as Seat,
          score: 25000,
          place: seat + 1,
        })),
      },
    };
    const projected = rotateMatchView(raw, 2);
    expect(projected.pendingNuki?.seat).toBe(2);
    expect(projected.lastHandResult?.wins?.[0]).toMatchObject({
      seat: 3,
      loser: 2,
    });
    expect(projected.lastHandResult?.declarations).toHaveLength(3);
    expect(projected.matchEnded?.finalScores).toHaveLength(3);
    expect(projected.lastHandResult?.delta).toEqual([0, 0, -4000, 4000]);
  });
});
