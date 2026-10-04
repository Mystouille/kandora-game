import { describe, expect, it } from "vitest";
import type { GameEvent } from "~/game/protocol/messages";
import { TenhouSpectateDecoder } from "./spectateDecoder";

function ids(start: number): string {
  return Array.from({ length: 13 }, (_, index) => start + index).join(",");
}

function discards(events: GameEvent[]) {
  return events.filter(
    (event): event is Extract<GameEvent, { type: "discard" }> =>
      event.type === "discard"
  );
}

describe("TenhouSpectateDecoder", () => {
  it("distinguishes tsumogiri by physical tile id", () => {
    const decoder = new TenhouSpectateDecoder("watch-1");
    decoder.ingest({
      tag: "UN",
      n0: "East",
      n1: "South",
      n2: "West",
      n3: "North",
    });

    const initial = decoder.ingest({
      tag: "INITBYLOG",
      childNodes: [
        {
          tag: "INIT",
          seed: "0,0,0,0,0,4",
          ten: "250,250,250,250",
          oya: "0",
          hai0: ids(0),
          hai1: ids(13),
          hai2: ids(26),
          hai3: ids(39),
        },
        { tag: "T80" },
        { tag: "D80" },
      ],
    });

    expect(discards(initial)).toEqual([
      expect.objectContaining({
        seat: 0,
        tsumogiri: true,
        discardSource: "draw",
      }),
    ]);

    const incremental = decoder.ingest({
      tag: "WGC",
      childNodes: [{ tag: "T0" }, { tag: "D1" }],
    });

    expect(discards(incremental)).toEqual([
      expect.objectContaining({
        seat: 0,
        tile: "1m",
        tsumogiri: false,
        discardSource: "hand",
      }),
    ]);
  });
});
