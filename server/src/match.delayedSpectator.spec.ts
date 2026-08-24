/**
 * Delayed-spectator path tests for `MatchProcess`.
 *
 * Validates the Phase 6 Step 2 in-process scheduler:
 *
 *   - `attachDelayedSpectator(send, delayMs)` initially holds
 *     every event back (no ripe events at attach time when
 *     `delayMs > 0`).
 *   - After wall-clock advances past `emittedAt + delayMs`, the
 *     scheduler releases the catch-up batch as a single `event`
 *     frame; subsequent ripe events tick out one-at-a-time.
 *   - Spectator-seq numbering matches the live spectator stream
 *     (deterministic — same projection rules).
 *   - `detachDelayedSpectator` clears any pending timer and
 *     stops further fan-out.
 *   - `replayDelayedSpectatorBuffer(fromSeq, delayMs, now)`
 *     returns the contiguous ripe slice.
 *
 * Uses Vitest fake timers + `setSystemTime` to drive
 * `Date.now()` deterministically; Mongo is mocked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MatchProcess, setDelayAfterDiscardMs } from "./match";
import { ephemeralMatchRepository } from "./repository";
import type { GameEvent, ServerMessage } from "~/game/protocol/messages";

function makeMatch(seed: number): MatchProcess {
  return new MatchProcess(
    `m-delay-${seed}-${Math.random().toString(36).slice(2, 8)}`,
    seed,
    [
      { userId: "u0", displayName: "Bot0", isBot: true },
      { userId: "u1", displayName: "Bot1", isBot: true },
      { userId: "u2", displayName: "Bot2", isBot: true },
      { userId: "u3", displayName: "Bot3", isBot: true },
    ],
    { repository: ephemeralMatchRepository }
  );
}

interface DelayedSink {
  send: (msg: ServerMessage) => void;
  events: GameEvent[];
  frames: number;
  seqs: number[];
  messages: ServerMessage[];
}

function makeDelayedSink(): DelayedSink {
  const events: GameEvent[] = [];
  const seqs: number[] = [];
  const messages: ServerMessage[] = [];
  let frames = 0;
  return {
    send: (msg: ServerMessage): void => {
      messages.push(msg);
      if (msg.type === "event") {
        frames += 1;
        seqs.push(msg.seq);
        for (const ev of msg.events) {
          events.push(ev);
        }
      }
    },
    events,
    messages,
    get frames() {
      return frames;
    },
    seqs,
  } as DelayedSink;
}

// Bridge a "live" spectator sink so we can compare seq numbering.
function makeLiveSink(): { send: (m: ServerMessage) => void; seqs: number[] } {
  const seqs: number[] = [];
  return {
    send: (msg: ServerMessage): void => {
      if (msg.type === "event") {
        seqs.push(msg.seq);
      }
    },
    seqs,
  };
}

describe("MatchProcess delayed-spectator API", () => {
  beforeEach(() => {
    setDelayAfterDiscardMs(0);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    setDelayAfterDiscardMs(350);
  });

  it("holds back every event at attach when delayMs > 0", async () => {
    const m = makeMatch(31);
    await m.start();
    // Match has progressed; events sit in the log with emittedAt
    // around `now`. Attach a delayed spectator with a large
    // delay — nothing is ripe yet.
    const sink = makeDelayedSink();
    m.attachDelayedSpectator(sink.send, 5 * 60_000);
    expect(sink.frames).toBe(0);
    expect(sink.events).toHaveLength(0);
  });

  it("broadcasts presence immediately without releasing delayed events", async () => {
    const match = makeMatch(32);
    await match.start();
    const sink = makeDelayedSink();

    match.attachDelayedSpectator(sink.send, 5 * 60_000, {
      userId: "viewer-1",
      displayName: "Viewer",
      role: "spectator",
    });

    expect(sink.events).toHaveLength(0);
    expect(sink.messages).toContainEqual({
      type: "viewer_state",
      viewers: [
        {
          userId: "viewer-1",
          displayName: "Viewer",
          role: "spectator",
          delayMs: 5 * 60_000,
        },
      ],
    });
  });

  it("attaching with delayMs=0 catches up the entire log immediately as one batch", async () => {
    const m = makeMatch(37);
    await m.start();
    const sink = makeDelayedSink();
    m.attachDelayedSpectator(sink.send, 0);
    // One batched frame, multiple events, contiguous seqs from 0.
    expect(sink.frames).toBe(1);
    expect(sink.events.length).toBeGreaterThan(0);
    expect(sink.seqs).toEqual([sink.events.length - 1]);
  });

  it("releases the catch-up batch after the delay window elapses", async () => {
    vi.useFakeTimers();
    const t0 = 1_000_000_000;
    vi.setSystemTime(t0);
    const m = makeMatch(41);
    await m.start();
    const sink = makeDelayedSink();
    const delayMs = 300_000;
    m.attachDelayedSpectator(sink.send, delayMs);
    // Nothing yet (attach time is t0).
    expect(sink.events).toHaveLength(0);
    // Advance past the delay — the timer fires and drains the
    // catch-up. We use `runAllTimers` because the scheduler
    // chains successive timers as it walks the log.
    vi.setSystemTime(t0 + delayMs + 1);
    await vi.runAllTimersAsync();
    expect(sink.events.length).toBeGreaterThan(0);
    // The timer-driven path delivers one event per frame.
    expect(sink.frames).toBe(sink.events.length);
    // Seqs are contiguous from 0.
    for (let i = 0; i < sink.seqs.length; i++) {
      expect(sink.seqs[i]).toBe(i);
    }
  });

  it("delayed seq numbering matches the live spectator stream", async () => {
    vi.useFakeTimers();
    const t0 = 2_000_000_000;
    vi.setSystemTime(t0);
    const m = makeMatch(43);
    const liveSink = makeLiveSink();
    m.attachSpectator(liveSink.send);
    await m.start();
    // Live sink has a contiguous seq line from 0 upward.
    expect(liveSink.seqs[0]).toBe(0);
    // Delayed spectator at 5 min — drain everything after the
    // delay window.
    const delayedSink = makeDelayedSink();
    const delayMs = 300_000;
    m.attachDelayedSpectator(delayedSink.send, delayMs);
    vi.setSystemTime(t0 + delayMs + 10);
    await vi.runAllTimersAsync();
    // Both streams must agree on seq numbering for every event
    // the delayed spectator received.
    const liveSlice = liveSink.seqs.slice(0, delayedSink.seqs.length);
    expect(delayedSink.seqs).toEqual(liveSlice);
  });

  it("detachDelayedSpectator clears the pending timer and stops fan-out", async () => {
    vi.useFakeTimers();
    const t0 = 3_000_000_000;
    vi.setSystemTime(t0);
    const m = makeMatch(47);
    await m.start();
    const sink = makeDelayedSink();
    const delayMs = 60_000;
    const handle = m.attachDelayedSpectator(sink.send, delayMs);
    // Before the delay elapses, detach.
    m.detachDelayedSpectator(handle);
    vi.setSystemTime(t0 + delayMs + 1);
    await vi.runAllTimersAsync();
    // Nothing delivered.
    expect(sink.events).toHaveLength(0);
  });

  it("replayDelayedSpectatorBuffer returns only ripe events from fromSeq", async () => {
    vi.useFakeTimers();
    const t0 = 4_000_000_000;
    vi.setSystemTime(t0);
    const m = makeMatch(53);
    await m.start();
    const delayMs = 120_000;
    // At t0 nothing is ripe.
    expect(m.replayDelayedSpectatorBuffer(0, delayMs, t0)).toEqual([]);
    // After delay window everything is ripe.
    const after = m.replayDelayedSpectatorBuffer(0, delayMs, t0 + delayMs + 1);
    expect(after.length).toBeGreaterThan(0);
    // Mid-slice from seq=k returns events k..end with seqs that
    // start at k.
    const k = Math.floor(after.length / 2);
    const mid = m.replayDelayedSpectatorBuffer(k, delayMs, t0 + delayMs + 1);
    expect(mid[0]?.seq).toBe(k);
    expect(mid.length).toBe(after.length - k);
  });
});
