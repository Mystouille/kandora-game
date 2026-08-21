/**
 * Game-server bootstrap.
 *
 * Listens on `GAME_SERVER_PORT` (default `8787`). One WebSocket
 * endpoint at `/ws/game/:matchId`.
 *
 * Per-connection lifecycle:
 *   1. Refuse the WS upgrade when `GAME_ENABLED=false`.
 *   2. On open, expect a `hello { token, matchId }` frame within
 *      a short window. Spectators (`spectate: true`) are read-only,
 *      omniscient public viewers and are auth-exempt (no token/
 *      profile required); players verify their token via
 *      `PortalAdapter`.
 *   3. Find the resident `MatchProcess` for `matchId` (or create
 *      a fresh waiting room).
 *   4. Claim a seat for this user (random empty slot, or the
 *      user's existing seat on reconnect).
 *   5. Attach the socket as that seat's broadcast target. Send
 *      the appropriate baseline frame (`room_state` while waiting,
 *      `snapshot` while playing).
 *   6. Forward `act` / `ready` / `resync` / `start_match` /
 *      `leave_seat` frames.
 *   7. On close, detach the socket (the seat is held for
 *      reconnection until the room is finished or the seat is
 *      explicitly released).
 */
import "dotenv/config";
import http from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { nanoid } from "nanoid";
import { adapter } from "~/game/portal-adapter";
import { hashStringToSeed } from "~/game/rules";
import {
  getPreset,
  presetToRuleSet,
  listPresetIds,
} from "~/game/rules/presets";
import {
  ClientMessageSchema,
  MatchDebugSchema,
  GameEventSchema,
  type ClientMessage,
  type ServerMessage,
  type Seat,
  type MatchDebug,
} from "~/game/protocol/messages";
import { MatchProcess, setReadyCheckMs } from "./match";
import { connectGameDb } from "./db";
import { getMatchStatus } from "./persist";
import { RelayController, RelayCapacityError } from "./relay/relayController";
import { createWsTenhouClient } from "./relay/tenhouClient";

// The host bootstrap (portal or standalone) injects the PortalAdapter via
// `setAdapter(...)` before importing this module.
const PORT = Number(process.env.GAME_SERVER_PORT ?? 8787);
const GAME_ENABLED = process.env.GAME_ENABLED === "true";
const HELLO_TIMEOUT_MS = 5_000;
/**
 * Liveness-probe timeout. A WS that doesn't return a pong frame
 * within this window after `ping()` is treated as a missed
 * strike by `MatchProcess` (two consecutive misses flag the seat
 * as disconnected). 8s tolerates a mobile-carrier RTT spike
 * (3G/4G handoffs routinely add 2-5s of latency) without
 * sacrificing too much responsiveness for the other players.
 */
const LIVENESS_PROBE_TIMEOUT_MS = 8_000;
/**
 * Server-driven WebSocket heartbeat. Every interval we ping
 * each attached socket; if the previous ping didn't see a pong
 * we terminate the socket and let the `close` handler run the
 * normal detach path. Without this, idle WS connections die
 * silently behind reverse proxies (Railway / Cloudflare /
 * corporate NAT) after 30-60s of quiet — which feels like a
 * frozen game to the player and an unexplained DC to the
 * server.
 */
const HEARTBEAT_INTERVAL_MS = 15_000;
/**
 * Grace period before `abortAbandoned` fires when the last
 * connected human leaves an in-progress match. A 30s window
 * absorbs the most common transient drops (wifi handoff, sleep
 * resume, mobile network blip) without losing the game; if no
 * human reconnects within the window the room is aborted as
 * before.
 */
const ABORT_ABANDONED_GRACE_MS = 30_000;
/**
 * Hard cap on the `delayMs` a spectator may request. 30 minutes
 * is plenty for the documented ~5-minute "delayed watcher" use
 * case while keeping per-session memory bounded (we don't want
 * a client requesting `Number.MAX_SAFE_INTEGER` and pinning the
 * eventLog as if it were a permanent broadcast tape).
 */
const MAX_SPECTATOR_DELAY_MS = 30 * 60_000;

// Production default for the pre-match ready check. The match
// module ships with 0 (test-safe) so each spec doesn't have to
// opt-out; the running game-server opts in here.
setReadyCheckMs(5_000);

if (!GAME_ENABLED) {
  // eslint-disable-next-line no-console
  console.warn(
    "[game-server] GAME_ENABLED=false — server will refuse all WS upgrades. " +
      "Set GAME_ENABLED=true to enable."
  );
}

// Match registry — keyed by matchId. Slice has no eviction.
const matches = new Map<string, MatchProcess>();

// Spectator sockets currently attached to a given match. Held
// here (rather than in `MatchProcess`) because we need the raw
// `ws` handle to force-close them when the orchestrator decides
// to drop an abandoned match. The set is created lazily on first
// attach and deleted in the close hook when it goes empty.
const spectatorSockets = new Map<string, Set<WebSocket>>();

// Force-close and drop all spectator sockets for a match (used when a relay
// tears down).
function closeRelaySpectators(matchId: string): void {
  const specs = spectatorSockets.get(matchId);
  if (specs) {
    for (const ws of specs) {
      try {
        ws.close();
      } catch {
        // ignore
      }
    }
    spectatorSockets.delete(matchId);
  }
}

