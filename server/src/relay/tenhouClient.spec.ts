import { describe, expect, it } from "vitest";
import {
  splitTimedWgcFrame,
  WGC_ACTION_SPACING_MS,
} from "./tenhouClient";

describe("splitTimedWgcFrame", () => {
  it("does not replay a leading interval that elapsed before delivery", () => {
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

  it("does not replay an embedded elapsed interval", () => {
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
      WGC_ACTION_SPACING_MS,
      WGC_ACTION_SPACING_MS,
    ]);
  });

  it("leaves observed think time to the live WGC delivery cadence", () => {
    const frames = splitTimedWgcFrame({
      tag: "WGC",
      childNodes: [5031, { tag: "G110" }, { tag: "T46" }],
    });

    expect(frames.map((entry) => entry.delayMs)).toEqual([
      0,
      WGC_ACTION_SPACING_MS,
    ]);
  });
});