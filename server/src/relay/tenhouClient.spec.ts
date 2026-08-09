import { describe, expect, it } from "vitest";
import {
  splitTimedWgcFrame,
  WGC_ACTION_SPACING_MS,
} from "./tenhouClient";

describe("splitTimedWgcFrame", () => {
  it("does not wait a leading delay that already elapsed on the wire", () => {
    const frames = splitTimedWgcFrame({
      tag: "WGC",
      childNodes: [6563, { tag: "D4" }, { tag: "U93" }],
    });

    expect(frames.map((entry) => entry.delayMs)).toEqual([
      0,
      WGC_ACTION_SPACING_MS,
    ]);
    expect(frames.map((entry) => entry.frame.childNodes)).toEqual([
      [{ tag: "D4" }],
      [{ tag: "U93" }],
    ]);
  });

  it("preserves delays between actions and separates adjacent actions", () => {
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

    expect(frames.map((entry) => entry.delayMs)).toEqual([
      0,
      WGC_ACTION_SPACING_MS,
      1531,
      WGC_ACTION_SPACING_MS,
    ]);
  });
});