// One live Tenhou connection per watched game, fanned out to spectators.
const RELAY_MAX_CONCURRENT =
  Number(process.env.RELAY_MAX_CONCURRENT ?? 20) || 20;
const relayController = new RelayController({
  matches,
  closeSpectators: closeRelaySpectators,
  createClient: createWsTenhouClient,
  maxConcurrent: RELAY_MAX_CONCURRENT,
});

/**
 * Per-match grace timer that drops a freshly-created waiting
 * room if nobody has joined within `WAITING_ROOM_GRACE_MS`. The
 * portal calls `POST /rooms` and then navigates the user to the
 * `/game/:matchId` URL — there's a brief window where the room
 * has no occupants but the user is on the way; the grace period
 * absorbs that latency (and any browser tab the user closes
 * before connecting).
 *
 * Cleared in `claimSeat` once the first human joins; re-scheduled
 * is unnecessary because subsequent "empty waiting" transitions
 * are handled inline by `evictWaitingRoomIfEmpty`.
 */
const waitingRoomGraceTimers = new Map<string, NodeJS.Timeout>();
const WAITING_ROOM_GRACE_MS = 60_000;

/**
 * Per-match "last human just left" timers. Started by the
 * close handler when the room loses its final connected human;
 * fires `match.abortAbandoned()` if no human reconnects within
 * `ABORT_ABANDONED_GRACE_MS`. Cancelled by `handleConnection`
 * the instant any human re-attaches.
 */
const abortAbandonedTimers = new Map<string, NodeJS.Timeout>();

/**
 * Drop a waiting room from the in-memory registry when no human
 * could possibly be using it. Safe to call from any code path
 * that just decremented the room's effective occupancy
 * (`detachHuman`, `releaseSeat`, the post-creation grace timer).
 *
 * "Empty" here means: status is still `waiting` AND no human
 * socket is currently attached. A waiting room that lost its
 * last connected human is evicted immediately — disconnected
 * players hold no engine state in `waiting`, so there is no
 * resumable game to wait for. Other connected humans in the
 * same room keep it alive as expected.
 */
function evictWaitingRoomIfEmpty(matchId: string): void {
  const match = matches.get(matchId);
  if (!match || match.status !== "waiting") {
    return;
  }
  if (match.hasConnectedHumanPlayers()) {
    return;
  }
  matches.delete(matchId);
  const timer = waitingRoomGraceTimers.get(matchId);
  if (timer) {
    clearTimeout(timer);
    waitingRoomGraceTimers.delete(matchId);
  }
  // Close any spectator sockets that somehow attached (none
  // expected for a `waiting` room — `spectate=true` is rejected
  // unless status is `playing` — but be defensive).
  const specs = spectatorSockets.get(matchId);
  if (specs) {
    for (const ws of specs) {
      try {
        ws.close();
      } catch {
        // ignore
      }
    }
    spectatorSockets.delete(matchId);
  }
}

const server = http.createServer((req, res) => {
  // CORS preflight + permissive headers for the portal-side
  // create-room call (the dev portal runs on a different origin
  // when GAME_HTTP_URL points at a remote host; production uses
  // a same-origin proxy so headers are inert).
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type");
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }
  if (req.method === "POST" && req.url === "/rooms") {
    void handleCreateRoom(req, res);
    return;
  }
  if (req.method === "GET" && req.url === "/rooms") {
    handleListRooms(res);
    return;
  }
  if (req.method === "GET" && req.url === "/health") {
    // Liveness probe for the Railway healthcheck. Stays cheap on
    // purpose — does not touch Mongo so a transient DB blip
    // doesn't take the WS server out of rotation while existing
    // matches are still serving traffic.
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }
  if (req.method === "GET" && req.url === "/relay/stats") {
    handleRelayStats(req, res);
    return;
  }
  if (req.method === "POST" && req.url === "/relay/start") {
    void handleRelayStart(req, res);
    return;
  }
  if (req.method === "POST" && req.url === "/relay/stop") {
    void handleRelayStop(req, res);
    return;
  }
  if (req.method === "POST" && req.url === "/relay/open") {
    void handleRelayOpen(req, res);
    return;
  }
  if (req.method === "POST" && req.url === "/relay/inject") {
    void handleRelayInject(req, res);
    return;
  }
  if (req.method === "POST" && req.url === "/relay/close") {
    void handleRelayClose(req, res);
    return;
  }
  res.statusCode = 200;
  res.setHeader("content-type", "text/plain");
  res.end("kandora game-server\n");
});

// Shared secret gating the relay-control endpoints. Unset ⇒ relay disabled.
const RELAY_SECRET = process.env.RELAY_SECRET ?? "";
function relayAuthorized(req: http.IncomingMessage): boolean {
  return (
    RELAY_SECRET.length > 0 && req.headers["x-relay-secret"] === RELAY_SECRET
  );
}

/**
 * Read the JSON body of a request, capped at `maxBytes` to keep the
 * endpoints resilient against accidental floods. Returns `null` on
 * parse failure or oversize.
 */
