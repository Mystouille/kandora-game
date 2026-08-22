import { describe, expect, it } from "vitest";
import type { LegalAction } from "~/game/protocol/messages";
import {
  discardIndexForSource,
  discardSourceForRawIndex,
  findTileAction,
} from "./discardActions";

describe("discard action identity", () => {
  const actions: LegalAction[] = [
    {
      id: "discard:draw:5m",
      type: "discard",
      tile: "5m",
      discardSource: "draw",
    },
    {
      id: "discard:hand:5m",
      type: "discard",
      tile: "5m",
      discardSource: "hand",
    },
  ];

  it("identifies the appended raw tile even after display reordering", () => {
    expect(discardSourceForRawIndex(13, 14, true)).toBe("draw");
    expect(discardSourceForRawIndex(2, 14, true)).toBe("hand");
  });

  it("selects distinct actions for identical tile values", () => {
    expect(findTileAction(actions, "discard", "5m", "draw")?.id).toBe(
      "discard:draw:5m"
    );
    expect(findTileAction(actions, "discard", "5m", "hand")?.id).toBe(
      "discard:hand:5m"
    );
  });

  it("removes the selected physical copy from a duplicate hand", () => {
    const hand = ["5m", "1p", "5m"];
    expect(discardIndexForSource(hand, "5m", "hand", true)).toBe(0);
    expect(discardIndexForSource(hand, "5m", "draw", true)).toBe(2);
  });

  it("falls back to a source-less action from an older server", () => {
    const legacy: LegalAction[] = [
      { id: "discard:5m", type: "discard", tile: "5m" },
    ];
    expect(findTileAction(legacy, "discard", "5m", "hand")?.id).toBe(
      "discard:5m"
    );
  });
});