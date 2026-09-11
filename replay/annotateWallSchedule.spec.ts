import { describe, expect, it } from "vitest";
import type { GameEvent } from "~/game/protocol/messages";
import { annotateWallSchedule } from "./annotateWallSchedule";

describe("annotateWallSchedule", () => {
  it("does not synthesize one live-wall schedule for duplicate queues", () => {
    const events: GameEvent[] = [
      {
        type: "hand_start",
        round: 0,
        dealer: 0,
        doraIndicators: ["1z"],
        duplicateDrawQueues: [["1m"], ["2m"], ["3m"], ["4m"]],
      },
      { type: "draw", seat: 0, tile: "1m", wallRemaining: 69 },
      {
        type: "discard",
        seat: 0,
        tile: "1m",
        tsumogiri: true,
        discardSource: "draw",
      },
      {
        type: "hand_end",
        reason: "exhaustive_draw",
        delta: [0, 0, 0, 0],
      },
    ];

    const annotated = annotateWallSchedule(events);
    const handStart = annotated[0];
    const draw = annotated[1];

    expect(handStart.type).toBe("hand_start");
    if (handStart.type !== "hand_start") {
      throw new Error("expected hand_start");
    }
    expect(handStart.liveDrawSchedule).toBeUndefined();
    expect(handStart.duplicateDrawQueues).toEqual([
      ["1m"],
      ["2m"],
      ["3m"],
      ["4m"],
    ]);
    expect(draw).toMatchObject({ type: "draw", fromDeadWall: false });
  });
});