async function readJsonBody(
  req: http.IncomingMessage,
  maxBytes = 4096
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > maxBytes) {
      return null;
    }
    chunks.push(buf);
  }
  if (total === 0) {
    return {};
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
}

/**
 * `POST /rooms` — create a fresh waiting room and return its
 * `matchId`. The portal calls this on behalf of the user, then
 * navigates the client to `/game/:matchId` to join via WS.
 *
 * Body: `{ token, debug?, preset? }`.
 *
 * Splitting creation off the WS upgrade is what makes the URL
 * itself idempotent: visiting `/game/:id` only joins; it never
 * creates a brand-new room with the same id (which would wipe
 * out an in-progress game whose entry has been evicted from
 * memory).
 */
async function handleCreateRoom(
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  const reply = (status: number, body: unknown): void => {
    res.statusCode = status;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(body));
  };
  if (!GAME_ENABLED) {
    reply(404, { error: "game_disabled" });
    return;
  }
  const body = await readJsonBody(req);
  if (body === null || typeof body !== "object") {
    reply(400, { error: "invalid_body" });
    return;
  }
  const { token, debug, preset } = body as {
    token?: unknown;
    debug?: unknown;
    preset?: unknown;
  };
  if (typeof token !== "string" || token.length === 0) {
    reply(401, { error: "missing_token" });
    return;
  }
  const verified = await adapter.verifyToken(token);
  if (!verified) {
    reply(401, { error: "auth_failed" });
    return;
  }
  let parsedDebug: MatchDebug | undefined;
  if (debug !== undefined && debug !== null) {
    const r = MatchDebugSchema.safeParse(debug);
    if (!r.success) {
      reply(400, { error: "invalid_debug" });
      return;
    }
    parsedDebug = r.data;
  }
  let presetId = "buu-east";
  if (preset !== undefined) {
    if (typeof preset !== "string" || !listPresetIds().includes(preset)) {
      reply(400, { error: "invalid_preset" });
      return;
    }
    presetId = preset;
  }
  const matchId = nanoid(12);
  const match = MatchProcess.createWaitingRoom(
    matchId,
    hashStringToSeed(matchId),
    parsedDebug,
    presetToRuleSet(getPreset(presetId)),
    presetId
  );
  matches.set(matchId, match);
  // Post-creation grace timer: if nobody connects within the
  // window, drop the room. Covers the case where the portal
  // issues `POST /rooms` but the user never opens the resulting
  // `/game/:matchId` URL (closed the tab, lost network, etc.).
  // Cleared on the first successful seat attach below.
  const graceTimer = setTimeout(() => {
    waitingRoomGraceTimers.delete(matchId);
    evictWaitingRoomIfEmpty(matchId);
  }, WAITING_ROOM_GRACE_MS);
  waitingRoomGraceTimers.set(matchId, graceTimer);
  reply(200, { matchId });
}

/**
 * `GET /rooms` — list all in-memory rooms (waiting + playing) for
 * the portal lobby. Finished matches are filtered out: the lobby
 * cares about joinable / spectate-able rooms only. Unauthenticated
 * (the data is per-seat display names + status, no engine state),
 * but still gated on `GAME_ENABLED`.
 */
function handleListRooms(res: http.ServerResponse): void {
  res.setHeader("content-type", "application/json");
  if (!GAME_ENABLED) {
    res.statusCode = 404;
    res.end(JSON.stringify({ error: "game_disabled" }));
    return;
  }
  const rooms: ReturnType<MatchProcess["summary"]>[] = [];
  for (const m of matches.values()) {
    if (m.status === "finished") {
      continue;
    }
    rooms.push(m.summary());
  }
  res.statusCode = 200;
  res.end(JSON.stringify({ rooms }));
}

/**
 * `GET /relay/stats` — relay metrics (active relays, total viewers, cap) for
 * monitoring. Auth: `x-relay-secret`.
 */
function handleRelayStats(
  req: http.IncomingMessage,
  res: http.ServerResponse
): void {
  if (!relayAuthorized(req)) {
    res.statusCode = 401;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: "relay_unauthorized" }));
    return;
  }
  res.statusCode = 200;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(relayController.stats()));
}

/**
 * `POST /relay/start` — start (or reuse) a live Tenhou relay for a watch-id.
 * De-duplicated: a second viewer of the same game reuses the existing relay.
 * Auth: `x-relay-secret`. Body: `{ watchId }`. Returns `{ matchId }`.
 */
async function handleRelayStart(
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  const reply = (status: number, body: unknown): void => {
    res.statusCode = status;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(body));
  };
  if (!GAME_ENABLED) {
    reply(404, { error: "game_disabled" });
    return;
  }
  if (!relayAuthorized(req)) {
    reply(401, { error: "relay_unauthorized" });
    return;
  }
  const body = await readJsonBody(req);
  if (body === null || typeof body !== "object") {
    reply(400, { error: "invalid_body" });
    return;
  }
  const { watchId } = body as { watchId?: unknown };
  if (typeof watchId !== "string" || watchId.length === 0) {
    reply(400, { error: "missing_watchId" });
    return;
  }
  try {
    reply(200, relayController.start(watchId));
  } catch (err) {
    if (err instanceof RelayCapacityError) {
      reply(503, { error: "relay_capacity" });
      return;
    }
    throw err;
  }
}

