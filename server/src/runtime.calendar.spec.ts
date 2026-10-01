import { describe, expect, it } from "vitest";
import { createAuthorityClock } from "./timing/authorityClock";
import { createSystemMatchRuntime, runtimeCalendarNow } from "./runtime";
import { MatchEventPublisher } from "./session/eventPublisher";

describe("independent authority and calendar references", () => {
  it("preserves elapsed-budget time while the calendar changes in either direction", () => {
    let calendar = 1_000_000;
    let monotonic = 100;
    const clock = createAuthorityClock({
      epoch: "epoch-calendar",
      wallNow: () => calendar,
      monotonicNow: () => monotonic,
    });
    const runtime = createSystemMatchRuntime(42, clock);
    monotonic += 100;
    calendar += 300_000;
    expect(runtime.now()).toBe(1_000_100);
    expect(runtimeCalendarNow(runtime)).toBe(1_300_000);
    monotonic += 100;
    calendar -= 600_000;
    expect(runtime.now()).toBe(1_000_200);
    expect(runtimeCalendarNow(runtime)).toBe(700_000);
  });

  it("journals calendar stamps without using them for spectator or decision pacing", async () => {
    let reference = 1_000;
    let calendar = 1_000_000;
    const publisher = new MatchEventPublisher({
      runtime: { now: () => reference, wallNow: () => calendar },
      timing: { record: () => undefined },
      eventJournalStore: null,
      enrichForArchive: (event) => event,
      humanSeats: () => [],
      sendToSeat: () => undefined,
      sendToSpectators: () => undefined,
      notifyDelayedSpectators: () => undefined,
    });
    await publisher.emitEvent({ type: "furiten", seat: 0, active: true });
    reference += 100;
    calendar += 300_000;
    await publisher.emitEvent({ type: "furiten", seat: 0, active: false });
    expect(publisher.history().map(({ emittedAt }) => emittedAt)).toEqual([
      1_000, 1_100,
    ]);
    expect(publisher.history().map(({ calendarAt }) => calendarAt)).toEqual([
      1_000_000, 1_300_000,
    ]);
  });
});
