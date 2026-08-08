/**
 * Orchestrator integration tests for end-of-hand → next-hand
 * transitions.
 *
 * Mongo persistence is mocked. We force an exhaustive draw by
 * draining the live wall to a single tile right after `start()`,
 * then drive the human through a small bounded number of turns
 * until the engine's exhaustive-draw branch fires.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./persist", () => ({
  createMatchDoc: vi.fn(async () => undefined),
  archiveMatch: vi.fn(async () => undefined),
}));

import {
  MatchProcess,
  setNextHandDelayMs,
  setDelayAfterDiscardMs,
} from "./match";
import type { GameEvent, ServerMessage } from "~/game/protocol/messages";

interface CapturedEvent {
  seq: number;
  event: GameEvent;
}

function captureSink(): {
  sink: (msg: ServerMessage) => void;
  events: CapturedEvent[];
  legals: () => Array<{ id: string; type: string; tile?: string }>;
} {
  const events: CapturedEvent[] = [];
  let legals: Array<{ id: string; type: string; tile?: string }> = [];
  const sink = (msg: ServerMessage): void => {
    if (msg.type === "event") {
      for (const ev of msg.events) {
        events.push({ seq: msg.seq, event: ev });
      }
      legals = msg.legalActions;
    }
    if (msg.type === "snapshot") {
      legals = msg.legalActions;
    }
  };
  return { sink, events, legals: () => legals };
}

function makeMatch(seed: number): MatchProcess {
  return new MatchProcess(
    `m-${seed}-${Math.random().toString(36).slice(2, 8)}`,
    seed,
    [
      { userId: "u0", displayName: "Human", isBot: false },
      { userId: "u1", displayName: "Bot1", isBot: true },
      { userId: "u2", displayName: "Bot2", isBot: true },
      { userId: "u3", displayName: "Bot3", isBot: true },
    ]
  );
}

/**
 * Force the live wall down to one tile so the next draw triggers
 * the engine's exhaustive-draw branch on the very next pop.
 */
function drainWallToOne(m: MatchProcess): void {
  const state = (m as unknown as { state: { liveWall: unknown[] } }).state;
  state.liveWall.length = 1;
}

