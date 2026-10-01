import http from "node:http";
import { once } from "node:events";
import { WebSocket } from "ws";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  ServerMessageSchema,
  type ServerMessage,
} from "~/game/protocol/messages";
import { setReadyCheckMs } from "./match";

vi.mock("dotenv/config", () => ({}));
vi.mock("./db", () => ({ connectGameDb: async () => undefined }));
vi.mock("./persist", async () => {
  const { ephemeralMatchRepository } = await import("./repository");
  return {
    getMatchStatus: async () => null,
    mongoMatchRepository: ephemeralMatchRepository,
    mongoMatchEventJournalStore: undefined,
  };
});
vi.mock("~/game/portal-adapter", () => ({
  adapter: {
    verifyToken: async (token: string) => ({ userId: token }),
    getUserProfile: async (id: string) => ({ id, displayName: id }),
  },
}));
vi.mock("node:http", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:http")>();
  const createServer = vi.fn(original.createServer);
  return {
    ...original,
    createServer,
    default: { ...original, createServer },
  };
});

interface TestClient {
  socket: WebSocket;
  messages: ServerMessage[];
}

describe("game server spectator delay contract", () => {
  let server: http.Server;
  let origin: string;
  const clients: TestClient[] = [];
  const previousSignals = {
    SIGINT: new Set(process.listeners("SIGINT")),
    SIGTERM: new Set(process.listeners("SIGTERM")),
  };

  beforeAll(async () => {
    vi.stubEnv("GAME_ENABLED", "true");
    vi.stubEnv("GAME_SERVER_PORT", "0");
    await import("./index");
    setReadyCheckMs(0);
    const result = vi.mocked(http.createServer).mock.results[0];
    if (result?.type !== "return") {
      throw new Error("Game HTTP server was not created");
    }
    server = result.value;
    if (!server.listening) {
      await once(server, "listening");
    }
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Game server has no TCP address");
    }
    origin = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await Promise.all(
      clients.splice(0).map(async ({ socket }) => {
        if (socket.readyState === WebSocket.CLOSED) {
          return;
        }
        const closed = once(socket, "close");
        socket.close();
        await closed;
      })
    );
  });

  afterAll(async () => {
    setReadyCheckMs(5_000);
    vi.unstubAllEnvs();
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      for (const listener of process.listeners(signal)) {
        if (!previousSignals[signal].has(listener)) {
          process.removeListener(signal, listener);
        }
      }
    }
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  });

  async function createRoom(
    token: string,
    spectatorDelayMs?: unknown
  ): Promise<Response> {
    return fetch(`${origin}/rooms`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, preset: "m-league", spectatorDelayMs }),
    });
  }

  async function connect(
    matchId: string,
    userId: string,
    spectate = false
  ): Promise<TestClient> {
    const socket = new WebSocket(
      `${origin.replace("http:", "ws:")}/ws/game/${matchId}`
    );
    const client: TestClient = { socket, messages: [] };
    clients.push(client);
    socket.on("message", (raw) => {
      client.messages.push(
        ServerMessageSchema.parse(JSON.parse(raw.toString()))
      );
    });
    await once(socket, "open");
    socket.send(
      JSON.stringify({
        type: "hello",
        token: userId,
        matchId,
        clientSessionId: `session-${userId}`,
        ...(spectate ? { spectate: true, delayMs: 0 } : {}),
      })
    );
    return client;
  }

  async function waitForFrame(
    client: TestClient,
    type: ServerMessage["type"]
  ): Promise<ServerMessage> {
    return vi.waitFor(() => {
      const message = client.messages.find((frame) => frame.type === type);
      if (!message) {
        throw new Error(`Waiting for ${type}`);
      }
      return message;
    });
  }

  async function startRoom(spectatorDelayMs: 0 | 300000): Promise<string> {
    const response = await createRoom(
      `host-${spectatorDelayMs}`,
      spectatorDelayMs
    );
    expect(response.status).toBe(200);
    const { matchId } = (await response.json()) as { matchId: string };
    const players: TestClient[] = [];
    for (let seat = 0; seat < 4; seat++) {
      const player = await connect(
        matchId,
        `player-${spectatorDelayMs}-${seat}`
      );
      await waitForFrame(player, "room_state");
      player.socket.send(
        JSON.stringify({
          type: "set_room_ready",
          matchId,
          ready: true,
        })
      );
      players.push(player);
    }
    const host = players[0];
    await vi.waitFor(() => {
      expect(
        host.messages.some(
          (message) => message.type === "room_state" && message.canStart
        )
      ).toBe(true);
    });
    host.socket.send(JSON.stringify({ type: "start_match", matchId }));
    await vi.waitFor(() => {
      expect(
        host.messages.some(
          (message) =>
            message.type === "room_state" && message.status === "playing"
        )
      ).toBe(true);
    });
    return matchId;
  }

  it.each([0, 300_000])(
    "accepts and advertises a %i ms game setting",
    async (spectatorDelayMs) => {
      const response = await createRoom("creator", spectatorDelayMs);
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        matchId: string;
        spectatorDelayMs: number;
      };
      expect(body.spectatorDelayMs).toBe(spectatorDelayMs);
      const rooms = (await (await fetch(`${origin}/rooms`)).json()) as {
        rooms: Array<{ matchId: string; spectatorDelayMs: number }>;
      };
      expect(rooms.rooms).toContainEqual(
        expect.objectContaining({
          matchId: body.matchId,
          spectatorDelayMs,
        })
      );
    }
  );

  it("keeps instant as the default for existing clients", async () => {
    const response = await createRoom("legacy-creator");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      spectatorDelayMs: 0,
    });
  });

  it.each([-1, 60_000, 300_001, null, "300000"])(
    "rejects an invalid delay without creating a room: %s",
    async (spectatorDelayMs) => {
      const response = await createRoom("creator", spectatorDelayMs);
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: "invalid_spectator_delay",
      });
    }
  );

  it("serves an immediate baseline for an instant game", async () => {
    const matchId = await startRoom(0);
    const viewer = await connect(matchId, "instant-viewer", true);
    expect(await waitForFrame(viewer, "spectator_config")).toEqual({
      type: "spectator_config",
      matchId,
      delayMs: 0,
    });
    await waitForFrame(viewer, "snapshot");
  });

  it("enforces five minutes for direct and full-table redirected spectators", async () => {
    const matchId = await startRoom(300_000);
    const rejectedPlayer = await connect(matchId, "fifth-player");
    expect(await waitForFrame(rejectedPlayer, "spectate_redirect")).toEqual({
      type: "spectate_redirect",
      matchId,
    });

    for (const userId of ["direct-viewer", "fifth-player"]) {
      const viewer = await connect(matchId, userId, true);
      expect(await waitForFrame(viewer, "spectator_config")).toEqual({
        type: "spectator_config",
        matchId,
        delayMs: 300_000,
      });
      viewer.socket.send(
        JSON.stringify({ type: "resync", matchId, lastSeq: 0 })
      );
      const pong = once(viewer.socket, "pong");
      viewer.socket.ping();
      await pong;

      expect(
        viewer.messages.filter(
          (message) =>
            message.type === "snapshot" ||
            message.type === "event" ||
            message.type === "error"
        )
      ).toEqual([]);
    }
  });
});