/**
 * `POST /relay/stop` — stop a live Tenhou relay by watch-id (archives + drops
 * the match). Auth: `x-relay-secret`. Body: `{ watchId }`.
 */
async function handleRelayStop(
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  const reply = (status: number, body: unknown): void => {
    res.statusCode = status;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(body));
  };
  if (!relayAuthorized(req)) {
    reply(401, { error: "relay_unauthorized" });
    return;
  }
  const body = await readJsonBody(req);
  if (body === null || typeof body !== "object") {
    reply(400, { error: "invalid_body" });
    return;
  }
  const { watchId } = body as { watchId?: unknown };
  if (typeof watchId !== "string") {
    reply(400, { error: "missing_watchId" });
    return;
  }
  relayController.stopByWatch(watchId);
  reply(200, { ok: true });
}

/**
 * `POST /relay/open` — create a spectator-only relay match fed by an external
 * decoder (Tenhou live). Auth: `x-relay-secret` header. Body:
 * `{ sourceGameId, ruleSet? }`. Returns `{ matchId }`.
 */
async function handleRelayOpen(
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  const reply = (status: number, body: unknown): void => {
    res.statusCode = status;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(body));
  };
  if (!GAME_ENABLED) {
    reply(404, { error: "game_disabled" });
    return;
  }
  if (!relayAuthorized(req)) {
    reply(401, { error: "relay_unauthorized" });
    return;
  }
  const body = await readJsonBody(req);
  if (body === null || typeof body !== "object") {
    reply(400, { error: "invalid_body" });
    return;
  }
  const { sourceGameId, ruleSet } = body as {
    sourceGameId?: unknown;
    ruleSet?: unknown;
  };
  if (typeof sourceGameId !== "string" || sourceGameId.length === 0) {
    reply(400, { error: "missing_sourceGameId" });
    return;
  }
  const matchId = nanoid(12);
  matches.set(
    matchId,
    MatchProcess.createRelayMatch(
      matchId,
      sourceGameId,
      typeof ruleSet === "string" ? ruleSet : undefined
    )
  );
  reply(200, { matchId });
}

/**
 * `POST /relay/inject` — append one decoded `GameEvent` to a relay match; it
 * fans out to attached spectators. Auth: `x-relay-secret`. Body:
 * `{ matchId, event }`.
 */
async function handleRelayInject(
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  const reply = (status: number, body: unknown): void => {
    res.statusCode = status;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(body));
  };
  if (!GAME_ENABLED) {
    reply(404, { error: "game_disabled" });
    return;
  }
  if (!relayAuthorized(req)) {
    reply(401, { error: "relay_unauthorized" });
    return;
  }
  const body = await readJsonBody(req, 65536);
  if (body === null || typeof body !== "object") {
    reply(400, { error: "invalid_body" });
    return;
  }
  const { matchId, event } = body as { matchId?: unknown; event?: unknown };
  if (typeof matchId !== "string") {
    reply(400, { error: "missing_matchId" });
    return;
  }
  const match = matches.get(matchId);
  if (!match || !match.isRelay) {
    reply(404, { error: "relay_not_found" });
    return;
  }
  const parsed = GameEventSchema.safeParse(event);
  if (!parsed.success) {
    reply(400, { error: "invalid_event", detail: parsed.error.message });
    return;
  }
  match.injectRelayEvent(parsed.data);
  reply(202, { ok: true });
}

/**
 * `POST /relay/close` — finalize a relay match (archive its ReplayLog and drop
 * it from the registry, closing spectator sockets). Auth: `x-relay-secret`.
 * Body: `{ matchId }`.
 */
async function handleRelayClose(
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  const reply = (status: number, body: unknown): void => {
    res.statusCode = status;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(body));
  };
  if (!relayAuthorized(req)) {
    reply(401, { error: "relay_unauthorized" });
    return;
  }
  const body = await readJsonBody(req);
  if (body === null || typeof body !== "object") {
    reply(400, { error: "invalid_body" });
    return;
  }
  const { matchId } = body as { matchId?: unknown };
  if (typeof matchId !== "string") {
    reply(400, { error: "missing_matchId" });
    return;
  }
  const match = matches.get(matchId);
  if (!match || !match.isRelay) {
    reply(404, { error: "relay_not_found" });
    return;
  }
  await match.closeRelay();
  const specs = spectatorSockets.get(matchId);
  if (specs) {
    for (const ws of specs) {
      try {
        ws.close();
      } catch {
        // ignore
      }
    }
    spectatorSockets.delete(matchId);
  }
  matches.delete(matchId);
  reply(200, { ok: true });
}

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const m = url.pathname.match(/^\/ws\/game\/([^/]+)$/);
  if (!m) {
    socket.destroy();
    return;
  }
  if (!GAME_ENABLED) {
    socket.write(
      "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
    );
    socket.destroy();
    return;
  }
  const matchId = decodeURIComponent(m[1]);
  wss.handleUpgrade(req, socket, head, (ws) => {
    attachHeartbeat(ws);
    void handleConnection(ws, matchId);
  });
});

