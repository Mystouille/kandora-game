import { beforeEach, describe, expect, it, vi } from "vitest";
import { dispatchServerMessage } from "./dispatchServerMessage";
import { useMatchStore } from "./store";

describe("dispatchServerMessage event sequencing", () => {
  beforeEach(() => {
    useMatchStore.getState().reset();
  });

  it("ignores an already-applied event frame", () => {
    const message = {
      type: "event" as const,
      seq: 0,
      events: [
        {
          type: "draw" as const,
          seat: 0 as const,
          tile: "1m" as const,
          wallRemaining: 69,
        },
      ],
      legalActions: [],
    };

    dispatchServerMessage(message);
    dispatchServerMessage(message);

    expect(useMatchStore.getState().hands[0]).toEqual(["1m"]);
    expect(useMatchStore.getState().lastSeq).toBe(0);
  });

  it("trims an overlapping event batch and applies only unseen events", () => {
    dispatchServerMessage({
      type: "event",
      seq: 0,
      events: [
        {
          type: "draw",
          seat: 0,
          tile: "1m",
          wallRemaining: 69,
        },
      ],
      legalActions: [],
    });

    dispatchServerMessage({
      type: "event",
      seq: 1,
      events: [
        {
          type: "draw",
          seat: 0,
          tile: "1m",
          wallRemaining: 69,
        },
        {
          type: "discard",
          seat: 0,
          tile: "1m",
          tsumogiri: true,
          discardSource: "draw",
        },
      ],
      legalActions: [],
    });

    expect(useMatchStore.getState().hands[0]).toEqual([]);
    expect(useMatchStore.getState().discards[0]).toEqual(["1m"]);
    expect(useMatchStore.getState().lastSeq).toBe(1);
  });

  it("rejects a sequence gap and requests a resync", () => {
    const onSequenceGap = vi.fn();

    dispatchServerMessage(
      {
        type: "event",
        seq: 2,
        events: [
          {
            type: "draw",
            seat: 0,
            tile: "1m",
            wallRemaining: 69,
          },
        ],
        legalActions: [],
      },
      { onSequenceGap }
    );

    expect(onSequenceGap).toHaveBeenCalledWith({
      expectedSeq: 0,
      receivedSeq: 2,
    });
    expect(useMatchStore.getState().hands[0]).toEqual([]);
    expect(useMatchStore.getState().lastSeq).toBe(-1);
  });

  it("still accepts same-sequence legal-action refresh frames", () => {
    useMatchStore.setState({ lastSeq: 4 });
    const legalActions = [
      {
        id: "pass",
        type: "pass" as const,
      },
    ];

    dispatchServerMessage({
      type: "event",
      seq: 4,
      events: [],
      legalActions,
      deadline: 123,
      bufferMs: 456,
    });

    expect(useMatchStore.getState().legalActions).toEqual(legalActions);
    expect(useMatchStore.getState().actionDeadline).toBe(123);
    expect(useMatchStore.getState().actionBufferMs).toBe(456);
  });
});
