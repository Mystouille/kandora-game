import { describe, expect, it } from "vitest";

import type { SnapshotState } from "~/game/protocol/messages";
import { applyReplayEvent } from "~/game/replay/player";
import { snapshotToReplayView } from "./spectate";

function snapshotWithFreshGreenDragon(): SnapshotState {
  return {
    mySeat: null,
    hands: [
      ["1p", "9p", "8m", "7p", "8p", "9m", "7m", "9p", "1p", "2p", "6z"],
      [],
      [],
      [],
    ],
    discards: [[], [], [], []],
    melds: [
      [
        {
          type: "chi",
          tiles: ["1s", "2s", "3s"],
          claimedTile: "1s",
          from: 3,
        },
      ],
      [],
      [],
      [],
    ],
    wallRemaining: 24,
    drawsTaken: 46,
    doraIndicators: ["2m"],
    turn: 0,
    freshlyDrawnSeat: 0,
    dealer: 1,
    roundWind: "S",
    roundNumber: 2,
    honba: 0,
    riichiSticks: 0,
    scores: [28100, 24300, 27600, 20000],
    riichiDeclared: [false, false, false, false],
    lastDiscard: { seat: 3, tile: "1m" },
    phase: "awaiting_discard",
    duplicateWallState: {
      initial: [18, 18, 17, 17],
      remaining: [10, 12, 11, 11],
      limitingSeat: 0,
      estimatedDrawsRemaining: 43,
    },
  };
}

describe("spectator snapshot baseline", () => {
  it("removes a fresh draw when the first buffered event discards it", () => {
    const baseline = snapshotToReplayView(snapshotWithFreshGreenDragon());

    expect(baseline.freshlyDrawnSeat).toBe(0);
    expect(baseline.duplicateWallState).toEqual({
      initial: [18, 18, 17, 17],
      remaining: [10, 12, 11, 11],
      limitingSeat: 0,
      estimatedDrawsRemaining: 43,
    });

    const afterDiscard = applyReplayEvent(baseline, {
      type: "discard",
      seat: 0,
      tile: "6z",
      tsumogiri: true,
      discardSource: "draw",
    });

    expect(afterDiscard.hands[0]).toEqual([
      "1p",
      "9p",
      "8m",
      "7p",
      "8p",
      "9m",
      "7m",
      "9p",
      "1p",
      "2p",
    ]);
    expect(afterDiscard.discards[0]).toEqual(["6z"]);
    expect(afterDiscard.freshlyDrawnSeat).toBeNull();
  });

  it("defaults legacy snapshots without fresh-draw identity to null", () => {
    const snapshot = snapshotWithFreshGreenDragon();
    delete snapshot.freshlyDrawnSeat;

    expect(snapshotToReplayView(snapshot).freshlyDrawnSeat).toBeNull();
  });
});