import { describe, expect, it } from "vitest";
import {
  replayLocationRequestFromSearchParams,
  resolveReplayInitialLocation,
} from "./replayLocation";

const bounds = { min: 4, max: 99 };
const rounds = [5, 30, 60];

describe("replay initial location", () => {
  it("gives an explicit event precedence and clamps it", () => {
    expect(
      resolveReplayInitialLocation({
        request: { seat: 2, event: 200, round: 2 },
        bounds,
        rounds,
      })
    ).toEqual({ seat: 2, index: 99 });
    expect(
      resolveReplayInitialLocation({
        request: { event: -20 },
        bounds,
        rounds,
      })
    ).toEqual({ seat: 0, index: 4 });
  });

  it("uses a one-based round when no event is requested", () => {
    expect(
      resolveReplayInitialLocation({
        request: { round: 2 },
        bounds,
        rounds,
      })
    ).toEqual({ seat: 0, index: 30 });
  });

  it("lets a review override the seat and provide the first annotation", () => {
    expect(
      resolveReplayInitialLocation({
        request: { seat: 1 },
        bounds,
        rounds,
        review: {
          seat: 3,
          edits: [{ eventIndex: 72 }, { eventIndex: 18 }],
        },
      })
    ).toEqual({ seat: 3, index: 18 });
  });

  it("falls back to the first round and normalizes invalid seats", () => {
    expect(
      resolveReplayInitialLocation({
        request: { seat: 8, round: 20 },
        bounds,
        rounds,
      })
    ).toEqual({ seat: 0, index: 5 });
  });

  it("parses finite web query values without interpreting other keys", () => {
    expect(
      replayLocationRequestFromSearchParams(
        new URLSearchParams(
          "seat=2&event=72.9&round=4&review=abc&from=%2Fadmin"
        )
      )
    ).toEqual({ seat: 2, event: 72.9, round: 4 });
  });
});