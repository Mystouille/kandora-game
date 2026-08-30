import { EventEmitter } from "node:events";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  resolveTenhouRelayId,
  splitTimedWgcFrame,
  TENHOU_HANDSHAKE_TIMEOUT_MS,
  TENHOU_RECONNECT_MS,
  WsTenhouSpectateClient,
  type TenhouClientIssue,
} from "./tenhouClient";

class FakeSocket extends EventEmitter {
  readyState = WebSocket.CONNECTING;
  readonly sent: string[] = [];
  terminated = false;

  open(): void {
    this.readyState = WebSocket.OPEN;
    this.emit("open");
  }

  receive(frame: Record<string, unknown>): void {
    this.emit("message", Buffer.from(JSON.stringify(frame)));
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = WebSocket.CLOSED;
    this.emit("close");
  }

  terminate(): void {
    this.terminated = true;
    this.close();
  }
}

function clientHarness() {
  const sockets: FakeSocket[] = [];
  const issues: TenhouClientIssue[] = [];
  const frames: Record<string, unknown>[] = [];
  const client = new WsTenhouSpectateClient(
    "WATCH-ID",
    {
      onFrame: (frame) => frames.push(frame),
      onClose: () => undefined,
      onIssue: (issue) => issues.push(issue),
    },
    () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket as unknown as WebSocket;
    }
  );
  return { client, sockets, issues, frames };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("resolveTenhouRelayId", () => {
  it("uses Tenhou's anonymous guest name when no account is configured", () => {
    expect(resolveTenhouRelayId(undefined)).toBe("NoName");
    expect(resolveTenhouRelayId("")).toBe("NoName");
    expect(resolveTenhouRelayId("   ")).toBe("NoName");
  });

  it("uses the configured relay account", () => {
    expect(resolveTenhouRelayId("  ID12345678-abcd1234  ")).toBe(
      "ID12345678-abcd1234"
    );
  });
});

describe("splitTimedWgcFrame", () => {
  it("applies a leading delay before the first action", () => {
    const frames = splitTimedWgcFrame({
      tag: "WGC",
      childNodes: [6563, { tag: "D4" }, { tag: "U93" }],
    });

    expect(frames.map((entry) => entry.delayMs)).toEqual([6563, 0]);
    expect(frames.map((entry) => entry.frame.childNodes)).toEqual([
      [{ tag: "D4" }],
      [{ tag: "U93" }],
    ]);
  });

  it("applies each embedded delay before the following action", () => {
    const frames = splitTimedWgcFrame({
      tag: "WGC",
      childNodes: [
        { tag: "D105" },
        { tag: "U6" },
        1531,
        { tag: "E6" },
        { tag: "V9" },
      ],
    });

    expect(frames.map((entry) => entry.delayMs)).toEqual([0, 0, 1531, 0]);
  });

  it("preserves the observed delay before Jordan discards", () => {
    const frames = splitTimedWgcFrame({
      tag: "WGC",
      childNodes: [5031, { tag: "G110" }, { tag: "T46" }],
    });

    expect(frames.map((entry) => entry.delayMs)).toEqual([5031, 0]);
  });
});

describe("WsTenhouSpectateClient upstream recovery", () => {
  it("reconnects after a Tenhou protocol error", () => {
    vi.useFakeTimers();
    const { client, sockets, issues } = clientHarness();

    client.start();
    sockets[0].open();
    sockets[0].receive({ tag: "ERR", code: "1002" });

    expect(sockets[0].terminated).toBe(true);
    expect(issues).toEqual([{ kind: "protocol_error", detail: "1002" }]);
    vi.advanceTimersByTime(TENHOU_RECONNECT_MS);
    expect(sockets).toHaveLength(2);
    client.stop();
  });

  it("reconnects when the upstream handshake produces no relay frame", () => {
    vi.useFakeTimers();
    const { client, sockets, issues } = clientHarness();

    client.start();
    sockets[0].open();
    vi.advanceTimersByTime(TENHOU_HANDSHAKE_TIMEOUT_MS);

    expect(sockets[0].terminated).toBe(true);
    expect(issues).toEqual([{ kind: "handshake_timeout" }]);
    vi.advanceTimersByTime(TENHOU_RECONNECT_MS);
    expect(sockets).toHaveLength(2);
    client.stop();
  });

  it("keeps an accepted upstream connection open", () => {
    vi.useFakeTimers();
    const { client, sockets, issues, frames } = clientHarness();

    client.start();
    sockets[0].open();
    sockets[0].receive({ tag: "UN", n0: "East" });
    vi.advanceTimersByTime(TENHOU_HANDSHAKE_TIMEOUT_MS);

    expect(sockets[0].terminated).toBe(false);
    expect(sockets).toHaveLength(1);
    expect(issues).toEqual([]);
    expect(frames).toEqual([{ tag: "UN", n0: "East" }]);
    client.stop();
  });
});