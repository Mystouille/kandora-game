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
import { getOrCreateGameClientSessionId } from "./connectionIdentity";
import { useMatchStore } from "./store";
import { ServerClock } from "./time/serverClock";
import { reportClockQuality } from "./time/timingDiagnostics";
import { bindLiveClock, releaseLiveClock } from "./time/liveClock";
import {
  displayedActionIntent,
  refreshScheduledWindow,
  clearScheduledWindow,
} from "./time/liveTimingBinding";
import {
  TIMING_CAPABILITY,
  FIXED_PROMPT_VERSION,
  type ActionIntentContext,
} from "~/game/protocol/timing";
import { SANMA_CAPABILITY } from "~/game/protocol/sanma";
import { MCR_CAPABILITY } from "~/game/protocol/rulesFamily";

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
  /** Stable for this browser tab / native WebView session. */
  clientSessionId?: string;
  /** Explicitly replace another client session currently owning the seat. */
  takeover?: boolean;
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
export const SESSION_REPLACED_CLOSE_CODE = 4009;
const TERMINAL_SPECTATOR_ERRORS = new Set([
  "sanma_update_required",
  "hello_timeout",
  "matchid_mismatch",
  "spectate_unavailable",
  "spectate_delay_too_large",
  "auth_failed",
  "user_not_found",
]);
const TERMINAL_PLAYER_ERRORS = new Set([
  "sanma_update_required",
  "hello_timeout",
  "matchid_mismatch",
  "auth_failed",
  "user_not_found",
  "client_session_required",
  "active_match_exists",
  "multiple_active_matches",
  "takeover_required",
  "match_lost",
  "match_finished",
  "match_not_found",
  "room_full",
  "room_locked",
  "timing_update_required",
]);

export class GameWS {
  readonly serverClock = new ServerClock();
  private clockProbeTimer: ReturnType<typeof setInterval> | null = null;
  private clockProbeIndex = 0;
  private clockRecoveryProbes = 0;
  private readonly clockStartupTimers: Array<ReturnType<typeof setTimeout>> =
    [];
  private supportsClock = false;
  private listeningForVisibility = false;
  private readonly refreshClockOnVisibility = (): void => {
    if (!this.supportsClock || typeof document === "undefined") {
      return;
    }
    this.stopClockSynchronization();
    if (document.visibilityState === "visible") {
      this.startClockSynchronization();
    }
  };
  private ws: WebSocket | null = null;
  private backoff = INITIAL_BACKOFF_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionallyClosed = false;
  private lastInboundAt = 0;
  private stallTimer: ReturnType<typeof setInterval> | null = null;
  private connectionAttempt = 0;
  private resyncRequestedFromSeq: number | null = null;
  private readonly clientSessionId: string;
  private takeoverPending: boolean;
  private sessionReplacementReported = false;

  constructor(private readonly opts: GameWSOptions) {
    this.clientSessionId =
      opts.clientSessionId ?? getOrCreateGameClientSessionId();
    this.takeoverPending = opts.takeover === true;
  }

