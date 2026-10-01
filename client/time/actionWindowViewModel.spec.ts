import { describe, expect, it } from "vitest";
import { ActionWindowViewSchema } from "~/game/protocol/timing";
import { actionTimerView, intentForWindow } from "./actionWindowViewModel";

const window = ActionWindowViewSchema.parse({
  id: "window-1",
  clockEpoch: "epoch-1",
  timingVersion: 2,
  seat: 0,
  kind: "turn",
  state: "scheduled",
  infoSentAt: 500,
  opensAt: 1_000,
  baseEndsAt: 6_000,
  budgetEndsAt: 26_000,
  expiresAt: 26_200,
  bankAtOpenMs: 20_000,
  allowanceMs: 200,
  generation: 1,
  legalActionIds: ["discard:1m"],
});

describe("shared action-window view", () => {
  it("does not consume the base budget before usable readiness", () => {
    expect(actionTimerView(window, 500)).toMatchObject({
      ready: false,
      baseRemainingMs: 5_000,
      bankRemainingMs: 20_000,
    });
    expect(actionTimerView(window, 1_000)).toMatchObject({
      ready: true,
      baseRemainingMs: 5_000,
    });
  });

  it("rounds only the view while retaining exact millisecond bank", () => {
    expect(actionTimerView(window, 6_100)).toMatchObject({
      baseRemainingMs: 0,
      bankRemainingMs: 19_900,
      bankSeconds: 20,
    });
  });

  it("captures displayed window identity rather than a later store value", () => {
    expect(intentForWindow(window, 42)).toEqual({
      windowId: "window-1",
      clockEpoch: "epoch-1",
      stateSeq: 42,
    });
  });
});
