import { describe, expect, it } from "vitest";
import {
  ActionWindowViewSchema,
  ClockSampleSchema,
  PresentationEventSchema,
} from "./timing";
import { ClientMessageSchema } from "./messages";

const window = {
  id: "match-1:0:1",
  clockEpoch: "epoch-1",
  timingVersion: 2,
  seat: 0,
  kind: "turn",
  state: "open",
  infoSentAt: 500,
  opensAt: 1_000,
  baseEndsAt: 6_000,
  budgetEndsAt: 26_000,
  expiresAt: 26_200,
  bankAtOpenMs: 20_000,
  allowanceMs: 200,
  generation: 1,
  legalActionIds: ["discard:1m"],
};

describe("timing contracts", () => {
  it("advertises fixed-prompt support separately from the earlier turn-only capability", () => {
    const hello = {
      type: "hello", matchId: "match-1", token: "test-token",
      timingCapabilities: ["clock-window-v2"], fixedPromptVersion: 1,
    };
    expect(ClientMessageSchema.parse(hello)).toMatchObject({ fixedPromptVersion: 1 });
    expect(ClientMessageSchema.safeParse({ ...hello, fixedPromptVersion: 2 }).success).toBe(false);
    expect(ClientMessageSchema.parse({
      type: "hello", matchId: "legacy-match", token: "test-token",
    })).not.toHaveProperty("fixedPromptVersion");
  });

  it("retains the explicit base, bank and transport ends", () => {
    expect(ActionWindowViewSchema.parse(window)).toEqual(window);
  });

  it("accepts an explicit unlimited gameplay window", () => {
    expect(
      ActionWindowViewSchema.parse({
        ...window,
        deadlineMode: "unlimited",
      })
    ).toMatchObject({ deadlineMode: "unlimited" });
  });

  it.each([
    { allowanceMs: 501 },
    { opensAt: 6_001 },
    { budgetEndsAt: 5_999 },
    { expiresAt: 26_201 },
    { bankAtOpenMs: 19_999 },
  ])("rejects inconsistent window metadata: %j", (change) => {
    expect(
      ActionWindowViewSchema.safeParse({ ...window, ...change }).success
    ).toBe(false);
  });

  it("validates ordered clock samples", () => {
    expect(
      ClockSampleSchema.safeParse({
        type: "clock_sample",
        probeId: "probe-1",
        clockEpoch: "epoch-1",
        serverReceivedAt: 10_000,
        serverSentAt: 9_999,
      }).success
    ).toBe(false);
  });

  it("keeps presentation timing separate from game event contents", () => {
    const presentation = {
      seq: 12,
      kind: "draw",
      occurredAt: 500,
      startsAt: 700,
      readyAt: 1_000,
    };
    expect(PresentationEventSchema.parse(presentation)).toEqual(presentation);
    expect(
      PresentationEventSchema.safeParse({
        ...presentation,
        readyAt: 699,
      }).success
    ).toBe(false);
  });
});
