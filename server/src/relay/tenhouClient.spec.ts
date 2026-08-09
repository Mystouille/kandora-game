import { describe, expect, it } from "vitest";
import { splitTimedWgcFrame } from "./tenhouClient";

describe("splitTimedWgcFrame", () => {
  it("applies a leading delay before the first action", () => {
    const frames = splitTimedWgcFrame({
      tag: "WGC",
      childNodes: [6563, { tag: "D4" }, { tag: "U93" }],
    });

    expect(frames.map((entry) => entry.delayMs)).toEqual([6563, 0]);
    expect(frames.map((entry) => entry.frame.childNodes)).toEqual([
      [{ tag: "D4" }],
      [{ tag: "U93" }],
    ]);
  });

  it("applies each embedded delay before the following action", () => {
    const frames = splitTimedWgcFrame({
      tag: "WGC",
      childNodes: [
        { tag: "D105" },
        { tag: "U6" },
        1531,
        { tag: "E6" },
        { tag: "V9" },
      ],
    });

    expect(frames.map((entry) => entry.delayMs)).toEqual([0, 0, 1531, 0]);
  });

  it("preserves the observed delay before Jordan discards", () => {
    const frames = splitTimedWgcFrame({
      tag: "WGC",
      childNodes: [5031, { tag: "G110" }, { tag: "T46" }],
    });

    expect(frames.map((entry) => entry.delayMs)).toEqual([5031, 0]);
  });
});