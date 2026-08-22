import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({
  lastSeq: -1,
  matchId: "match-1",
  setConn: vi.fn(),
  setReadyCheck: vi.fn(),
  setViewers: vi.fn(),
}));

vi.mock("./store", () => ({
  useMatchStore: {
    getState: () => store,
  },
}));

import { GameWS } from "./ws";

type SocketListener = (event: Record<string, unknown>) => void;

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  readonly sent: string[] = [];
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

  close(): void {
    this.readyState = FakeWebSocket.CLOSING;
  }

  emitOpen(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.emit("open", {});
  }

  emitMessage(data: string): void {
    this.emit("message", { data });
  }

  emitClose(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.emit("close", { code: 1000, reason: "", wasClean: true });
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
    store.setReadyCheck.mockReset();
    store.setViewers.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("ignores a replaced socket's late close and messages", () => {
    const client = new GameWS({
      wsUrl: "ws://game.test/ws/game/match-1",
      token: "token",
      matchId: "match-1",
    });
    client.connect();
    const first = FakeWebSocket.instances[0];
    first.emitOpen();

    client.forceReconnect();
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

  it("still reconnects after the current socket closes", () => {
    const client = new GameWS({
      wsUrl: "ws://game.test/ws/game/match-1",
      token: "token",
      matchId: "match-1",
    });
    client.connect();
    const current = FakeWebSocket.instances[0];
    current.emitOpen();

    current.emitClose();
    expect(store.setConn).toHaveBeenCalledWith("reconnecting");
    vi.advanceTimersByTime(500);
    expect(FakeWebSocket.instances).toHaveLength(2);
    client.close();
  });

  it("dispatches ephemeral viewer presence", () => {
    const client = new GameWS({
      wsUrl: "ws://game.test/ws/game/match-1",
      token: "token",
      matchId: "match-1",
    });
    client.connect();
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
});