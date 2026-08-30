import { describe, expect, it } from "vitest";

import { advanceReadyCheckTick, type ReadyCheckTickState } from "./readyCheckCountdown";

const initial: ReadyCheckTickState = { deadline: null, seconds: -1 };

describe("advanceReadyCheckTick", () => {
  it("does not replay the current second when acknowledgement state changes", () => {
    const first = advanceReadyCheckTick(initial, 10_000, 5);
    const acknowledged = advanceReadyCheckTick(first.next, 10_000, 5);

    expect(first.play).toBe(true);
    expect(acknowledged.play).toBe(false);
  });

  it("plays each new second and each genuinely new countdown", () => {
    const five = advanceReadyCheckTick(initial, 10_000, 5);
    const four = advanceReadyCheckTick(five.next, 10_000, 4);
    const nextCountdown = advanceReadyCheckTick(four.next, 20_000, 5);

    expect(four.play).toBe(true);
    expect(nextCountdown.play).toBe(true);
  });

  it("resets after the ready check ends", () => {
    const active = advanceReadyCheckTick(initial, 10_000, 5);
    const ended = advanceReadyCheckTick(active.next, null, 0);

    expect(ended).toEqual({
      play: false,
      next: { deadline: null, seconds: -1 },
    });
  });
});