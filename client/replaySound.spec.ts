import { describe, expect, it } from "vitest";
import { replayArrivalSoundTarget, replaySoundTarget } from "./replaySound";

describe("replaySoundTarget", () => {
  it("arms sound for an explicit forward single-event step", () => {
    expect(replaySoundTarget(10, 11, "step")).toBe(11);
  });

  it("keeps jumps silent even when their indices are adjacent", () => {
    expect(replaySoundTarget(10, 11, "jump")).toBeNull();
  });

  it("keeps backward and multi-event navigation silent", () => {
    expect(replaySoundTarget(10, 9, "step")).toBeNull();
    expect(replaySoundTarget(10, 20, "step")).toBeNull();
  });

  it("silences catch-up batches but allows one live arrival", () => {
    expect(replayArrivalSoundTarget(21, 1)).toBe(20);
    expect(replayArrivalSoundTarget(21, 8)).toBeNull();
  });
});