  connect(): void {
    this.intentionallyClosed = false;
    if (typeof document !== "undefined" && !this.listeningForVisibility) {
      document.addEventListener(
        "visibilitychange",
        this.refreshClockOnVisibility
      );
      this.listeningForVisibility = true;
    }
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
    this.stopClockSynchronization();
    releaseLiveClock(this);
    if (typeof document !== "undefined" && this.listeningForVisibility) {
      document.removeEventListener(
        "visibilitychange",
        this.refreshClockOnVisibility
      );
      this.listeningForVisibility = false;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    const store = useMatchStore.getState();
    store.setConn("closed");
    this.clearStaleActionWindow();
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
    this.stopClockSynchronization();
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

  refreshClock(): void {
    if (this.supportsClock && this.ws?.readyState === WebSocket.OPEN) {
      this.stopClockSynchronization();
      this.startClockSynchronization();
    }
  }

  send(message: ClientMessage): boolean {
    const parsed = ClientMessageSchema.safeParse(message);
    if (!parsed.success) {
      throw new Error(
        `Refused to send invalid client message: ${parsed.error.message}`
      );
    }
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return false;
    }
    this.ws.send(JSON.stringify(parsed.data));
    return true;
  }

  /** Convenience: send `act { actionId }`. */
  act(actionId: string, intent?: ActionIntentContext): boolean {
    const { matchId, actionWindow, lastSeq } = useMatchStore.getState();
    if (!matchId) {
      return false;
    }
    let context = intent;
    if (context === undefined && actionWindow) {
      try {
        context = displayedActionIntent(actionId, actionWindow, lastSeq);
      } catch (error) {
        this.reportError(
          "decision_not_ready",
          error instanceof Error ? error.message : String(error)
        );
        return false;
      }
    }
    return this.send({
      type: "act",
      matchId,
      actionId,
      ...(context
        ? {
            windowId: context.windowId,
            clockEpoch: context.clockEpoch,
            stateSeq: context.stateSeq,
          }
        : {}),
    });
  }

  /** Convenience: ack the pre-match ready check. */
  ready(intent?: Pick<ActionIntentContext, "windowId" | "clockEpoch">): void {
    const { matchId, readyCheck, lastSeq } = useMatchStore.getState();
    if (!matchId) {
      return;
    }
    let context = intent;
    if (context === undefined && readyCheck?.window) {
      try {
        context = displayedActionIntent("ready", readyCheck.window, lastSeq);
      } catch (error) {
        this.reportError(
          "decision_not_ready",
          error instanceof Error ? error.message : String(error)
        );
        return;
      }
    }
    this.send({ type: "ready", matchId, ...(context ?? {}) });
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
  voteContinue(
    vote: "yes" | "no",
    intent?: Pick<ActionIntentContext, "windowId" | "clockEpoch">
  ): void {
    const { matchId, promptWindow, lastSeq } = useMatchStore.getState();
    if (!matchId) {
      return;
    }
    let context = intent;
    if (context === undefined && promptWindow?.kind === "session_vote") {
      try {
        context = displayedActionIntent(vote, promptWindow, lastSeq);
      } catch (error) {
        this.reportError(
          "decision_not_ready",
          error instanceof Error ? error.message : String(error)
        );
        return;
      }
    }
    this.send({ type: "vote_continue", matchId, vote, ...(context ?? {}) });
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async openSocket(): Promise<void> {
    const attempt = ++this.connectionAttempt;
    const store = useMatchStore.getState();
    store.setConn(store.lastSeq >= 0 ? "reconnecting" : "connecting");
    this.clearStaleActionWindow();

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
      if (error instanceof GameWSConnectionDetailsError && !error.retryable) {
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
      this.resyncRequestedFromSeq = null;
      this.lastInboundAt = Date.now();
      this.startStallWatchdog();
      console.log(
        `[game-ws] open handshake=${wsOpenedAt - openedAt}ms url=${connection.wsUrl}`
      );

      // Send `hello`; if we have a positive `lastSeq` we're reconnecting
      // and should immediately request a gap-fill afterward.
      const takeoverRequested = this.takeoverPending;
      const helloSent = this.send({
        type: "hello",
        token: connection.token,
        matchId: this.opts.matchId,
        clientSessionId: this.clientSessionId,
        timingCapabilities: [TIMING_CAPABILITY],
        gameCapabilities: [SANMA_CAPABILITY],
        mcrCapability: MCR_CAPABILITY,
        fixedPromptVersion: FIXED_PROMPT_VERSION,
        ...(takeoverRequested ? { takeover: true } : {}),
        debug: this.opts.debug,
        ...(this.opts.spectate ? { spectate: true } : {}),
        ...(this.opts.spectate && this.opts.delayMs !== undefined
          ? { delayMs: this.opts.delayMs }
          : {}),
      });
      if (helloSent && takeoverRequested) {
        // Takeover is a user-confirmed one-shot capability. Never carry it
        // into a later transport retry: if this attempt did not establish
        // ownership, the user must confirm another takeover.
        this.takeoverPending = false;
      }
      const { lastSeq } = useMatchStore.getState();
      if (lastSeq >= 0) {
        this.send({
          type: "resync",
          matchId: this.opts.matchId,
          lastSeq,
        });
      }
      useMatchStore.getState().setConn("open");
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
      this.stopClockSynchronization();
      if (
        this.intentionallyClosed ||
        event.code === SESSION_REPLACED_CLOSE_CODE
      ) {
        if (
          event.code === SESSION_REPLACED_CLOSE_CODE &&
          !this.sessionReplacementReported
        ) {
          this.sessionReplacementReported = true;
          this.opts.onMessage?.({
            type: "session_replaced",
            matchId: this.opts.matchId,
            message: "Game resumed on another device.",
          });
        }
        this.intentionallyClosed = true;
        useMatchStore.getState().setConn("closed");
        this.clearStaleActionWindow();
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
    this.clearStaleActionWindow();
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.openSocket();
    }, delay);
  }

  private clearStaleActionWindow(): void {
    const store = useMatchStore.getState();
    store.setLegalActions([]);
    store.setActionDeadline(null);
    store.setActionBufferMs(null);
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
    if (parsed.data.type === "latency_probe") {
      this.send({
        type: "latency_reply",
        matchId: this.opts.matchId,
        probeId: parsed.data.probeId,
      });
    } else if (parsed.data.type === "clock_sample") {
      const sample = this.serverClock.observe(parsed.data);
      if (sample.accepted) {
        reportClockQuality(this.serverClock.quality());
      }
      if (!sample.accepted) {
        this.reportError("clock_sample_rejected", sample.reason);
      } else if (
        (this.serverClock.quality()?.roundTripMs ?? 0) > 500 &&
        this.clockRecoveryProbes < 4
      ) {
        this.clockRecoveryProbes += 1;
        this.clockStartupTimers.push(
          setTimeout(() => this.sendClockProbe(), 50)
        );
      }
    } else if ("clock" in parsed.data && parsed.data.clock !== undefined) {
      this.supportsClock = true;
      this.startClockSynchronization();
    }
    if (this.opts.onMessage) {
      if (parsed.data.type === "session_replaced") {
        this.sessionReplacementReported = true;
      }
      try {
        this.opts.onMessage(parsed.data);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("[game-ws] onMessage observer threw", err);
      }
    }
    this.dispatch(parsed.data);
    refreshScheduledWindow();
  }

  private dispatch(msg: ServerMessage): void {
    if (msg.type === "session_replaced") {
      this.intentionallyClosed = true;
      this.connectionAttempt += 1;
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      this.stopStallWatchdog();
      this.clearStaleActionWindow();
      useMatchStore.getState().setConn("closed");
    }
    if (
      msg.type === "error" &&
      this.opts.spectate &&
      TERMINAL_SPECTATOR_ERRORS.has(msg.code)
    ) {
      this.intentionallyClosed = true;
    }
    if (
      msg.type === "error" &&
      !this.opts.spectate &&
      TERMINAL_PLAYER_ERRORS.has(msg.code)
    ) {
      this.intentionallyClosed = true;
      this.clearStaleActionWindow();
    }
    if (msg.type === "snapshot") {
      this.resyncRequestedFromSeq = null;
    }
    dispatchServerMessage(msg, {
      onError: (code, message) => this.reportError(code, message),
      onSequenceGap: ({ expectedSeq, receivedSeq }) => {
        this.requestSequenceResync(expectedSeq, receivedSeq);
      },
    });
    if (msg.type === "session_replaced" && this.ws) {
      try {
        this.ws.close();
      } catch {
        // The server also closes the socket; this is best-effort cleanup.
      }
    }
    if (msg.type === "event" && useMatchStore.getState().lastSeq === msg.seq) {
      this.resyncRequestedFromSeq = null;
    }
  }

  private requestSequenceResync(
    expectedSeq: number,
    receivedSeq: number
  ): void {
    const store = useMatchStore.getState();
    if (this.resyncRequestedFromSeq === store.lastSeq) {
      return;
    }
    this.clearStaleActionWindow();
    console.warn(
      `[game-ws] sequence gap expected=${expectedSeq} received=${receivedSeq}; requesting resync`
    );
    if (store.lastSeq < 0) {
      this.forceReconnect();
      return;
    }
    if (
      this.send({
        type: "resync",
        matchId: this.opts.matchId,
        lastSeq: store.lastSeq,
      })
    ) {
      this.resyncRequestedFromSeq = store.lastSeq;
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

  private startClockSynchronization(): void {
    if (this.clockProbeTimer !== null) {
      return;
    }
    bindLiveClock(this, this.serverClock);
    this.sendClockProbe();
    for (const delayMs of [25, 50]) {
      this.clockStartupTimers.push(
        setTimeout(() => this.sendClockProbe(), delayMs)
      );
    }
    this.clockProbeTimer = setInterval(() => this.sendClockProbe(), 5_000);
  }

  private sendClockProbe(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }
    const probeId = `clock-${++this.clockProbeIndex}`;
    this.serverClock.createProbe(probeId);
    this.send({ type: "clock_probe", matchId: this.opts.matchId, probeId });
  }

  private stopClockSynchronization(): void {
    for (const timer of this.clockStartupTimers.splice(0)) {
      clearTimeout(timer);
    }
    if (this.clockProbeTimer !== null) {
      clearInterval(this.clockProbeTimer);
      this.clockProbeTimer = null;
    }
    this.serverClock.invalidate();
    this.clockRecoveryProbes = 0;
    clearScheduledWindow();
  }
}
