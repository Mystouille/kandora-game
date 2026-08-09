/**
 * Live Tenhou kansen (spectator) WebSocket client.
 *
 * Abstracted behind `TenhouSpectateClient` so the `RelayController` can be
 * unit-tested with a fake. The real `WsTenhouSpectateClient` reproduces the
 * handshake captured in the HAR: HELO → WG(watchId) → GOK, then keepalive
 * `<Z/>` frames, forwarding `UN` / `INITBYLOG` / `WGC` frames to the decoder.
 *
 * NEEDS LIVE VALIDATION (spike 0b): the HELO name / guest-id acceptance, the
 * `Origin` policy, and the keepalive cadence are inferred from a captured HAR
 * and have NOT been confirmed against a live Tenhou endpoint from a server.
 */
import { WebSocket } from "ws";

export interface TenhouClientHandlers {
  /** A received `UN` / `INITBYLOG` / `WGC` frame (already JSON-parsed). */
  onFrame: (frame: Record<string, unknown>) => void;
  /** Fired once the client is permanently stopped (no more reconnects). */
  onClose: (reason: string) => void;
}

export interface TenhouSpectateClient {
  start(): void;
  stop(): void;
}

export type TenhouClientFactory = (
  watchId: string,
  handlers: TenhouClientHandlers
) => TenhouSpectateClient;

const TENHOU_WS_URL = process.env.TENHOU_WS_URL ?? "wss://b-ww.mjv.jp/";
const TENHOU_ORIGIN = process.env.TENHOU_ORIGIN ?? "https://tenhou.net";
const TENHOU_RELAY_ID = process.env.TENHOU_RELAY_ID ?? "";
// Tenhou rejects Node's default User-Agent; use a browser-like one (matches
// TenhouService / the lobby probe).
const TENHOU_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";
const KEEPALIVE_MS = 10_000;
const RECONNECT_MS = 3_000;

export class WsTenhouSpectateClient implements TenhouSpectateClient {
  private ws: WebSocket | null = null;
  private keepalive: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private frameTimer: NodeJS.Timeout | null = null;
  private readonly frameQueue: Array<{
    delayMs: number;
    frame: Record<string, unknown>;
  }> = [];
  private stopped = false;

  constructor(
    private readonly watchId: string,
    private readonly handlers: TenhouClientHandlers
  ) {}

  start(): void {
    this.stopped = false;
    this.open();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // ignore
      }
      this.ws = null;
    }
    this.handlers.onClose("stopped");
  }

  private clearTimers(): void {
    if (this.keepalive) {
      clearInterval(this.keepalive);
      this.keepalive = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.frameTimer) {
      clearTimeout(this.frameTimer);
      this.frameTimer = null;
    }
    this.frameQueue.length = 0;
  }

  private open(): void {
    const ws = new WebSocket(TENHOU_WS_URL, {
      headers: { "User-Agent": TENHOU_USER_AGENT, Origin: TENHOU_ORIGIN },
    });
    this.ws = ws;
    ws.on("open", () => {
      this.send({ tag: "HELO", name: TENHOU_RELAY_ID, sx: "M" });
      this.keepalive = setInterval(() => this.raw("<Z/>"), KEEPALIVE_MS);
      this.keepalive.unref?.();
    });
    ws.on("message", (data: WebSocket.RawData) => {
      this.onMessage(data.toString());
    });
    ws.on("close", () => {
      if (this.keepalive) {
        clearInterval(this.keepalive);
        this.keepalive = null;
      }
      if (this.frameTimer) {
        clearTimeout(this.frameTimer);
        this.frameTimer = null;
      }
      this.frameQueue.length = 0;
      this.ws = null;
      if (this.stopped) {
        return;
      }
      // Reconnect + re-handshake; the decoder dedupes the catch-up snapshot.
      this.reconnectTimer = setTimeout(() => this.open(), RECONNECT_MS);
      this.reconnectTimer.unref?.();
    });
    ws.on("error", () => {
      // The `close` handler follows and drives the reconnect.
    });
  }

  private onMessage(text: string): void {
    let frame: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed !== "object" || parsed === null) {
        return;
      }
      frame = parsed as Record<string, unknown>;
    } catch {
      // Non-JSON control frames (e.g. keepalive echoes) are ignored.
      return;
    }
    const tag = frame.tag;
    if (tag === "HELO") {
      this.send({ tag: "WG", id: this.watchId, tw: 0 });
      return;
    }
    if (tag === "GO") {
      this.send({ tag: "GOK" });
      return;
    }
    if (tag === "WGC") {
      this.enqueueTimedFrame(frame);
      return;
    }
    if (tag === "UN" || tag === "INITBYLOG") {
      this.handlers.onFrame(frame);
    }
  }

  private enqueueTimedFrame(frame: Record<string, unknown>): void {
    const childNodes = frame.childNodes;
    if (!Array.isArray(childNodes)) {
      this.handlers.onFrame(frame);
      return;
    }
    let delayMs = 0;
    let group: unknown[] = [];
    const flush = (): void => {
      if (group.length === 0) {
        return;
      }
      this.frameQueue.push({
        delayMs,
        frame: { ...frame, childNodes: group },
      });
      delayMs = 0;
      group = [];
    };
    for (const child of childNodes) {
      if (typeof child === "number" && Number.isFinite(child)) {
        flush();
        delayMs += Math.max(0, child);
      } else {
        group.push(child);
      }
    }
    flush();
    this.pumpFrameQueue();
  }

  private pumpFrameQueue(): void {
    if (this.frameTimer || this.frameQueue.length === 0) {
      return;
    }
    const next = this.frameQueue.shift();
    if (!next) {
      return;
    }
    const dispatch = (): void => {
      this.frameTimer = null;
      this.handlers.onFrame(next.frame);
      this.pumpFrameQueue();
    };
    if (next.delayMs === 0) {
      dispatch();
      return;
    }
    this.frameTimer = setTimeout(dispatch, next.delayMs);
    this.frameTimer.unref?.();
  }

  private send(obj: unknown): void {
    this.raw(JSON.stringify(obj));
  }

  private raw(text: string): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(text);
    }
  }
}

export const createWsTenhouClient: TenhouClientFactory = (watchId, handlers) =>
  new WsTenhouSpectateClient(watchId, handlers);
