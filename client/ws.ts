/**
 * WebSocket client for the in-browser game session.
 *
 * Phase 0.5 wires the full protocol surface (`hello`/`snapshot`/`event`/
 * `act`/`resync`/`error`) against `game-server/`. Until the server lands
 * (next turn), `connect()` is a no-op when no `wsUrl` is provided —
 * callers should pass `null` to render the table in detached mode.
 *
 * Reconnect strategy: exponential backoff with cap. On reopen, send
 * `resync { lastSeq }` so the server replays the gap. If the server
 * decides the gap is too wide, it replies with a fresh `snapshot`.
 */
import {
  ClientMessageSchema,
  ServerMessageSchema,
  type ClientMessage,
  type MatchDebug,
  type ServerMessage,
} from "~/game/protocol/messages";
import { useMatchStore } from "./store";

export interface GameWSOptions {
  wsUrl: string | null;
  token: string;
  matchId: string;
  /** Optional debug seed sent once in the `hello` frame on first attach. */
  debug?: MatchDebug;
  onError?: (code: string, message: string) => void;
}

const INITIAL_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 10_000;

export class GameWS {
  private ws: WebSocket | null = null;
  private backoff = INITIAL_BACKOFF_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionallyClosed = false;

  constructor(private readonly opts: GameWSOptions) {}

  connect(): void {
    if (!this.opts.wsUrl) {
      // No server yet — Phase 0.5 ships the client ahead of the server.
      // Mark connection as `idle`; the table will render whatever the
      // store already has (initially empty).
      useMatchStore.getState().setConn("idle");
      return;
    }
    this.intentionallyClosed = false;
    this.openSocket();
  }

  close(): void {
    this.intentionallyClosed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    useMatchStore.getState().setConn("closed");
  }

  send(message: ClientMessage): void {
    const parsed = ClientMessageSchema.safeParse(message);
    if (!parsed.success) {
      throw new Error(
        `Refused to send invalid client message: ${parsed.error.message}`
      );
    }
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }
    this.ws.send(JSON.stringify(parsed.data));
  }

  /** Convenience: send `act { actionId }`. */
  act(actionId: string): void {
    const { matchId } = useMatchStore.getState();
    if (!matchId) {
      return;
    }
    this.send({ type: "act", matchId, actionId });
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private openSocket(): void {
    if (!this.opts.wsUrl) {
      return;
    }
    const store = useMatchStore.getState();
    store.setConn(store.lastSeq >= 0 ? "reconnecting" : "connecting");

    const ws = new WebSocket(this.opts.wsUrl);
    this.ws = ws;

    ws.addEventListener("open", () => {
      this.backoff = INITIAL_BACKOFF_MS;
      useMatchStore.getState().setConn("open");

      // Send `hello`; if we have a positive `lastSeq` we're reconnecting
      // and should immediately request a gap-fill afterward.
      this.send({
        type: "hello",
        token: this.opts.token,
        matchId: this.opts.matchId,
        debug: this.opts.debug,
      });
      const { lastSeq } = useMatchStore.getState();
      if (lastSeq >= 0) {
        this.send({
          type: "resync",
          matchId: this.opts.matchId,
          lastSeq,
        });
      }
    });

    ws.addEventListener("message", (msgEvent) => {
      this.handleMessage(msgEvent.data);
    });

    ws.addEventListener("close", () => {
      this.ws = null;
      if (this.intentionallyClosed) {
        useMatchStore.getState().setConn("closed");
        return;
      }
      this.scheduleReconnect();
    });

    ws.addEventListener("error", () => {
      // The `close` handler will follow and trigger reconnect.
    });
  }

  private scheduleReconnect(): void {
    useMatchStore.getState().setConn("reconnecting");
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openSocket();
    }, delay);
  }

  private handleMessage(raw: unknown): void {
    let parsed: ReturnType<typeof ServerMessageSchema.safeParse>;
    try {
      const data = typeof raw === "string" ? JSON.parse(raw) : raw;
      parsed = ServerMessageSchema.safeParse(data);
    } catch (err) {
      this.reportError("parse_error", (err as Error).message);
      return;
    }
    if (!parsed.success) {
      this.reportError("validation_error", parsed.error.message);
      return;
    }
    this.dispatch(parsed.data);
  }

  private dispatch(msg: ServerMessage): void {
    const store = useMatchStore.getState();
    switch (msg.type) {
      case "snapshot": {
        // Authoritative recipient view from the server. Hydrate the
        // store so a mid-match reconnect renders correctly even if
        // the ring buffer dropped events older than `snapshot.seq`.
        store.hydrateSnapshot(msg.state, msg.seq);
        store.setLegalActions(msg.legalActions);
        return;
      }
      case "event": {
        // Events may arrive in batches; apply in order, advancing `seq`.
        const startSeq = msg.seq - msg.events.length + 1;
        msg.events.forEach((ev, i) => {
          store.applyEvent(ev, startSeq + i);
        });
        store.setLegalActions(msg.legalActions);
        return;
      }
      case "error": {
        this.reportError(msg.code, msg.message);
        return;
      }
    }
  }

  private reportError(code: string, message: string): void {
    if (this.opts.onError) {
      this.opts.onError(code, message);
    } else {
      // eslint-disable-next-line no-console
      console.error(`[game-ws] ${code}: ${message}`);
    }
  }
}
