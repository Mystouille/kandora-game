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
  type AutomaticActionContext,
  MatchProcess,
  setNextHandDelayMs,
  setDelayAfterDiscardMs,
  setActionTimeoutMs,
} from "./match";
import { ephemeralMatchRepository } from "./repository";
import type { GameEvent, ServerMessage } from "~/game/protocol/messages";

function makeMatch(
  seed: number,
  onAutomaticAction?: (context: AutomaticActionContext) => void
): MatchProcess {
  return new MatchProcess(
    `m-${seed}-${Math.random().toString(36).slice(2, 8)}`,
    seed,
    [
      { userId: "u0", displayName: "Human", isBot: false },
      { userId: "u1", displayName: "Bot1", isBot: true },
      { userId: "u2", displayName: "Bot2", isBot: true },
      { userId: "u3", displayName: "Bot3", isBot: true },
    ],
    { repository: ephemeralMatchRepository, onAutomaticAction }
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
    const onAutomaticAction = vi.fn();
    const m = makeMatch(11, onAutomaticAction);
    const s = sink();
    m.attachHuman(0, s.send);
    await m.start();
    const before = s.events.filter((e) => e.type === "discard").length;
    const window = m.buildSnapshotForSeat(0).actionWindow;
    if (window === undefined || window === null) {
      throw new Error("expected an authoritative discard window");
    }
    // Wait through presentation readiness, the action budget, and allowance.
    // auto-tsumogiri and the run continues until a bot needs to
    // act. We only need to confirm a discard fired for seat 0.
    await wait(Math.max(0, window.expiresAt - m.authorityNow()) + 50);
    const discards = s.events.filter(
      (e) => e.type === "discard" && e.seat === 0
    );
    expect(discards.length).toBeGreaterThan(before);
    expect(onAutomaticAction).toHaveBeenCalledWith(
      expect.objectContaining({
        matchId: m.matchId,
        gameId: m.matchId,
        seat: 0,
        actionId: expect.stringMatching(/^discard:draw:/),
        reason: "deadline",
        bufferMs: 0,
      })
    );
  });

  it("does not auto-discard before a long authoritative deadline", async () => {
    const m = makeMatch(11);
    const s = sink();
    m.attachHuman(0, s.send);
    setActionTimeoutMs(60_000);
    await m.start();
    expect(s.lastDeadline()).not.toBeNull();
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
