import { describe, expect, it } from "vitest";
import { replayArrivalSoundTarget, replaySoundTarget } from "./replaySound";

describe("replaySoundTarget", () => {
  it("arms sound for an explicit forward single-event step", () => {
    expect(replaySoundTarget(10, 11, "step")).toEqual({
      playIndex: 11,
      eventIndex: 11,
    });
  });

  it("keeps jumps silent even when their indices are adjacent", () => {
    expect(replaySoundTarget(10, 11, "jump")).toBeNull();
  });

  it("keeps backward and multi-event navigation silent", () => {
    expect(replaySoundTarget(10, 9, "step")).toBeNull();
    expect(replaySoundTarget(10, 20, "step")).toBeNull();
  });

  it("allows one live arrival", () => {
    expect(replayArrivalSoundTarget(21, [{ type: "discard" }])).toEqual({
      playIndex: 20,
      eventIndex: 20,
    });
  });

  it("plays a win from a terminal lifecycle batch at the live playhead", () => {
    expect(
      replayArrivalSoundTarget(23, [
        { type: "win" },
        { type: "hand_end" },
        { type: "match_end" },
      ])
    ).toEqual({ playIndex: 22, eventIndex: 20 });
  });

  it("carries a pending win through a separately delivered hand end", () => {
    const winTarget = replayArrivalSoundTarget(21, [{ type: "win" }]);

    expect(
      replayArrivalSoundTarget(22, [{ type: "hand_end" }], winTarget)
    ).toEqual({ playIndex: 21, eventIndex: 20 });
    expect(replayArrivalSoundTarget(22, [{ type: "hand_end" }])).toBeNull();
  });

  it("keeps unrelated catch-up batches silent", () => {
    expect(
      replayArrivalSoundTarget(24, [
        { type: "draw" },
        { type: "discard" },
        { type: "draw" },
      ])
    ).toBeNull();
  });
});
