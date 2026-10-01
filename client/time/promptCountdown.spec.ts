import { afterEach, describe, expect, it, vi } from "vitest";
import { bindLiveClock, releaseLiveClock } from "./liveClock";
import { promptCountdown } from "./liveTimingBinding";
import { ActionWindowViewSchema } from "~/game/protocol/timing";

const owner = {};
const window = ActionWindowViewSchema.parse({
  id: "ready-1",
  clockEpoch: "epoch-1",
  timingVersion: 2,
  seat: 0,
  kind: "ready",
  state: "open",
  infoSentAt: 1_000,
  opensAt: 1_000,
  baseEndsAt: 6_000,
  budgetEndsAt: 6_000,
  expiresAt: 6_200,
  bankAtOpenMs: 0,
  allowanceMs: 200,
  generation: 1,
  legalActionIds: ["ready"],
});
afterEach(() => {
  releaseLiveClock(owner);
  vi.restoreAllMocks();
});

describe("shared fixed-prompt countdown", () => {
  it("uses the synchronized reference even when a device wall clock is skewed", () => {
    vi.spyOn(Date, "now").mockReturnValue(300_000);
    bindLiveClock(owner, {
      now: () => 2_000,
      quality: () => ({
        clockEpoch: "epoch-1",
        roundTripMs: 100,
        uncertaintyMs: 50,
        sampledAt: 0,
      }),
    });
    expect(promptCountdown(window, 6_000)).toEqual({
      remainingMs: 4_000,
      canRespond: true,
      synchronized: true,
    });
  });

  it("does not enable replies with missing or wrong-epoch clock quality", () => {
    bindLiveClock(owner, {
      now: () => 2_000,
      quality: () => ({
        clockEpoch: "retired-epoch",
        roundTripMs: 100,
        uncertaintyMs: 50,
        sampledAt: 0,
      }),
    });
    expect(promptCountdown(window, 6_000)).toEqual({
      remainingMs: 5_000,
      canRespond: false,
      synchronized: false,
    });
  });
});