async function handleConnection(ws: WebSocket, matchId: string): Promise<void> {
  const send = (msg: ServerMessage): void => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  };
  const sendError = (code: string, message: string): void => {
    send({ type: "error", code, message });
  };

  // Wait for `hello` first.
  const hello = await waitForHello(ws, HELLO_TIMEOUT_MS);
  if (!hello) {
    sendError("hello_timeout", "Expected `hello` frame.");
    ws.close();
    return;
  }
  if (hello.matchId !== matchId) {
    sendError("matchid_mismatch", "hello.matchId does not match URL.");
    ws.close();
    return;
  }

  // Spectator handshake: read-only, omniscient public view of an
  // in-progress match. No seat claim, no `act`/`ready`/`start_match`/
  // `leave_seat` accepted — so spectators need NO token and NO user
  // profile. This keeps live viewing public and lets any host app
  // (portal, tournaments) embed the viewer without sharing a user
  // store. The match must already be `playing` in-memory — we don't
  // currently support cross-instance spectating (matches are pinned to
  // the instance that hosts them) nor watching `waiting` / `finished`
  // rooms. (Players below still require a verified, known user.)
  if (hello.spectate === true) {
    const match = matches.get(matchId);
    if (!match || match.status !== "playing") {
      sendError(
        "spectate_unavailable",
        "This match is not currently available to spectate."
      );
      ws.close();
      return;
    }
    const delayMs = hello.delayMs ?? 0;
    if (delayMs > MAX_SPECTATOR_DELAY_MS) {
      sendError(
        "spectate_delay_too_large",
        `Spectator delay must be <= ${MAX_SPECTATOR_DELAY_MS}ms.`
      );
      ws.close();
      return;
    }
    if (delayMs > 0) {
      handleDelayedSpectatorConnection(ws, match, send, sendError, delayMs);
    } else {
      handleSpectatorConnection(ws, match, send, sendError);
    }
    return;
  }

  // ---- Player path: requires a verified token + a known user. ----
  const verified = await adapter.verifyToken(hello.token);
  if (!verified) {
    sendError("auth_failed", "Invalid or expired token.");
    ws.close();
    return;
  }
  const profile = await adapter.getUserProfile(verified.userId);
  if (!profile) {
    sendError("user_not_found", "User profile not found.");
    ws.close();
    return;
  }

  // Find the room. We DO NOT auto-create on URL visit — rooms
  // must be created explicitly via `POST /rooms` (called by the
  // lobby). Otherwise a refresh on a `/game/:matchId` URL whose
  // in-memory entry has been evicted (e.g. after the last human
  // briefly disconnected) would silently spin up a brand-new
  // empty game with the same id, losing the in-progress state
  // and confusing seat-by-userId rejoins.
  const match = matches.get(matchId);
  if (!match) {
    const persisted = await getMatchStatus(matchId);
    if (persisted === "playing") {
      sendError(
        "match_lost",
        "This match was interrupted by a server restart and cannot " +
          "be resumed. Please return to the lobby and start a new match."
      );
      ws.close();
      return;
    }
    if (persisted === "finished") {
      sendError(
        "match_finished",
        "This match has already ended. View it in your replays."
      );
      ws.close();
      return;
    }
    sendError(
      "match_not_found",
      "This room does not exist. Return to the lobby and create a new match."
    );
    ws.close();
    return;
  }

  // Claim a seat. `claimSeat` is idempotent per userId — a
  // reconnecting human gets their existing seat back even if the
  // room has already transitioned to `playing`/`finished`. A null
  // result means: room is full (waiting) or the user has no
  // claim and the room is no longer accepting new players.
  const assignedSeat = match.claimSeat(verified.userId, profile.displayName);
  if (assignedSeat === null) {
    if (match.status === "waiting") {
      sendError("room_full", "This room is full.");
    } else {
      sendError(
        "room_locked",
        "This match is already in progress and you don't have a seat."
      );
    }
    ws.close();
    return;
  }

  try {
    match.attachHuman(assignedSeat, send, () => livenessProbe(ws));
  } catch (err) {
    sendError("attach_failed", (err as Error).message);
    ws.close();
    return;
  }

  // A human just (re)attached to this room — cancel any pending
  // "last human left" abort timer. The grace window is meant to
  // absorb a transient drop, not punish a quick reconnect.
  const abortTimer = abortAbandonedTimers.get(matchId);
  if (abortTimer) {
    clearTimeout(abortTimer);
    abortAbandonedTimers.delete(matchId);
  }

  // First successful seat attach cancels the post-creation
  // grace timer (if any) — somebody is now in the room so the
  // "abandoned at birth" eviction no longer applies.
  const graceTimer = waitingRoomGraceTimers.get(matchId);
  if (graceTimer) {
    clearTimeout(graceTimer);
    waitingRoomGraceTimers.delete(matchId);
  }

  // Install the frame loop BEFORE sending the baseline — clients
  // may immediately respond with `ready` / `start_match`.
  ws.on("message", (raw) => {
    void handleClientFrame(raw, match, assignedSeat, send, sendError);
  });
  ws.on("close", () => {
    match.detachHuman(assignedSeat);
    // End an in-progress match shortly after the last connected
    // human leaves: bots playing for an empty audience burns
    // CPU and stops the room from showing as "ended" in any
    // future lobby listing. Wrapped in a grace timer so a
    // momentary network blip doesn't tank a long Buu session —
    // any human reconnect inside the window cancels the timer.
    if (match.status === "playing" && !match.hasConnectedHumanPlayers()) {
      if (!abortAbandonedTimers.has(match.matchId)) {
        const timer = setTimeout(() => {
          abortAbandonedTimers.delete(match.matchId);
          // Re-check: a reconnect may have raced this firing.
          if (match.status === "playing" && !match.hasConnectedHumanPlayers()) {
            void match.abortAbandoned();
          }
        }, ABORT_ABANDONED_GRACE_MS);
        timer.unref?.();
        abortAbandonedTimers.set(match.matchId, timer);
      }
    }
    // Drop a waiting room as soon as its last human disconnects.
    // Nothing to abort (no engine state) — just free the slot in
    // the registry so the lobby stops listing an unreachable
    // room and the user can't accidentally rejoin a zombie.
    if (match.status === "waiting") {
      evictWaitingRoomIfEmpty(match.matchId);
    }
  });

  // Baseline frame depends on room status. `attachHuman` itself
  // already broadcasts a `room_state` while waiting (because the
  // seat's `connected` flag just flipped), so we only need to
  // catch up `playing`/`finished` reconnects here.
  if (match.status === "playing" || match.status === "finished") {
    send(match.buildSnapshotForSeat(assignedSeat));
  }
}

