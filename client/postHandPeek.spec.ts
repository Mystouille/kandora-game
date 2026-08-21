import { describe, expect, it } from "vitest";
import type { GameEvent } from "~/game/protocol/messages";
import {
  advancePostHandPeekDiscardCount,
  shouldHidePostHandPeek,
} from "./postHandPeek";

const discard = (seat: 0 | 1 | 2 | 3, tile: string): GameEvent => ({
  type: "discard",
  seat,
  tile,
  tsumogiri: false,
});

describe("post-hand peek discard counting", () => {
  it("expires after two focused-seat discards even when one is called", () => {
    let count = advancePostHandPeekDiscardCount(0, discard(2, "1m"), 2);
    count = advancePostHandPeekDiscardCount(
      count,
      {
        type: "call",
        seat: 3,
        meld: {
          type: "pon",
          tiles: ["1m", "1m", "1m"],
          claimedTile: "1m",
          from: 2,
        },
      },
      2
    );
    count = advancePostHandPeekDiscardCount(count, discard(2, "2m"), 2);

    expect(count).toBe(2);
    expect(shouldHidePostHandPeek(count)).toBe(true);
  });

  it("ignores other players' discards", () => {
    expect(advancePostHandPeekDiscardCount(0, discard(1, "3m"), 2)).toBe(0);
  });
});
