import { describe, expect, it } from "vitest";

import {
  advanceCountdownSoundGate,
  advanceReadyCheckTick,
  resetCountdownSoundGate,
  type ReadyCheckTickState,
} from "./readyCheckCountdown";

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

describe("advanceCountdownSoundGate", () => {
  it("allows the first displayed second and every visual decrement", () => {
    const first = advanceCountdownSoundGate(
      resetCountdownSoundGate(),
      "ready:10000",
      5
    );
    const next = advanceCountdownSoundGate(first.next, "ready:10000", 4);

    expect(first.play).toBe(true);
    expect(next.play).toBe(true);
  });

  it("rejects overlapping cues from separate countdown producers", () => {
    let state = resetCountdownSoundGate();
    const playedSeconds: number[] = [];
    for (const seconds of [5, 5, 4, 4, 3, 3, 2, 2, 1, 1]) {
      const result = advanceCountdownSoundGate(state, "ready:10000", seconds);
      state = result.next;
      if (result.play) {
        playedSeconds.push(seconds);
      }
    }

    expect(playedSeconds).toEqual([5, 4, 3, 2, 1]);
  });

  it("does not replay after a visual clock correction moves upward", () => {
    const five = advanceCountdownSoundGate(
      resetCountdownSoundGate(),
      "action:10000",
      5
    );
    const four = advanceCountdownSoundGate(five.next, "action:10000", 4);
    const corrected = advanceCountdownSoundGate(four.next, "action:10000", 5);
    const backToFour = advanceCountdownSoundGate(
      corrected.next,
      "action:10000",
      4
    );

    expect(four.play).toBe(true);
    expect(corrected.play).toBe(false);
    expect(backToFour.play).toBe(false);
  });
});