async function waitForHello(
  ws: WebSocket,
  timeoutMs: number
): Promise<Extract<ClientMessage, { type: "hello" }> | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve(null);
    }, timeoutMs);
    const onMessage = (raw: WebSocket.RawData): void => {
      try {
        const data = JSON.parse(raw.toString());
        const parsed = ClientMessageSchema.safeParse(data);
        if (parsed.success && parsed.data.type === "hello") {
          cleanup();
          resolve(parsed.data);
          return;
        }
      } catch {
        // fall through
      }
      cleanup();
      resolve(null);
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      ws.off("message", onMessage);
    };
    ws.on("message", onMessage);
  });
}

async function handleClientFrame(
  raw: WebSocket.RawData,
  match: MatchProcess,
  seat: Seat,
  send: (msg: ServerMessage) => void,
  sendError: (code: string, message: string) => void
): Promise<void> {
  let data: unknown;
  try {
    data = JSON.parse(raw.toString());
  } catch {
    sendError("parse_error", "Invalid JSON.");
    return;
  }
  const parsed = ClientMessageSchema.safeParse(data);
  if (!parsed.success) {
    sendError("validation_error", parsed.error.message);
    return;
  }
  switch (parsed.data.type) {
    case "act": {
      await match.handleAct(seat, parsed.data.actionId);
      return;
    }
    case "ready": {
      match.handleReady(seat);
      return;
    }
    case "resync": {
      // Resync: always respond with a fresh per-seat snapshot of
      // the current engine state. The snapshot is authoritative
      // (full `hands` / `discards` / `melds` / scores / etc.,
      // redacted for the recipient) and idempotent, so it cleanly
      // covers both small reconnect gaps and full mid-match
      // rejoins.
      //
      // We deliberately do NOT replay events from the buffer here.
      // `handleConnection` already sent a snapshot at attach time
      // whose `state` reflects the engine's *current* values
      // (including any events that fired while the seat was
      // disconnected). Replaying those events on top would
      // double-apply discards / draws and, worse, any `hand_start`
      // among them would *clear* the snapshot-restored discards
      // and rewrite hands using the wrong projection — which is
      // the exact symptom of "reconnect shows no hands / no
      // discards, only the next live draw".
      send(match.buildSnapshotForSeat(seat));
      return;
    }
    case "start_match": {
      if (match.status !== "waiting") {
        sendError(
          "start_rejected",
          `Cannot start match in status "${match.status}".`
        );
        return;
      }
      try {
        // Fire-and-forget: `fillBotsAndStart` runs the full
        // pre-match ready check + first hand asynchronously.
        // Errors are logged but do not propagate back to the
        // caller — every attached human will see the failure
        // via the engine's own error/finalization frames.
        void match.fillBotsAndStart().catch((err) => {
          // eslint-disable-next-line no-console
          console.error("[game-server] fillBotsAndStart failed", err);
        });
      } catch (err) {
        sendError("start_failed", (err as Error).message);
      }
      return;
    }
    case "leave_seat": {
      if (match.status !== "waiting") {
        sendError(
          "leave_rejected",
          "Cannot leave seat once the match has started."
        );
        return;
      }
      match.releaseSeat(seat);
      // Explicit leave: same eviction rule as the disconnect
      // path — if no human is left in the room, drop it.
      evictWaitingRoomIfEmpty(match.matchId);
      return;
    }
    case "afk": {
      match.handleAfk(seat, parsed.data.afk);
      return;
    }
    case "vote_continue": {
      match.handleVoteContinue(seat, parsed.data.vote);
      return;
    }
    case "hello": {
      // Stray hello after handshake — ignore.
      return;
    }
  }
}

