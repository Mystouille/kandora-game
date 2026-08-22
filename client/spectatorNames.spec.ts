import { describe, expect, it } from "vitest";
import { mergeSeatNames } from "./spectatorNames";

describe("mergeSeatNames", () => {
  it("does not erase authoritative names with empty enrichment", () => {
    expect(
      mergeSeatNames(["Alice", "Bob", "Carol", "Dave"], ["", "", "", ""])
    ).toEqual(["Alice", "Bob", "Carol", "Dave"]);
  });

  it("fills and updates seats from a non-empty source", () => {
    expect(
      mergeSeatNames(["Alice", "", "Carol", ""], ["", "Bob", "C", "Dave"])
    ).toEqual(["Alice", "Bob", "C", "Dave"]);
  });
});