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
  type Seat,
  type ServerMessage,
} from "~/game/protocol/messages";
import { dispatchServerMessage } from "./dispatchServerMessage";
import { useMatchStore } from "./store";

export interface GameWSOptions {
  getConnectionDetails: () => Promise<GameWSConnectionDetails>;
  matchId: string;
  /** Optional debug seed sent once in the `hello` frame on first attach. */
  debug?: MatchDebug;
  /** When true, the client is a read-only spectator. The server
   * refuses `act`/`ready`/`start_match`/`leave_seat` frames; this
   * client must not call those methods. */
  spectate?: boolean;
  /** Optional dispatch delay (ms) for spectators. The server
   * holds each event until `emittedAt + delayMs` elapses so a
   * delayed watcher can't relay live info to a player. Ignored
   * unless `spectate` is true. */
  delayMs?: number;
  /** Optional callback fired for every successfully-parsed
   * incoming `ServerMessage`. Runs *before* the default store
   * dispatch so the caller can choose to mirror messages into a
   * private buffer (e.g. the spectator route's replay-style
   * timeline). The default store dispatch still happens — this
   * is a pure observer, not an interceptor. */
  onMessage?: (msg: ServerMessage) => void;
  onError?: (code: string, message: string) => void;
}

export interface GameWSConnectionDetails {
  wsUrl: string | null;
  token: string;
}

export class GameWSConnectionDetailsError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean
  ) {
    super(message);
    this.name = "GameWSConnectionDetailsError";
  }
}

const INITIAL_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 3_000;
/**
 * If we haven't received any frame from the server for this long
 * while the socket is reportedly OPEN, treat the connection as a
 * silent stall (dead TCP / browser sleep / mobile NAT timeout) and
 * force a reconnect. Without a server-side `ping` frame this is
 * the only way to recover from "frozen game" symptoms when the
 * OS hasn't yet noticed the link is dead.
 *
 * The server sends an application-level `keepalive` frame every
 * `HEARTBEAT_INTERVAL_MS` (15s on the game-server) so under
 * normal conditions `lastInboundAt` is bumped well within this
 * window. Threshold is set to 60s — comfortably more than 3×
 * the heartbeat interval — to absorb a missed keepalive plus
 * one stall-check tick before declaring the link dead.
 */
const STALL_THRESHOLD_MS = 60_000;
const STALL_CHECK_INTERVAL_MS = 5_000;
const TERMINAL_SPECTATOR_ERRORS = new Set([
  "hello_timeout",
  "matchid_mismatch",
  "spectate_unavailable",
  "spectate_delay_too_large",
  "auth_failed",
  "user_not_found",
]);

export class GameWS {
  private ws: WebSocket | null = null;
  private backoff = INITIAL_BACKOFF_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionallyClosed = false;
  private lastInboundAt = 0;
  private stallTimer: ReturnType<typeof setInterval> | null = null;
  private connectionAttempt = 0;

  constructor(private readonly opts: GameWSOptions) {}

  connect(): void {
    this.intentionallyClosed = false;
    void this.openSocket();
  }

  close(): void {
    this.intentionallyClosed = true;
    this.connectionAttempt += 1;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopStallWatchdog();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    useMatchStore.getState().setConn("closed");
  }

