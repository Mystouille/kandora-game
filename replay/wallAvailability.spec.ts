import { describe, expect, it } from "vitest";
import { replayHasRevealableWalls } from "./wallAvailability";

describe("replayHasRevealableWalls", () => {
  it("preserves the existing wall control for normal replays", () => {
    expect(replayHasRevealableWalls({ mode: { type: "normal" }, events: [] })).toBe(
      true
    );
  });

  it("requires both personal queues and dead-wall identities for duplicate replay reveal", () => {
    const duplicateMode = {
      type: "duplicate" as const,
      seed: "Board-A",
      generationVersion: 1 as const,
    };
    expect(replayHasRevealableWalls({ mode: duplicateMode, events: [] })).toBe(
      false
    );
    expect(
      replayHasRevealableWalls({
        mode: duplicateMode,
        events: [
          {
            type: "hand_start",
            round: 0,
            dealer: 0,
            doraIndicators: ["1z"],
            duplicateDrawQueues: [["1m"], ["2m"], ["3m"], ["4m"]],
            deadWall: [
              "1m",
              "2m",
              "3m",
              "4m",
              "1z",
              "2z",
              "3z",
              "4z",
              "5z",
              "6z",
              "7z",
              "1p",
              "2p",
              "3p",
            ],
          },
        ],
      })
    ).toBe(true);
  });
});