describe("MatchProcess — hand transition", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setNextHandDelayMs(0);
    setDelayAfterDiscardMs(0);
  });
  afterEach(() => {
    vi.clearAllMocks();
    setNextHandDelayMs(3000);
    setDelayAfterDiscardMs(350);
  });

  it("emits hand_start at match start with round/wind/scores populated", async () => {
    const m = makeMatch(1);
    const { sink, events } = captureSink();
    m.attachHuman(0, sink);
    await m.start();
    const handStart = events.find((e) => e.event.type === "hand_start");
    expect(handStart).toBeTruthy();
    if (handStart && handStart.event.type === "hand_start") {
      expect(handStart.event.dealer).toBe(0);
      expect(handStart.event.roundWind).toBe("E");
      expect(handStart.event.roundNumber).toBe(1);
      expect(handStart.event.honba).toBe(0);
      expect(handStart.event.scores).toEqual([25000, 25000, 25000, 25000]);
      // Dice must be rolled and emitted so the renderer can compute
      // the wall break point from the wire event alone.
      expect(handStart.event.dice).toBeTruthy();
      if (handStart.event.dice) {
        const [d0, d1] = handStart.event.dice;
        expect(d0).toBeGreaterThanOrEqual(1);
        expect(d0).toBeLessThanOrEqual(6);
        expect(d1).toBeGreaterThanOrEqual(1);
        expect(d1).toBeLessThanOrEqual(6);
      }
    }
  });

  it("includes dice in the snapshot built for the human seat", async () => {
    const m = makeMatch(3);
    const { sink } = captureSink();
    m.attachHuman(0, sink);
    await m.start();
    const snap = m.buildSnapshotForSeat(0);
    expect(snap.type).toBe("snapshot");
    if (snap.type === "snapshot") {
      expect(snap.state.dice).toBeTruthy();
      if (snap.state.dice) {
        const [d0, d1] = snap.state.dice;
        expect(d0).toBeGreaterThanOrEqual(1);
        expect(d0).toBeLessThanOrEqual(6);
        expect(d1).toBeGreaterThanOrEqual(1);
        expect(d1).toBeLessThanOrEqual(6);
      }
      // Fresh hand: dealing took 52 tiles off the wall but only
      // the dealer's first draw has been pulled from the live
      // wall, so `drawsTaken` is 1 and `wallRemaining` is 69.
      expect(snap.state.wallRemaining).toBe(69);
      expect(snap.state.drawsTaken).toBe(1);
    }
  });

  it("does not emit match_end on a normal hand_end", async () => {
    const m = makeMatch(2);
    const { sink, events, legals } = captureSink();
    m.attachHuman(0, sink);
    await m.start();
    drainWallToOne(m);
    for (let i = 0; i < 10; i++) {
      const ls = legals();
      const next =
        ls.find((a) => a.type === "discard") ??
        ls.find((a) => a.type === "pass");
      if (!next) {
        break;
      }
      await m.handleAct(0, next.id);
      if (events.some((e) => e.event.type === "hand_end")) {
        break;
      }
    }
    const handEnds = events.filter((e) => e.event.type === "hand_end");
    const matchEnds = events.filter((e) => e.event.type === "match_end");
    expect(handEnds.length).toBeGreaterThan(0);
    expect(matchEnds.length).toBe(0);
  });

  it("emits a new hand_start after a hand ends (when match continues)", async () => {
    const m = makeMatch(2);
    const { sink, events, legals } = captureSink();
    m.attachHuman(0, sink);
    await m.start();
    drainWallToOne(m);
    for (let i = 0; i < 30; i++) {
      const handStarts = events.filter((e) => e.event.type === "hand_start");
      if (handStarts.length >= 2) {
        break;
      }
      const ls = legals();
      const next =
        ls.find((a) => a.type === "discard") ??
        ls.find((a) => a.type === "pass");
      if (!next) {
        break;
      }
      await m.handleAct(0, next.id);
    }
    const handStarts = events.filter((e) => e.event.type === "hand_start");
    expect(handStarts.length).toBeGreaterThanOrEqual(2);
    if (
      handStarts[0].event.type === "hand_start" &&
      handStarts[1].event.type === "hand_start"
    ) {
      const a = handStarts[0].event;
      const b = handStarts[1].event;
      // Either dealer rotates (non-tenpai dealer) or honba advances
      // (tenpai dealer keeps the chair) — but the two events cannot
      // be byte-identical.
      const same =
        a.dealer === b.dealer &&
        a.roundNumber === b.roundNumber &&
        a.honba === b.honba;
      expect(same).toBe(false);
    }
  });

  it("hand_end carries delta + scores from the engine", async () => {
    const m = makeMatch(2);
    const { sink, events, legals } = captureSink();
    m.attachHuman(0, sink);
    await m.start();
    drainWallToOne(m);
    for (let i = 0; i < 10; i++) {
      if (events.some((e) => e.event.type === "hand_end")) {
        break;
      }
      const ls = legals();
      const next =
        ls.find((a) => a.type === "discard") ??
        ls.find((a) => a.type === "pass");
      if (!next) {
        break;
      }
      await m.handleAct(0, next.id);
    }
    const handEnd = events.find((e) => e.event.type === "hand_end");
    expect(handEnd).toBeTruthy();
    if (handEnd && handEnd.event.type === "hand_end") {
      expect(Array.isArray(handEnd.event.delta)).toBe(true);
      expect(handEnd.event.delta?.length).toBe(4);
      expect(Array.isArray(handEnd.event.scores)).toBe(true);
      expect(handEnd.event.scores?.length).toBe(4);
    }
  });
});
