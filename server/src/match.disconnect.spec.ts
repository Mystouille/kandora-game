/**
 * Disconnect / AFK orchestration.
 *
 * Two ingress paths converge on the same per-seat `disconnected`
 * flag inside `MatchProcess`:
 *
 *   1. Network: `detachHuman(seat)` flips the flag while the
 *      match is `playing`, immediately auto-defaults any open
 *      window, and broadcasts a `room_state` whose human
 *      occupant has `connected: false`.
 *   2. Self-reported: `handleAfk(seat, true)` does the same
 *      while the socket stays attached (so the client can keep
 *      receiving the reconnect overlay's state).
 *
 * Once flagged, future windows assigned to that seat skip the
 * deadline wait — `setSeatLegals` schedules the auto-default
 * with `0` ms. A network-only flag clears on successful socket
 * reattachment; a self-reported AFK flag requires an explicit
 * `handleAfk(seat, false)` from the reconnect button.
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
  setActionTimeoutMs,
} from "./match";
import type {
  GameEvent,
  RoomState,
  ServerMessage,
} from "~/game/protocol/messages";

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

function sink(): {
  send: (msg: ServerMessage) => void;
  events: GameEvent[];
  rooms: RoomState[];
} {
  const events: GameEvent[] = [];
  const rooms: RoomState[] = [];
  return {
    send: (msg: ServerMessage): void => {
      if (msg.type === "event") {
        for (const ev of msg.events) {
          events.push(ev);
        }
      }
      if (msg.type === "room_state") {
        rooms.push(msg);
      }
    },
    events,
    rooms,
  };
}

const wait = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

describe("MatchProcess — disconnect / AFK", () => {
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

  it("detachHuman during play flags the seat as disconnected and auto-defaults the open window", async () => {
    const m = makeMatch(21);
    const s = sink();
    const spec = sink();
    m.attachHuman(0, s.send);
    m.attachSpectator(spec.send);
    await m.start();
    const before = spec.events.filter(
      (e) => e.type === "discard" && e.seat === 0
    ).length;
    // Drop the socket mid-window. Match continues; seat 0's
    // pending discard auto-tsumogiris on the next tick (no
    // deadline wait). Observe via the spectator since seat 0's
    // own socket is gone.
    m.detachHuman(0);
    await wait(60);
    const after = spec.events.filter(
      (e) => e.type === "discard" && e.seat === 0
    ).length;
    expect(after).toBeGreaterThan(before);
  });

  it("handleAfk(true) flags the seat without dropping the socket and auto-defaults the open window", async () => {
    const m = makeMatch(22);
    const s = sink();
    m.attachHuman(0, s.send);
    await m.start();
    const before = s.events.filter(
      (e) => e.type === "discard" && e.seat === 0
    ).length;
    m.handleAfk(0, true);
    // The seat's own socket should receive a room_state whose
    // own occupant is now `connected: false`.
    const last = s.rooms[s.rooms.length - 1];
    expect(last).toBeDefined();
    const occ = last.seats[0].occupant;
    expect(occ.kind).toBe("human");
    if (occ.kind === "human") {
      expect(occ.connected).toBe(false);
    }
    // Auto-default fires on next tick.
    await wait(60);
    const after = s.events.filter(
      (e) => e.type === "discard" && e.seat === 0
    ).length;
    expect(after).toBeGreaterThan(before);
  });

  it("handleAfk(false) reverses the flag and restores normal connected reporting", async () => {
    const m = makeMatch(23);
    const s = sink();
    m.attachHuman(0, s.send);
    await m.start();
    m.handleAfk(0, true);
    m.handleAfk(0, false);
    const last = s.rooms[s.rooms.length - 1];
    expect(last).toBeDefined();
    const occ = last.seats[0].occupant;
    expect(occ.kind).toBe("human");
    if (occ.kind === "human") {
      expect(occ.connected).toBe(true);
    }
  });

  it("re-attaching after a network detach auto-clears the seat's disconnect flag", async () => {
    const m = makeMatch(24);
    const s = sink();
    m.attachHuman(0, s.send);
    await m.start();
    m.detachHuman(0);
    const s2 = sink();
    m.attachHuman(0, s2.send);
    // Network-only detach (no explicit AFK opt-out): a fresh
    // socket should restore the seat to `connected: true` so
    // the orchestrator stops auto-defaulting their windows.
    const last = s2.rooms[s2.rooms.length - 1];
    expect(last).toBeDefined();
    const occ = last.seats[0].occupant;
    expect(occ.kind).toBe("human");
    if (occ.kind === "human") {
      expect(occ.connected).toBe(true);
    }
  });

  it("ignores a stale socket detach after a replacement attaches", async () => {
    const m = makeMatch(224);
    const first = sink();
    const replacement = sink();
    m.attachHuman(0, first.send);
    await m.start();

    m.attachHuman(0, replacement.send);

    expect(m.detachHuman(0, first.send)).toBe(false);
    expect(m.isHumanAttached(0, replacement.send)).toBe(true);
    expect(m.hasConnectedHumanPlayers()).toBe(true);

    const room = m.buildRoomState(0);
    const occupant = room.seats[0].occupant;
    expect(occupant.kind).toBe("human");
    if (occupant.kind === "human") {
      expect(occupant.connected).toBe(true);
    }
  });

  it("ignores a stale liveness result after a replacement attaches", async () => {
    const m = makeMatch(225);
    const first = sink();
    let resolveFirstProbe: ((alive: boolean) => void) | undefined;
    const firstProbe = (): Promise<boolean> =>
      new Promise((resolve) => {
        resolveFirstProbe = resolve;
      });
    m.attachHuman(0, first.send, firstProbe);
    setActionTimeoutMs(0);
    await m.start();

    const internals = m as unknown as {
      bufferMs: [number, number, number, number];
      livenessProbeMisses: [number, number, number, number];
      handleDeadlineExpiry: (seat: 0) => Promise<void>;
    };
    internals.bufferMs[0] = 0;
    const expiry = internals.handleDeadlineExpiry(0);

    const replacement = sink();
    m.attachHuman(0, replacement.send, async () => true);
    resolveFirstProbe?.(false);
    await expiry;

    expect(internals.livenessProbeMisses[0]).toBe(0);
    expect(m.isHumanAttached(0, replacement.send)).toBe(true);
    const occupant = m.buildRoomState(0).seats[0].occupant;
    expect(occupant.kind).toBe("human");
    if (occupant.kind === "human") {
      expect(occupant.connected).toBe(true);
    }
  });

  it("re-attaching after self-reported AFK keeps the seat flagged until afk:false", async () => {
    const m = makeMatch(124);
    const s = sink();
    m.attachHuman(0, s.send);
    await m.start();
    m.handleAfk(0, true);
    // Socket bounces; the explicit AFK choice should NOT be
    // auto-cleared by the new attach.
    m.detachHuman(0);
    const s2 = sink();
    m.attachHuman(0, s2.send);
    const last = s2.rooms[s2.rooms.length - 1];
    expect(last).toBeDefined();
    const occ = last.seats[0].occupant;
    expect(occ.kind).toBe("human");
    if (occ.kind === "human") {
      expect(occ.connected).toBe(false);
    }
  });

  it("flagged seats skip the deadline wait on subsequent windows", async () => {
    const m = makeMatch(25);
    const s = sink();
    // Set a deliberately long action timeout. A non-flagged
    // seat would not produce a discard for ~5s+; a flagged
    // seat should auto-default almost immediately.
    setActionTimeoutMs(5_000);
    m.attachHuman(0, s.send);
    await m.start();
    m.handleAfk(0, true);
    await wait(80);
    const discards = s.events.filter(
      (e) => e.type === "discard" && e.seat === 0
    );
    expect(discards.length).toBeGreaterThan(0);
  });

  it("attached spectators receive room_state with the disconnect flag broadcast", async () => {
    const m = makeMatch(26);
    const s = sink();
    m.attachHuman(0, s.send);
    await m.start();
    const spec = sink();
    m.attachSpectator(spec.send);
    // Spectator gets an initial room_state on attach.
    expect(spec.rooms.length).toBeGreaterThan(0);
    spec.rooms.length = 0;
    m.handleAfk(0, true);
    expect(spec.rooms.length).toBeGreaterThan(0);
    const occ = spec.rooms[spec.rooms.length - 1].seats[0].occupant;
    expect(occ.kind).toBe("human");
    if (occ.kind === "human") {
      expect(occ.connected).toBe(false);
    }
  });
});