/**
 * Spectator branch of the WS lifecycle. No seat claim; the
 * spectator receives the public projection of every event via
 * `match.attachSpectator`. The only client frames we accept are
 * `resync` (replay public buffer) and stray `hello` (ignored);
 * `act` / `ready` / `start_match` / `leave_seat` are rejected
 * with a `spectator_forbidden` error so the wire stays honest.
 *
 * Detach on `close`. The match itself keeps running regardless
 * of spectator presence.
 */
function handleSpectatorConnection(
  ws: WebSocket,
  match: MatchProcess,
  send: (msg: ServerMessage) => void,
  sendError: (code: string, message: string) => void
): void {
  match.attachSpectator(send);
  if (match.isRelay) {
    // Relay matches have no engine state; hydrate the spectator from the
    // event buffer instead of an engine snapshot.
    const buffered = match.replaySpectatorBuffer(0);
    if (buffered.length > 0) {
      send({
        type: "event",
        seq: buffered[buffered.length - 1].seq,
        events: buffered.map((e) => e.event),
        legalActions: [],
      });
    }
  } else {
    send(match.buildSpectatorSnapshot());
  }

  let specSet = spectatorSockets.get(match.matchId);
  if (!specSet) {
    specSet = new Set();
    spectatorSockets.set(match.matchId, specSet);
  }
  specSet.add(ws);
  relayController.onSpectatorAttached(match.matchId);

  ws.on("message", (raw) => {
    let data: unknown;
    try {
      data = JSON.parse(raw.toString());
    } catch {
      sendError("parse_error", "Invalid JSON.");
      return;
    }
    const parsed = ClientMessageSchema.safeParse(data);
    if (!parsed.success) {
      sendError("validation_error", parsed.error.message);
      return;
    }
    switch (parsed.data.type) {
      case "resync": {
        const fromSeq = parsed.data.lastSeq + 1;
        const events = match.replaySpectatorBuffer(fromSeq);
        if (events.length === 0) {
          send(match.buildSpectatorSnapshot());
          return;
        }
        send({
          type: "event",
          seq: events[events.length - 1].seq,
          events: events.map((e) => e.event),
          legalActions: [],
        });
        return;
      }
      case "hello": {
        // Stray hello after handshake — ignore.
        return;
      }
      case "act":
      case "ready":
      case "start_match":
      case "leave_seat":
      case "afk":
      case "vote_continue": {
        sendError(
          "spectator_forbidden",
          "Spectators cannot send action frames."
        );
        return;
      }
    }
  });
  ws.on("close", () => {
    match.detachSpectator(send);
    relayController.onSpectatorGone(match.matchId);
    const set = spectatorSockets.get(match.matchId);
    if (set) {
      set.delete(ws);
      if (set.size === 0) {
        spectatorSockets.delete(match.matchId);
      }
    }
  });
}

/**
 * Delayed-spectator branch. Identical to the live-spectator
 * handler except:
 *
 *   - No baseline `snapshot` is sent at hello (a delayed
 *     watcher must NOT see the omniscient current state — that
 *     defeats the privacy purpose of the delay). The
 *     `attachDelayedSpectator` scheduler instead delivers the
 *     catch-up event batch and the on-going ripe events; the
 *     client hydrates entirely from those events.
 *   - `resync` slices through `replayDelayedSpectatorBuffer`
 *     instead of the live buffer (ripeness-gated).
 */
function handleDelayedSpectatorConnection(
  ws: WebSocket,
  match: MatchProcess,
  send: (msg: ServerMessage) => void,
  sendError: (code: string, message: string) => void,
  delayMs: number
): void {
  const session = match.attachDelayedSpectator(send, delayMs);

  let specSet = spectatorSockets.get(match.matchId);
  if (!specSet) {
    specSet = new Set();
    spectatorSockets.set(match.matchId, specSet);
  }
  specSet.add(ws);

  ws.on("message", (raw) => {
    let data: unknown;
    try {
      data = JSON.parse(raw.toString());
    } catch {
      sendError("parse_error", "Invalid JSON.");
      return;
    }
    const parsed = ClientMessageSchema.safeParse(data);
    if (!parsed.success) {
      sendError("validation_error", parsed.error.message);
      return;
    }
    switch (parsed.data.type) {
      case "resync": {
        const fromSeq = parsed.data.lastSeq + 1;
        const events = match.replayDelayedSpectatorBuffer(fromSeq, delayMs);
        if (events.length === 0) {
          return;
        }
        send({
          type: "event",
          seq: events[events.length - 1].seq,
          events: events.map((e) => e.event),
          legalActions: [],
        });
        return;
      }
      case "hello": {
        return;
      }
      case "act":
      case "ready":
      case "start_match":
      case "leave_seat":
      case "afk":
      case "vote_continue": {
        sendError(
          "spectator_forbidden",
          "Spectators cannot send action frames."
        );
        return;
      }
    }
  });
  ws.on("close", () => {
    match.detachDelayedSpectator(session);
    const set = spectatorSockets.get(match.matchId);
    if (set) {
      set.delete(ws);
      if (set.size === 0) {
        spectatorSockets.delete(match.matchId);
      }
    }
  });
}

