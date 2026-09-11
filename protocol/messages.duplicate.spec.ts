import { describe, expect, it } from "vitest";
import { GameEventSchema, SnapshotStateSchema } from "./messages";

const duplicateWallState = {
  initial: [18, 18, 17, 17] as const,
  remaining: [17, 18, 17, 17] as const,
  limitingSeat: 2 as const,
  estimatedDrawsRemaining: 69,
};

describe("duplicate wall protocol state", () => {
  it("preserves the state on gameplay events", () => {
    const event = GameEventSchema.parse({
      type: "draw",
      seat: 0,
      tile: "1m",
      wallRemaining: 69,
      duplicateWallState,
    });

    expect(event).toMatchObject({ duplicateWallState });
  });

  it("preserves the state on reconnect snapshots", () => {
    const snapshot = SnapshotStateSchema.parse({
      mySeat: 0,
      hands: [[], [], [], []],
      discards: [[], [], [], []],
      melds: [[], [], [], []],
      wallRemaining: 69,
      drawsTaken: 1,
      doraIndicators: ["1z"],
      turn: 0,
      freshlyDrawnSeat: 0,
      dealer: 0,
      roundWind: "E",
      roundNumber: 1,
      honba: 0,
      riichiSticks: 0,
      scores: [25000, 25000, 25000, 25000],
      riichiDeclared: [false, false, false, false],
      lastDiscard: null,
      phase: "awaiting_discard",
      duplicateWallState,
    });

    expect(snapshot.duplicateWallState).toEqual(duplicateWallState);
  });

  it("rejects negative queue counts", () => {
    expect(
      GameEventSchema.safeParse({
        type: "call",
        seat: 0,
        meld: { type: "pon", tiles: ["1m", "1m", "1m"], claimedTile: "1m", from: 3 },
        duplicateWallState: {
          ...duplicateWallState,
          remaining: [-1, 18, 17, 17],
        },
      }).success
    ).toBe(false);
  });
});