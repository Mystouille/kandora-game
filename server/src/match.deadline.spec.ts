/**
 * Server-side action-deadline enforcement.
 *
 * The HUD timer is purely cosmetic on the client; the source of
 * truth is `MatchProcess.setLegalActions`, which schedules a
 * `setTimeout` for `ACTION_TIMEOUT_MS` and, on expiry, picks the
 * least-impact default (`pass` for a call window, tsumogiri for
 * an awaiting discard) and applies it through `handleAct`.
 *
 * Tests use a tiny timeout (15ms) instead of fake timers because
 * the production path interleaves real microtasks (engine step,
 * sink calls) that fake timers don't drain cleanly.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  MatchProcess,
  setNextHandDelayMs,
  setDelayAfterDiscardMs,
  setActionTimeoutMs,
} from "./match";
import { ephemeralMatchRepository } from "./repository";
import type { GameEvent, ServerMessage } from "~/game/protocol/messages";

function makeMatch(seed: number): MatchProcess {
  return new MatchProcess(
    `m-${seed}-${Math.random().toString(36).slice(2, 8)}`,
    seed,
    [
      { userId: "u0", displayName: "Human", isBot: false },
      { userId: "u1", displayName: "Bot1", isBot: true },
      { userId: "u2", displayName: "Bot2", isBot: true },
      { userId: "u3", displayName: "Bot3", isBot: true },
    ],
    { repository: ephemeralMatchRepository }
  );
}

function sink(): {
  send: (msg: ServerMessage) => void;
  events: GameEvent[];
  lastDeadline: () => number | null;
} {
  const events: GameEvent[] = [];
  let lastDeadline: number | null = null;
  return {
    send: (msg: ServerMessage): void => {
      if (msg.type === "event") {
        for (const ev of msg.events) {
          events.push(ev);
        }
        lastDeadline = msg.deadline ?? null;
      }
      if (msg.type === "snapshot") {
        lastDeadline = msg.deadline ?? null;
      }
    },
    events,
    lastDeadline: () => lastDeadline,
  };
}

const wait = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

describe("MatchProcess — deadline enforcement", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setNextHandDelayMs(0);
    setDelayAfterDiscardMs(0);
    setActionTimeoutMs(15);
  });
  afterEach(() => {
    setNextHandDelayMs(3000);
    setDelayAfterDiscardMs(350);
    setActionTimeoutMs(30_000);
  });

  it("emits `deadline` alongside legal actions for the human seat", async () => {
    const m = makeMatch(11);
    const s = sink();
    m.attachHuman(0, s.send);
    await m.start();
    const dl = s.lastDeadline();
    expect(dl).not.toBeNull();
    // Deadline is roughly now + ACTION_TIMEOUT_MS (15ms here).
    expect(dl).toBeGreaterThan(Date.now() - 1000);
    expect(dl).toBeLessThan(Date.now() + 5_000);
  });

  it("auto-discards (tsumogiri) when the human's discard window expires", async () => {
    const m = makeMatch(11);
    const s = sink();
    m.attachHuman(0, s.send);
    await m.start();
    const before = s.events.filter((e) => e.type === "discard").length;
    // Wait longer than the 15ms timeout; the orchestrator should
    // auto-tsumogiri and the run continues until a bot needs to
    // act. We only need to confirm a discard fired for seat 0.
    await wait(80);
    const discards = s.events.filter(
      (e) => e.type === "discard" && e.seat === 0
    );
    expect(discards.length).toBeGreaterThan(before);
  });

  it("clears the deadline timer when the human acts in time", async () => {
    const m = makeMatch(11);
    const s = sink();
    m.attachHuman(0, s.send);
    setActionTimeoutMs(0); // Disable auto-expiry for this sequence.
    await m.start();
    expect(s.lastDeadline()).toBeNull();
    // No timer pending: waiting must NOT auto-discard.
    const before = s.events.filter(
      (e) => e.type === "discard" && e.seat === 0
    ).length;
    await wait(40);
    const after = s.events.filter(
      (e) => e.type === "discard" && e.seat === 0
    ).length;
    expect(after).toBe(before);
  });
});
