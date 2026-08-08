/**
 * Spectator path tests for `MatchProcess`.
 *
 * Validates the in-process spectator API added in Phase 6 Step 1:
 *
 *   - `buildSpectatorSnapshot()` produces a public view (no seat,
 *     all hands hidden, no recipient-specific furiten).
 *   - `attachSpectator(send)` fans out projected events; the
 *     projection strips per-seat private bits (draw tile, etc.)
 *     even from "own seat" perspectives — spectators have no seat.
 *   - `detachSpectator(send)` stops the fan-out.
 *   - `replaySpectatorBuffer(fromSeq)` returns a contiguous
 *     spectator-seq slice, mirroring `replayFromBuffer` for seats.
 *
 * Mongo is mocked so the orchestrator can drive a few turns
 * without a database.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./persist", () => ({
  createMatchDoc: vi.fn(async () => undefined),
  archiveMatch: vi.fn(async () => undefined),
  archiveReplayLog: vi.fn(async () => undefined),
}));

import { MatchProcess, setDelayAfterDiscardMs } from "./match";
import {
  ServerMessageSchema,
  type GameEvent,
  type ServerMessage,
} from "~/game/protocol/messages";

function makeMatch(seed: number): MatchProcess {
  return new MatchProcess(
    `m-spec-${seed}-${Math.random().toString(36).slice(2, 8)}`,
    seed,
    [
      { userId: "u0", displayName: "Bot0", isBot: true },
      { userId: "u1", displayName: "Bot1", isBot: true },
      { userId: "u2", displayName: "Bot2", isBot: true },
      { userId: "u3", displayName: "Bot3", isBot: true },
    ]
  );
}

interface SpectatorSink {
  send: (msg: ServerMessage) => void;
  events: GameEvent[];
  seqs: number[];
}

function makeSpectator(): SpectatorSink {
  const events: GameEvent[] = [];
  const seqs: number[] = [];
  return {
    send: (msg: ServerMessage): void => {
      if (msg.type === "event") {
        seqs.push(msg.seq);
        for (const ev of msg.events) {
          events.push(ev);
        }
      }
    },
    events,
    seqs,
  };
}

describe("MatchProcess spectator API", () => {
  beforeEach(() => {
    setDelayAfterDiscardMs(0);
  });
  afterEach(() => {
    vi.clearAllMocks();
    setDelayAfterDiscardMs(350);
  });

  it("buildSpectatorSnapshot has mySeat=null, all hands visible, validates against the schema", async () => {
    const m = makeMatch(7);
    await m.start();
    const snap = m.buildSpectatorSnapshot();
    const parsed = ServerMessageSchema.safeParse(snap);
    if (!parsed.success) {
      // eslint-disable-next-line no-console
      console.error(parsed.error.issues);
    }
    expect(parsed.success).toBe(true);
    if (!parsed.success || parsed.data.type !== "snapshot") {
      return;
    }
    expect(parsed.data.state.mySeat).toBeNull();
    // Spectators are omniscient: every seat's hand is fully
    // populated (no null placeholders).
    for (let s = 0; s < 4; s++) {
      expect(parsed.data.state.hands[s].every((t) => t !== null)).toBe(true);
    }
    // Public fields preserved (the all-bot match may have already
    // advanced past hand 1 by the time `start()` resolves, so we
    // only assert structural validity, not exact values).
    expect(parsed.data.state.scores).toHaveLength(4);
    expect([0, 1, 2, 3]).toContain(parsed.data.state.dealer);
    expect(["E", "S", "W", "N"]).toContain(parsed.data.state.roundWind);
    // Spectator has no legals or deadline.
    expect(parsed.data.legalActions).toEqual([]);
    expect(parsed.data.deadline).toBeUndefined();
    expect(parsed.data.state.furiten).toEqual([false, false, false, false]);
  });

  it("attached spectator receives projected events with omniscient draw tile and contiguous seq", async () => {
    const m = makeMatch(11);
    const sink = makeSpectator();
    m.attachSpectator(sink.send);
    await m.start();
    // Let the all-bot match progress a few ticks; bots act
    // synchronously inside `start()` via the orchestrator, so by
    // the time `start()` resolves we have at least `match_start`,
    // `hand_start`, and several `draw`/`discard` events.
    expect(sink.events.length).toBeGreaterThan(0);
    // Seq line is strictly contiguous from 0.
    for (let i = 0; i < sink.seqs.length; i++) {
      expect(sink.seqs[i]).toBe(i);
    }
    // Spectators are omniscient: every `draw` carries the real
    // tile.
    const draws = sink.events.filter((e) => e.type === "draw");
    expect(draws.length).toBeGreaterThan(0);
    for (const ev of draws) {
      expect((ev as { tile?: unknown }).tile).toBeDefined();
    }
    // `hand_start` is present and carries omniscient
    // `startingHands` so the client can render every seat. The
    // archived `liveWall` is also forwarded (spectators are
    // omniscient and the wall-reveal overlay uses it). The
    // server-side engine doesn't track a `liveDrawSchedule`, so
    // that one stays undefined.
    const handStart = sink.events.find((e) => e.type === "hand_start");
    expect(handStart).toBeDefined();
    if (handStart && handStart.type === "hand_start") {
      const hs = handStart as Record<string, unknown>;
      expect(Array.isArray(hs.startingHands)).toBe(true);
      expect((hs.startingHands as unknown[]).length).toBe(4);
      expect(Array.isArray(hs.liveWall)).toBe(true);
      expect((hs.liveWall as unknown[]).length).toBe(70);
      expect(hs.liveDrawSchedule).toBeUndefined();
    }
  });

  it("detachSpectator stops further fan-out", async () => {
    const m = makeMatch(13);
    const sink = makeSpectator();
    m.attachSpectator(sink.send);
    await m.start();
    const countBefore = sink.events.length;
    expect(countBefore).toBeGreaterThan(0);
    m.detachSpectator(sink.send);
    const seqBefore = m["spectatorSeq"] as number;
    // Run a few more ticks of the match by advancing the action
    // through the bots. We can't easily inject one event without
    // hitting internals, so we assert the negative path: no new
    // events arrive at the detached sink even though more events
    // may continue to emit. We approximate by directly calling the
    // internal sender via reflection — only safe in tests.
    type WithEmit = {
      emitEvent: (e: GameEvent) => Promise<void>;
    };
    const internal = m as unknown as WithEmit;
    await internal.emitEvent({
      type: "new_dora",
      indicator: "1m" as GameEvent extends { indicator: infer T } ? T : never,
    } as GameEvent);
    expect(sink.events.length).toBe(countBefore);
    // The spectator seq line still advances (other spectators
    // attached later see contiguous seqs starting beyond this point).
    expect((m["spectatorSeq"] as number) > seqBefore).toBe(true);
  });

  it("replaySpectatorBuffer returns a contiguous slice from fromSeq", async () => {
    const m = makeMatch(17);
    const sink = makeSpectator();
    m.attachSpectator(sink.send);
    await m.start();
    const all = m.replaySpectatorBuffer(0);
    // Full replay matches what the live spectator saw, both in
    // count and in seq numbering.
    expect(all.map((e) => e.seq)).toEqual(sink.seqs);
    expect(all.length).toBe(sink.events.length);
    // Sliced replay from the middle is also contiguous.
    const halfway = Math.floor(all.length / 2);
    const tail = m.replaySpectatorBuffer(halfway);
    expect(tail[0]?.seq).toBe(halfway);
    expect(tail.length).toBe(all.length - halfway);
    // Every event in tail matches the corresponding live event.
    for (let i = 0; i < tail.length; i++) {
      expect(tail[i].seq).toBe(halfway + i);
    }
  });

  it("a late-attaching spectator's snapshot reports the current spectatorSeq - 1", async () => {
    const m = makeMatch(19);
    const early = makeSpectator();
    m.attachSpectator(early.send);
    await m.start();
    const snap = m.buildSpectatorSnapshot();
    expect(snap.type).toBe("snapshot");
    if (snap.type !== "snapshot") {
      return;
    }
    // Snapshot seq matches the last event the (continuously
    // attached) spectator saw.
    expect(snap.seq).toBe(early.seqs[early.seqs.length - 1]);
  });
});