  /**
   * Manually trigger a reconnect right now (used by the
   * "Reconnect" button in the disconnection overlay). Cancels any
   * pending backoff, drops the current socket if any, resets the
   * backoff to its initial value, and opens a fresh socket. Safe
   * to call regardless of current connection state.
   */
  forceReconnect(): void {
    this.intentionallyClosed = false;
    this.connectionAttempt += 1;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopStallWatchdog();
    this.backoff = INITIAL_BACKOFF_MS;
    if (this.ws) {
      // Retire the current socket before opening its replacement.
      // Its events may still arrive later, so every listener below
      // verifies that it still owns `this.ws` before mutating state.
      const stale = this.ws;
      this.ws = null;
      try {
        stale.close();
      } catch {
        // ignored — stale socket cleanup
      }
    }
    void this.openSocket();
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

  /** Convenience: ack the pre-match ready check. */
  ready(): void {
    const { matchId } = useMatchStore.getState();
    if (!matchId) {
      return;
    }
    this.send({ type: "ready", matchId });
  }

  /** Request the server start the match (fills empty seats with
   * bots and begins the ready check). No-op outside `waiting`. */
  startMatch(): void {
    const { matchId } = useMatchStore.getState();
    if (!matchId) {
      return;
    }
    this.send({ type: "start_match", matchId });
  }

  /** Toggle the caller's readiness in the pre-match waiting room. */
  setWaitingRoomReady(ready: boolean): void {
    const { matchId } = useMatchStore.getState();
    if (!matchId) {
      return;
    }
    this.send({ type: "set_room_ready", matchId, ready });
  }

  /** Ask the waiting-room host to fill one open seat with a bot. */
  addWaitingRoomBot(): void {
    const { matchId } = useMatchStore.getState();
    if (!matchId) {
      return;
    }
    this.send({ type: "add_bot", matchId });
  }

  /** Ask the waiting-room host to remove an occupied seat. */
  kickWaitingRoomSeat(seat: Seat): void {
    const { matchId } = useMatchStore.getState();
    if (!matchId) {
      return;
    }
    this.send({ type: "kick_seat", matchId, seat });
  }

  /** Release the caller's seat in a `waiting` room. */
  leaveSeat(): void {
    const { matchId } = useMatchStore.getState();
    if (!matchId) {
      return;
    }
    this.send({ type: "leave_seat", matchId });
  }

  /**
   * Self-report AFK status. Pass `true` after 25s of idle on a
   * call/discard prompt to opt out of waiting on this client
   * (the server auto-defaults the seat's open and future
   * windows). Pass `false` when the user clicks the reconnect
   * overlay button to opt back in.
   */
  sendAfk(afk: boolean): void {
    const { matchId } = useMatchStore.getState();
    if (!matchId) {
      return;
    }
    this.send({ type: "afk", matchId, afk });
  }

  /**
   * Cast a Buu session continue-vote. Sent in response to a
   * `session_vote_open` event. No-op outside an open vote
   * window (server-side guard); may be sent repeatedly to
   * change one's mind before the window resolves.
   */
  voteContinue(vote: "yes" | "no"): void {
    const { matchId } = useMatchStore.getState();
    if (!matchId) {
      return;
    }
    this.send({ type: "vote_continue", matchId, vote });
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async openSocket(): Promise<void> {
    const attempt = ++this.connectionAttempt;
    const store = useMatchStore.getState();
    store.setConn(store.lastSeq >= 0 ? "reconnecting" : "connecting");

    let connection: GameWSConnectionDetails;
    try {
      connection = await this.opts.getConnectionDetails();
    } catch (error) {
      if (attempt !== this.connectionAttempt || this.intentionallyClosed) {
        return;
      }
      const message =
        error instanceof Error ? error.message : "Connection refresh failed";
      this.reportError("session_refresh_failed", message);
      if (
        error instanceof GameWSConnectionDetailsError &&
        !error.retryable
      ) {
        useMatchStore.getState().setConn("closed");
        return;
      }
      this.scheduleReconnect();
      return;
    }

    if (attempt !== this.connectionAttempt || this.intentionallyClosed) {
      return;
    }
    if (!connection.wsUrl) {
      useMatchStore.getState().setConn("idle");
      return;
    }

    const ws = new WebSocket(connection.wsUrl);
    this.ws = ws;
    const openedAt = Date.now();
    let wsOpenedAt = 0;

    ws.addEventListener("open", () => {
      if (this.ws !== ws) {
        return;
      }
      wsOpenedAt = Date.now();
      this.backoff = INITIAL_BACKOFF_MS;
      this.lastInboundAt = Date.now();
      this.startStallWatchdog();
      useMatchStore.getState().setConn("open");
      console.log(
        `[game-ws] open handshake=${wsOpenedAt - openedAt}ms url=${connection.wsUrl}`
      );

      // Send `hello`; if we have a positive `lastSeq` we're reconnecting
      // and should immediately request a gap-fill afterward.
      this.send({
        type: "hello",
        token: connection.token,
        matchId: this.opts.matchId,
        debug: this.opts.debug,
        ...(this.opts.spectate ? { spectate: true } : {}),
        ...(this.opts.spectate && this.opts.delayMs !== undefined
          ? { delayMs: this.opts.delayMs }
          : {}),
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
      if (this.ws !== ws) {
        return;
      }
      this.handleMessage(msgEvent.data);
    });

    ws.addEventListener("close", (event) => {
      if (this.ws !== ws) {
        return;
      }
      const now = Date.now();
      const lifetime = wsOpenedAt > 0 ? now - wsOpenedAt : now - openedAt;
      const sinceLastInbound =
        this.lastInboundAt > 0 ? now - this.lastInboundAt : -1;
      console.log(
        `[game-ws] close code=${event.code} reason="${event.reason}" ` +
          `wasClean=${event.wasClean} lifetime=${lifetime}ms ` +
          `sinceLastMsg=${sinceLastInbound}ms intentional=${this.intentionallyClosed}`
      );
      this.ws = null;
      this.stopStallWatchdog();
      if (this.intentionallyClosed) {
        useMatchStore.getState().setConn("closed");
        return;
      }
      this.scheduleReconnect();
    });

    ws.addEventListener("error", () => {
      if (this.ws !== ws) {
        return;
      }
      console.log(
        `[game-ws] error after=${Date.now() - openedAt}ms readyState=${ws.readyState}`
      );
      // The `close` handler will follow and trigger reconnect.
    });
  }

  private scheduleReconnect(): void {
    useMatchStore.getState().setConn("reconnecting");
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.openSocket();
    }, delay);
  }

  private startStallWatchdog(): void {
    this.stopStallWatchdog();
    this.stallTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        return;
      }
      if (Date.now() - this.lastInboundAt < STALL_THRESHOLD_MS) {
        return;
      }
      // Silent stall: socket is OPEN as far as the browser knows,
      // but we haven't heard anything for too long. Force-close to
      // kick off a reconnect; the `close` handler will schedule a
      // backoff retry which calls `resync(lastSeq)` so the server
      // replays the gap.
      try {
        this.ws.close();
      } catch {
        // ignored — best-effort tear-down
      }
    }, STALL_CHECK_INTERVAL_MS);
  }

  private stopStallWatchdog(): void {
    if (this.stallTimer) {
      clearInterval(this.stallTimer);
      this.stallTimer = null;
    }
  }

  private handleMessage(raw: unknown): void {
    this.lastInboundAt = Date.now();
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
    if (this.opts.onMessage) {
      try {
        this.opts.onMessage(parsed.data);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("[game-ws] onMessage observer threw", err);
      }
    }
    this.dispatch(parsed.data);
  }

  private dispatch(msg: ServerMessage): void {
    if (
      msg.type === "error" &&
      this.opts.spectate &&
      TERMINAL_SPECTATOR_ERRORS.has(msg.code)
    ) {
      this.intentionallyClosed = true;
    }
    dispatchServerMessage(msg, {
      onError: (code, message) => this.reportError(code, message),
    });
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
