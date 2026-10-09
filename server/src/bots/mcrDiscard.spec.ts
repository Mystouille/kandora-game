import { describe, expect, it } from "vitest";
import { chooseMcrBotDiscard } from "./mcrDiscard";

describe("chooseMcrBotDiscard", () => {
  it("keeps a complete knitted-straight route over an unrelated tile", () => {
    const discard = chooseMcrBotDiscard({
      hand: [
        "1m",
        "4m",
        "7m",
        "2p",
        "5p",
        "8p",
        "3s",
        "6s",
        "9s",
        "1z",
        "1z",
        "2m",
        "3m",
        "7z",
      ],
      drawn: "7z",
      meldCount: 0,
      random: () => 0,
    });
    expect(discard).toEqual({ tile: "7z", discardSource: "draw" });
  });
});
