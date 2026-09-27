import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({
  lastSeq: -1,
  matchId: "match-1",
  setConn: vi.fn(),
  setLegalActions: vi.fn(),
  setActionDeadline: vi.fn(),
  setActionBufferMs: vi.fn(),
  setReadyCheck: vi.fn(),
  setRoomState: vi.fn(),
  setViewers: vi.fn(),
}));

vi.mock("./store", () => ({
  useMatchStore: {
    getState: () => store,
  },
}));

import { GameWS, GameWSConnectionDetailsError } from "./ws";

type SocketListener = (event: Record<string, unknown>) => void;

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  readonly sent: string[] = [];
  closedWith: { code?: number; reason?: string } | null = null;
  private readonly listeners = new Map<string, Set<SocketListener>>();

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: SocketListener): void {
    const listeners = this.listeners.get(type) ?? new Set<SocketListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.readyState = FakeWebSocket.CLOSING;
    this.closedWith = { code, reason };
  }

  emitOpen(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.emit("open", {});
  }

  emitMessage(data: string): void {
    this.emit("message", { data });
  }

  emitClose(code = 1000, reason = ""): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.emit("close", { code, reason, wasClean: true });
  }

  private emit(type: string, event: Record<string, unknown>): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

describe("GameWS reconnect ownership", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeWebSocket);
    FakeWebSocket.instances = [];
    store.lastSeq = -1;
    store.matchId = "match-1";
    store.setConn.mockReset();
    store.setLegalActions.mockReset();
    store.setActionDeadline.mockReset();
    store.setActionBufferMs.mockReset();
    store.setReadyCheck.mockReset();
    store.setRoomState.mockReset();
    store.setViewers.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function connectionDetails(token = "token") {
    return vi.fn().mockResolvedValue({
      wsUrl: "ws://game.test/ws/game/match-1",
      token,
    });
  }

  async function flushConnectionAttempt(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
  }

  it("ignores a replaced socket's late close and messages", async () => {
    const client = new GameWS({
      getConnectionDetails: connectionDetails(),
      matchId: "match-1",
    });
    client.connect();
    await flushConnectionAttempt();
    const first = FakeWebSocket.instances[0];
    first.emitOpen();

    client.forceReconnect();
    await flushConnectionAttempt();
    const replacement = FakeWebSocket.instances[1];
    replacement.emitOpen();
    store.setConn.mockClear();

    first.emitMessage(JSON.stringify({ type: "ready_check_end" }));
    first.emitClose();
    vi.advanceTimersByTime(10_000);

    expect(store.setReadyCheck).not.toHaveBeenCalled();
    expect(store.setConn).not.toHaveBeenCalledWith("reconnecting");
    expect(FakeWebSocket.instances).toHaveLength(2);

    replacement.emitMessage(JSON.stringify({ type: "ready_check_end" }));
    expect(store.setReadyCheck).toHaveBeenCalledWith(null);
    client.close();
  });

  it("refreshes credentials and resyncs after the current socket closes", async () => {
    const getConnectionDetails = vi
      .fn()
      .mockResolvedValueOnce({
        wsUrl: "ws://game.test/ws/game/match-1",
        token: "token-1",
      })
      .mockResolvedValueOnce({
        wsUrl: "ws://game.test/ws/game/match-1",
        token: "token-2",
      });
    const client = new GameWS({
      getConnectionDetails,
      matchId: "match-1",
      clientSessionId: "client-session-123456",
    });
    client.connect();
    await flushConnectionAttempt();
    const current = FakeWebSocket.instances[0];
    current.emitOpen();
    expect(JSON.parse(current.sent[0])).toMatchObject({
      type: "hello",
      token: "token-1",
      clientSessionId: "client-session-123456",
    });

    store.lastSeq = 42;
    current.emitClose();
    expect(store.setConn).toHaveBeenCalledWith("reconnecting");
    expect(store.setLegalActions).toHaveBeenCalledWith([]);
    expect(store.setActionDeadline).toHaveBeenCalledWith(null);
    expect(store.setActionBufferMs).toHaveBeenCalledWith(null);
    await vi.advanceTimersByTimeAsync(500);
    await flushConnectionAttempt();
    expect(FakeWebSocket.instances).toHaveLength(2);
    const replacement = FakeWebSocket.instances[1];
    replacement.emitOpen();
    expect(JSON.parse(replacement.sent[0])).toMatchObject({
      type: "hello",
      token: "token-2",
      clientSessionId: "client-session-123456",
    });
    expect(JSON.parse(replacement.sent[1])).toEqual({
      type: "resync",
      matchId: "match-1",
      lastSeq: 42,
    });
    expect(getConnectionDetails).toHaveBeenCalledTimes(2);
    client.close();
  });

  it("requests one resync when an event sequence gap is detected", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const client = new GameWS({
      getConnectionDetails: connectionDetails(),
      matchId: "match-1",
    });
    client.connect();
    await flushConnectionAttempt();
    const socket = FakeWebSocket.instances[0];
    socket.emitOpen();
    store.lastSeq = 0;

    const gapFrame = JSON.stringify({
      type: "event",
      seq: 2,
      events: [
        {
          type: "draw",
          seat: 0,
          tile: "1m",
          wallRemaining: 69,
        },
      ],
      legalActions: [],
    });
    socket.emitMessage(gapFrame);
    socket.emitMessage(gapFrame);

    const resyncFrames = socket.sent
      .map((frame) => JSON.parse(frame))
      .filter((frame) => frame.type === "resync");
    expect(resyncFrames).toEqual([
      {
        type: "resync",
        matchId: "match-1",
        lastSeq: 0,
      },
    ]);
    expect(store.setLegalActions).toHaveBeenCalledWith([]);
    expect(warn).toHaveBeenCalledWith(
      "[game-ws] sequence gap expected=1 received=2; requesting resync"
    );
    client.close();
  });

  it("reports whether an action was queued on an open socket", async () => {
    const client = new GameWS({
      getConnectionDetails: connectionDetails(),
      matchId: "match-1",
    });
    client.connect();
    await flushConnectionAttempt();
    const socket = FakeWebSocket.instances[0];

    expect(client.act("pass")).toBe(false);
    socket.emitOpen();
    expect(client.act("pass")).toBe(true);
    expect(JSON.parse(socket.sent.at(-1) as string)).toEqual({
      type: "act",
      matchId: "match-1",
      actionId: "pass",
    });
    client.close();
  });

  it("retries a transient connection-details failure", async () => {
    const onError = vi.fn();
    const getConnectionDetails = vi
      .fn()
      .mockRejectedValueOnce(new Error("Discord unavailable"))
      .mockResolvedValueOnce({
        wsUrl: "ws://game.test/ws/game/match-1",
        token: "fresh-token",
      });
    const client = new GameWS({
      getConnectionDetails,
      matchId: "match-1",
      onError,
    });

    client.connect();
    await flushConnectionAttempt();
    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(onError).toHaveBeenCalledWith(
      "session_refresh_failed",
      "Discord unavailable"
    );

    await vi.advanceTimersByTimeAsync(500);
    await flushConnectionAttempt();
    expect(FakeWebSocket.instances).toHaveLength(1);
    client.close();
  });

  it("does not retry a terminal connection-details failure", async () => {
    const getConnectionDetails = vi
      .fn()
      .mockRejectedValue(
        new GameWSConnectionDetailsError("Access denied", false)
      );
    const client = new GameWS({
      getConnectionDetails,
      matchId: "match-1",
      onError: vi.fn(),
    });

    client.connect();
    await flushConnectionAttempt();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(getConnectionDetails).toHaveBeenCalledTimes(1);
    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(store.setConn).toHaveBeenCalledWith("closed");
    client.close();
  });

  it("ignores connection details resolved after close", async () => {
    let resolveDetails!: (value: { wsUrl: string; token: string }) => void;
    const getConnectionDetails = vi.fn(
      () =>
        new Promise<{ wsUrl: string; token: string }>((resolve) => {
          resolveDetails = resolve;
        })
    );
    const client = new GameWS({
      getConnectionDetails,
      matchId: "match-1",
    });

    client.connect();
    client.close();
    resolveDetails({
      wsUrl: "ws://game.test/ws/game/match-1",
      token: "stale-token",
    });
    await flushConnectionAttempt();

    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it("dispatches ephemeral viewer presence", async () => {
    const client = new GameWS({
      getConnectionDetails: connectionDetails(),
      matchId: "match-1",
    });
    client.connect();
    await flushConnectionAttempt();
    const socket = FakeWebSocket.instances[0];
    socket.emitOpen();

    socket.emitMessage(
      JSON.stringify({
        type: "viewer_state",
        viewers: [
          { userId: "u1", displayName: "Alice", role: "player" },
          { userId: "u2", displayName: "Bob", role: "spectator" },
        ],
      })
    );

    expect(store.setViewers).toHaveBeenCalledWith([
      { userId: "u1", displayName: "Alice", role: "player" },
      { userId: "u2", displayName: "Bob", role: "spectator" },
    ]);
    client.close();
  });

  it("clears the action timer when a ready check starts", async () => {
    const client = new GameWS({
      getConnectionDetails: connectionDetails(),
      matchId: "match-1",
    });
    client.connect();
    await flushConnectionAttempt();
    const socket = FakeWebSocket.instances[0];
    socket.emitOpen();

    socket.emitMessage(
      JSON.stringify({
        type: "ready_check",
        deadline: 10_000,
        acked: [false, true, true, true],
      })
    );

    expect(store.setActionDeadline).toHaveBeenCalledWith(null);
    expect(store.setActionBufferMs).toHaveBeenCalledWith(null);
    expect(store.setReadyCheck).toHaveBeenCalledWith({
      deadline: 10_000,
      acked: [false, true, true, true],
    });
    client.close();
  });

  it("surfaces a live-spectate redirect to the message observer", async () => {
    const onMessage = vi.fn();
    const client = new GameWS({
      getConnectionDetails: connectionDetails(),
      matchId: "match-1",
      onMessage,
    });
    client.connect();
    await flushConnectionAttempt();
    const socket = FakeWebSocket.instances[0];
    socket.emitOpen();

    socket.emitMessage(
      JSON.stringify({
        type: "spectate_redirect",
        matchId: "match-1",
      })
    );

    expect(onMessage).toHaveBeenCalledWith({
      type: "spectate_redirect",
      matchId: "match-1",
    });
    client.close();
  });

  it("sends takeover only on the first transport attempt", async () => {
    const client = new GameWS({
      getConnectionDetails: connectionDetails(),
      matchId: "match-1",
      clientSessionId: "destination-session-123",
      takeover: true,
    });
    client.connect();
    await flushConnectionAttempt();
    const first = FakeWebSocket.instances[0];
    first.emitOpen();
    expect(JSON.parse(first.sent[0])).toMatchObject({
      type: "hello",
      clientSessionId: "destination-session-123",
      takeover: true,
    });

    // Even if the authoritative baseline is lost, a retry must not retain
    // stale permission to replace whichever device owns the seat by then.
    first.emitClose();
    await vi.advanceTimersByTimeAsync(500);
    await flushConnectionAttempt();
    const replacement = FakeWebSocket.instances[1];
    replacement.emitOpen();

    expect(JSON.parse(replacement.sent[0])).toMatchObject({
      type: "hello",
      clientSessionId: "destination-session-123",
    });
    expect(JSON.parse(replacement.sent[0])).not.toHaveProperty("takeover");
    client.close();
  });

  it("stops reconnecting after another device replaces the session", async () => {
    const onMessage = vi.fn();
    const client = new GameWS({
      getConnectionDetails: connectionDetails(),
      matchId: "match-1",
      clientSessionId: "source-session-123456",
      onMessage,
    });
    client.connect();
    await flushConnectionAttempt();
    const socket = FakeWebSocket.instances[0];
    socket.emitOpen();

    socket.emitMessage(
      JSON.stringify({
        type: "session_replaced",
        matchId: "match-1",
        message: "Game resumed on another device.",
      })
    );
    socket.emitClose(4009, "Session replaced");
    await vi.advanceTimersByTimeAsync(10_000);

    expect(onMessage).toHaveBeenCalledWith({
      type: "session_replaced",
      matchId: "match-1",
      message: "Game resumed on another device.",
    });
    expect(store.setConn).toHaveBeenCalledWith("closed");
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("reports replacement from the terminal close code when the message is lost", async () => {
    const onMessage = vi.fn();
    const client = new GameWS({
      getConnectionDetails: connectionDetails(),
      matchId: "match-1",
      clientSessionId: "source-session-123456",
      onMessage,
    });
    client.connect();
    await flushConnectionAttempt();
    const socket = FakeWebSocket.instances[0];
    socket.emitOpen();

    socket.emitClose(4009, "Session replaced");
    await vi.advanceTimersByTimeAsync(10_000);

    expect(onMessage).toHaveBeenCalledWith({
      type: "session_replaced",
      matchId: "match-1",
      message: "Game resumed on another device.",
    });
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("does not retry when a stale client session needs explicit takeover", async () => {
    const onError = vi.fn();
    const client = new GameWS({
      getConnectionDetails: connectionDetails(),
      matchId: "match-1",
      clientSessionId: "stale-session-123456",
      onError,
    });
    client.connect();
    await flushConnectionAttempt();
    const socket = FakeWebSocket.instances[0];
    socket.emitOpen();
    socket.emitMessage(
      JSON.stringify({
        type: "error",
        code: "takeover_required",
        message: "This game is active on another device.",
      })
    );
    socket.emitClose();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(onError).toHaveBeenCalledWith(
      "takeover_required",
      "This game is active on another device."
    );
    expect(FakeWebSocket.instances).toHaveLength(1);
  });
});