/**
 * Attach a server-driven heartbeat to a freshly-upgraded WS.
 * Every `HEARTBEAT_INTERVAL_MS` we expect a pong; a missed pong
 * terminates the socket (the `close` listener handles the rest).
 * Eliminates the "frozen game behind a silent NAT" failure mode
 * where idle WS connections die without either side noticing
 * for minutes.
 *
 * Also wires up structured diagnostic logging for the lifetime
 * of the socket so we can correlate close-causes in production
 * (Railway-edge force-close vs. heartbeat-terminate vs. client
 * close vs. transport reset). Tagged with a short connection id
 * so concurrent connections are easy to disambiguate in logs.
 */
function attachHeartbeat(ws: WebSocket): void {
  const connId = nanoid(8);
  const openedAt = Date.now();
  let lastInboundAt = openedAt;
  let lastPongAt = openedAt;
  let heartbeatTerminated = false;
  let pingsSent = 0;
  let pongsReceived = 0;
  let messagesIn = 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sock = (ws as unknown as { _socket?: any })._socket;
  const remote = sock
    ? `${sock.remoteAddress ?? "?"}:${sock.remotePort ?? "?"}`
    : "?";

  console.log(
    `[ws ${connId}] open remote=${remote} requestTimeout=${server.requestTimeout} headersTimeout=${server.headersTimeout}`
  );

  let alive = true;
  ws.on("pong", () => {
    alive = true;
    pongsReceived += 1;
    lastPongAt = Date.now();
  });
  ws.on("message", () => {
    messagesIn += 1;
    lastInboundAt = Date.now();
  });
  // Underlying socket signals. A Railway-edge / proxy hard-close
  // typically surfaces here as an `error` (ECONNRESET) or an
  // `end` (FIN from upstream) before/around the ws `close`.
  if (sock) {
    sock.on("error", (err: Error & { code?: string }) => {
      console.log(
        `[ws ${connId}] socket error after=${Date.now() - openedAt}ms code=${err.code ?? "?"} msg=${err.message}`
      );
    });
    sock.on("end", () => {
      console.log(
        `[ws ${connId}] socket end (FIN) after=${Date.now() - openedAt}ms`
      );
    });
  }

  const interval = setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN) {
      clearInterval(interval);
      return;
    }
    if (!alive) {
      // No pong since the last ping — assume the link is dead
      // and force-close. The `close` handler will run the usual
      // detach + grace-timer logic.
      clearInterval(interval);
      heartbeatTerminated = true;
      console.log(
        `[ws ${connId}] heartbeat terminate (no pong) after=${Date.now() - openedAt}ms pings=${pingsSent} pongs=${pongsReceived} sinceLastPong=${Date.now() - lastPongAt}ms`
      );
      try {
        ws.terminate();
      } catch {
        // best-effort tear-down
      }
      return;
    }
    alive = false;
    pingsSent += 1;
    try {
      ws.ping();
      // Browsers do NOT expose WS protocol pongs to JavaScript,
      // so the client's stall watchdog (which only counts
      // application frames) cannot use our `ws.ping()` as a
      // proof-of-life signal. Send a tiny application-level
      // keepalive frame alongside it: the client updates its
      // `lastInboundAt` on any inbound message before schema
      // validation, so this resets the watchdog even during
      // long quiet periods (player taking minutes to think,
      // animations, between-hand pauses) where no other
      // frames flow.
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "keepalive", t: Date.now() }));
      }
    } catch {
      clearInterval(interval);
    }
  }, HEARTBEAT_INTERVAL_MS);
  interval.unref?.();
  ws.on("close", (code, reasonBuf) => {
    clearInterval(interval);
    const reason = reasonBuf?.toString?.() ?? "";
    const now = Date.now();
    console.log(
      `[ws ${connId}] close code=${code} reason="${reason}" ` +
        `lifetime=${now - openedAt}ms sinceLastMsg=${now - lastInboundAt}ms ` +
        `sinceLastPong=${now - lastPongAt}ms pings=${pingsSent} pongs=${pongsReceived} ` +
        `msgsIn=${messagesIn} heartbeatTerminated=${heartbeatTerminated}`
    );
  });
}

/**
 * Liveness probe — pings the WS once and resolves true if the
 * client returns a pong within `LIVENESS_PROBE_TIMEOUT_MS`, false
 * otherwise. Used by `MatchProcess` once a seat exhausts its
 * think buffer: a non-responsive socket flags the seat as
 * disconnected so future action windows skip the deadline wait.
 */
function livenessProbe(ws: WebSocket): Promise<boolean> {
  return new Promise((resolve) => {
    if (ws.readyState !== WebSocket.OPEN) {
      resolve(false);
      return;
    }
    let settled = false;
    const onPong = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      ws.off("pong", onPong);
      resolve(true);
    };
    ws.on("pong", onPong);
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      ws.off("pong", onPong);
      resolve(false);
    }, LIVENESS_PROBE_TIMEOUT_MS);
    timer.unref?.();
    try {
      ws.ping();
    } catch {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        ws.off("pong", onPong);
        resolve(false);
      }
    }
  });
}

async function main(): Promise<void> {
  await connectGameDb();
  server.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(
      `[game-server] listening on :${PORT}  (GAME_ENABLED=${GAME_ENABLED})`
    );
  });
}

void main();
