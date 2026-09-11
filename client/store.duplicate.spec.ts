import { beforeEach, describe, expect, it } from "vitest";
import { useMatchStore } from "./store";

const initialWallState = {
  initial: [18, 18, 17, 17] as [number, number, number, number],
  remaining: [18, 18, 17, 17] as [number, number, number, number],
  limitingSeat: 2 as const,
  estimatedDrawsRemaining: 70,
};

describe("live duplicate wall state", () => {
  beforeEach(() => {
    useMatchStore.getState().reset();
  });

  it("uses authoritative event state when supplied", () => {
    useMatchStore.getState().applyEvent(
      {
        type: "hand_start",
        round: 0,
        dealer: 0,
        doraIndicators: ["1z"],
        duplicateWallState: initialWallState,
      },
      0
    );
    useMatchStore.getState().applyEvent(
      {
        type: "draw",
        seat: 0,
        tile: "1m",
        wallRemaining: 69,
        duplicateWallState: {
          ...initialWallState,
          remaining: [17, 18, 17, 17],
          estimatedDrawsRemaining: 69,
        },
      },
      1
    );

    expect(useMatchStore.getState().duplicateWallState).toEqual({
      ...initialWallState,
      remaining: [17, 18, 17, 17],
      estimatedDrawsRemaining: 69,
    });
  });

  it("reconstructs call changes when an older event lacks authoritative state", () => {
    useMatchStore.setState({
      duplicateWallState: {
        ...initialWallState,
        remaining: [17, 18, 17, 17],
        estimatedDrawsRemaining: 69,
      },
    });

    useMatchStore.getState().applyEvent(
      {
        type: "call",
        seat: 2,
        meld: {
          type: "pon",
          tiles: ["1m", "1m", "1m"],
          claimedTile: "1m",
          from: 0,
        },
      },
      2
    );

    expect(useMatchStore.getState().duplicateWallState).toEqual({
      ...initialWallState,
      remaining: [17, 18, 17, 17],
      limitingSeat: 3,
      estimatedDrawsRemaining: 68,
    });
  });
});