import { describe, expect, it } from "vitest";
import type { Meld, Tile } from "~/game/protocol/messages";
import {
  initialView,
  replayViewToMatchView,
  type ReplayView,
} from "./player";
import { waitsForReplayView } from "./waits";

function viewWith(
  hand: Array<Tile | null>,
  melds: Meld[] = []
): Pick<ReplayView, "hands" | "melds"> {
  return {
    hands: [hand, [], [], []],
    melds: [melds, [], [], []],
  };
}

describe("waitsForReplayView", () => {
  it("computes waits for a fully-known closed hand", () => {
    const hand: Tile[] = [
      "1m",
      "2m",
      "3m",
      "4p",
      "5p",
      "6p",
      "7s",
      "8s",
      "9s",
      "1z",
      "1z",
      "1z",
      "2z",
    ];

    expect(waitsForReplayView(viewWith(hand))[0]).toEqual(["2z"]);
  });

  it("normalizes a red-five pair wait to its canonical tile", () => {
    const hand: Tile[] = [
      "1m",
      "2m",
      "3m",
      "4m",
      "5m",
      "6m",
      "7p",
      "8p",
      "9p",
      "1z",
      "1z",
      "1z",
      "0s",
    ];

    expect(waitsForReplayView(viewWith(hand))[0]).toEqual(["5s"]);
  });

  it("accounts for declared melds in a partial hand", () => {
    const hand: Tile[] = [
      "1s",
      "2s",
      "3s",
      "4s",
      "5s",
      "6s",
      "7s",
      "8s",
      "9s",
      "1p",
    ];
    const meld: Meld = {
      type: "pon",
      tiles: ["5z", "5z", "5z"],
      claimedTile: "5z",
      from: 1,
    };

    expect(waitsForReplayView(viewWith(hand, [meld]))[0]).toEqual(["1p"]);
  });

  it("skips unknown and active fourteen-tile hands", () => {
    expect(
      waitsForReplayView(viewWith(new Array<Tile | null>(13).fill(null)))[0]
    ).toEqual([]);

    const active = new Array<Tile>(14).fill("1m");
    expect(waitsForReplayView(viewWith(active))[0]).toEqual([]);
  });

  it("follows a non-East focus through the replay adapter", () => {
    const view = initialView();
    view.hands[2] = [
      "1m",
      "2m",
      "3m",
      "4p",
      "5p",
      "6p",
      "7s",
      "8s",
      "9s",
      "1z",
      "1z",
      "1z",
      "2z",
    ];
    const currentWaits = waitsForReplayView(view);

    const focused = replayViewToMatchView(view, {
      index: 0,
      mySeat: 2,
      currentWaits,
    });

    expect(focused.currentWaits?.[0]).toEqual(["2z"]);
  });
});