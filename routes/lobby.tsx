import { useNavigate } from "react-router";
import { useCallback, useEffect, useState } from "react";
import { requireGameEnabled, getClientGameFlag } from "~/game/feature-gate";
import { parseTileList, saveAutoStart } from "~/game/client/debugSeed";
import type { MatchDebug } from "~/game/protocol/messages";
import type { Route } from "./+types/lobby";

/**
 * `/lobby` — entry point for the multi-human walking skeleton.
 *
 *   - "Start solo match" creates a fresh room and immediately
 *     fills it with bots once the WS attaches (auto-start flag).
 *   - "Create room" creates a fresh room and lands the user in
 *     the waiting room so they can share the URL with friends.
 *   - "Join room" navigates to an existing room by matchId.
 *
 * An optional debug panel lets the tester force seat 0's starting
 * hand and draws (solo only).
 *
 * Gated by `requireGameEnabled()` — 404s when `GAME_ENABLED` is false.
 */
export async function loader(_args: Route.LoaderArgs) {
  requireGameEnabled();
  return { flag: getClientGameFlag() };
}

const PLACEHOLDER_HAND = "123456789m1234p";
const PLACEHOLDER_DRAWS = "555z";
const PLACEHOLDER_LEFT = "123z";

interface LiveRoomSeat {
  name: string | null;
  isBot: boolean;
}
interface LiveRoom {
  matchId: string;
  status: "waiting" | "playing" | "finished";
  buuMode: boolean;
  seats: Array<LiveRoomSeat | null>;
}

export default function LobbyRoute() {
  const navigate = useNavigate();
  const [starting, setStarting] = useState(false);
  const [showDebug, setShowDebug] = useState(false);
  const [humanHand, setHumanHand] = useState("");
  const [humanDraws, setHumanDraws] = useState("");
  const [leftDiscards, setLeftDiscards] = useState("");
  const [joinId, setJoinId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [rooms, setRooms] = useState<LiveRoom[] | null>(null);
  const [roomsLoading, setRoomsLoading] = useState(false);
  const [roomsError, setRoomsError] = useState<string | null>(null);

  const refreshRooms = useCallback(async () => {
    setRoomsLoading(true);
    setRoomsError(null);
    try {
      const basePath = (import.meta.env.BASE_URL || "/").replace(/\/$/, "");
      const res = await fetch(`${basePath}/api/game/rooms`, {
        method: "GET",
        credentials: "include",
      });
      if (!res.ok) {
        setRoomsError(`Failed to load rooms (${res.status}).`);
        return;
      }
      const data = (await res.json()) as { rooms?: LiveRoom[] };
      setRooms(data.rooms ?? []);
    } catch (err) {
      setRoomsError(
        `Failed to reach server: ${(err as Error).message ?? "unknown"}`
      );
    } finally {
      setRoomsLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshRooms();
  }, [refreshRooms]);

  // When the user logs in (or out) the rooms endpoint requires a
  // fresh request — without this the list stays stuck on the 401
  // it returned while we were anonymous. The `auth-changed` event
  // is dispatched by the login flow and the account page.
  useEffect(() => {
    const handler = () => {
      void refreshRooms();
    };
    window.addEventListener("auth-changed", handler);
    return () => window.removeEventListener("auth-changed", handler);
  }, [refreshRooms]);

  function buildDebug(): { debug: MatchDebug; ok: boolean } {
    if (!showDebug) {
      return { debug: undefined, ok: true };
    }
    const out: NonNullable<MatchDebug> = {};
    const invalid: string[] = [];

    if (humanHand.trim()) {
      const parsed = parseTileList(humanHand);
      invalid.push(...parsed.invalid);
      if (parsed.tiles.length > 0) {
        out.humanHand = parsed.tiles;
      }
    }
    if (humanDraws.trim()) {
      const parsed = parseTileList(humanDraws);
      invalid.push(...parsed.invalid);
      if (parsed.tiles.length > 0) {
        out.humanDraws = parsed.tiles;
      }
    }
    if (leftDiscards.trim()) {
      const parsed = parseTileList(leftDiscards);
      invalid.push(...parsed.invalid);
      if (parsed.tiles.length > 0) {
        out.leftDiscards = parsed.tiles;
      }
    }

    if (invalid.length > 0) {
      setError(
        `Invalid tile token(s): ${invalid.join(
          ", "
        )}. Use compact notation like "123456789m1234p" or single tokens like "1m 5p 7s 1z".`
      );
      return { debug: undefined, ok: false };
    }
    if (out.humanHand && out.humanHand.length !== 13) {
      setError(
        `Starting hand should have 13 tiles, got ${out.humanHand.length}.`
      );
      return { debug: undefined, ok: false };
    }
    return {
      debug: Object.keys(out).length > 0 ? out : undefined,
      ok: true,
    };
  }

  /**
   * Ask the portal to create a fresh room on the game-server.
   * Returns the new `matchId`, or `null` on failure (a message
   * is set on `error`). We do NOT generate the id client-side
   * anymore: the game-server owns room lifecycle so that the
   * `/game/:matchId` URL is purely a join target and a refresh
   * can never spin up a brand-new game with the same id.
   */
  async function createRoomOnServer(debug: MatchDebug): Promise<string | null> {
    try {
      const basePath = (import.meta.env.BASE_URL || "/").replace(/\/$/, "");
      const res = await fetch(`${basePath}/api/game/rooms`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ debug, preset: "buu-east" }),
      });
      if (!res.ok) {
        const text = await res.text();
        setError(`Failed to create room (${res.status}): ${text || "unknown"}`);
        return null;
      }
      const data = (await res.json()) as { matchId?: string };
      if (!data.matchId) {
        setError("Game server returned no matchId.");
        return null;
      }
      return data.matchId;
    } catch (err) {
      setError(
        `Failed to reach game server: ${(err as Error).message ?? "unknown"}`
      );
      return null;
    }
  }

  async function startSoloMatch() {
    setError(null);
    const { debug, ok } = buildDebug();
    if (!ok) {
      return;
    }
    setStarting(true);
    const matchId = await createRoomOnServer(debug);
    if (!matchId) {
      setStarting(false);
      return;
    }
    saveAutoStart(matchId);
    void navigate(`/game/${matchId}`);
  }

  async function createRoom() {
    setError(null);
    const { debug, ok } = buildDebug();
    if (!ok) {
      return;
    }
    setStarting(true);
    const matchId = await createRoomOnServer(debug);
    if (!matchId) {
      setStarting(false);
      return;
    }
    void navigate(`/game/${matchId}`);
  }

  function joinRoom() {
    setError(null);
    const id = joinId.trim();
    if (!id) {
      setError("Enter a room ID to join.");
      return;
    }
    setStarting(true);
    void navigate(`/game/${encodeURIComponent(id)}`);
  }

  function watchLive(id: string) {
    setError(null);
    setStarting(true);
    void navigate(`/spectate/${encodeURIComponent(id)}`);
  }

  function watchLiveDelayed(id: string) {
    setError(null);
    setStarting(true);
    // 5-minute delay — long enough to defeat real-time relaying
    // without making the watch unwatchable.
    void navigate(`/spectate/${encodeURIComponent(id)}?delay=${5 * 60_000}`);
  }

  function joinRoomById(id: string) {
    setError(null);
    setStarting(true);
    void navigate(`/game/${encodeURIComponent(id)}`);
  }

  return (
    <main className="pt-16 p-6 container mx-auto max-w-2xl">
      <h1 className="text-3xl font-bold mb-2">Lobby</h1>
      <p className="text-gray-600 dark:text-gray-300 mb-8">
        Let's play some mahjong!
      </p>

      <div className="flex flex-wrap gap-3 mb-6">
        <button
          type="button"
          onClick={() => {
            void startSoloMatch();
          }}
          disabled={starting}
          className="px-5 py-3 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-60 text-white font-semibold rounded-lg shadow"
        >
          {starting ? "Starting…" : "Start solo match"}
        </button>
        <button
          type="button"
          onClick={() => {
            void createRoom();
          }}
          disabled={starting}
          className="px-5 py-3 bg-sky-600 hover:bg-sky-700 disabled:opacity-60 text-white font-semibold rounded-lg shadow"
        >
          Create room
        </button>
      </div>

      <div className="flex flex-wrap items-end gap-3 mb-8 p-4 bg-gray-50 dark:bg-gray-800 rounded-md">
        <label className="flex-1 min-w-[240px]">
          <span className="block text-sm font-medium text-gray-700 dark:text-gray-200 mb-1">
            Join an existing room
          </span>
          <input
            type="text"
            value={joinId}
            onChange={(e) => {
              setJoinId(e.target.value);
            }}
            placeholder="room ID (e.g. AbCdEf123456)"
            className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 rounded-md font-mono text-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
          />
        </label>
        <button
          type="button"
          onClick={joinRoom}
          disabled={starting}
          className="px-5 py-3 bg-slate-700 hover:bg-slate-800 disabled:opacity-60 text-white font-semibold rounded-lg shadow"
        >
          Join
        </button>
      </div>

      <div className="mb-8 p-4 bg-gray-50 dark:bg-gray-800 rounded-md">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-medium text-gray-700 dark:text-gray-200">
            Live games
          </h2>
          <button
            type="button"
            onClick={() => {
              void refreshRooms();
            }}
            disabled={roomsLoading}
            className="px-3 py-1.5 text-sm bg-slate-200 hover:bg-slate-300 dark:bg-slate-700 dark:hover:bg-slate-600 disabled:opacity-60 text-gray-800 dark:text-gray-100 rounded-md"
          >
            {roomsLoading ? "Refreshing…" : "Refresh"}
          </button>
        </div>
        {roomsError && (
          <p className="text-sm text-red-600 dark:text-red-400 mb-2">
            {roomsError}
          </p>
        )}
        {rooms !== null && rooms.length === 0 && !roomsError && (
          <p className="text-sm text-gray-500 dark:text-gray-400">
            No live games right now.
          </p>
        )}
        {rooms !== null && rooms.length > 0 && (
          <ul className="divide-y divide-gray-200 dark:divide-gray-700">
            {rooms.map((r) => {
              const seatLabels = r.seats.map((s, i) => {
                if (s === null) {
                  return `[${i + 1}] empty`;
                }
                const tag = s.isBot ? " (bot)" : "";
                return `[${i + 1}] ${s.name || "?"}${tag}`;
              });
              return (
                <li
                  key={r.matchId}
                  className="py-3 flex flex-wrap items-center gap-3"
                >
                  <div className="flex-1 min-w-[240px]">
                    <div className="flex items-center gap-2">
                      <span
                        className={`inline-block px-2 py-0.5 text-xs font-semibold rounded ${
                          r.status === "playing"
                            ? "bg-emerald-200 text-emerald-900 dark:bg-emerald-700 dark:text-emerald-50"
                            : "bg-amber-200 text-amber-900 dark:bg-amber-700 dark:text-amber-50"
                        }`}
                      >
                        {r.status === "playing" ? "playing" : "waiting"}
                      </span>
                      <span className="font-mono text-sm text-gray-800 dark:text-gray-100">
                        {r.matchId}
                      </span>
                      <span className="text-xs text-gray-500 dark:text-gray-400">
                        {r.buuMode ? "buu-east" : "tenhou"}
                      </span>
                    </div>
                    <div className="text-xs text-gray-600 dark:text-gray-300 mt-1">
                      {seatLabels.join(" · ")}
                    </div>
                  </div>
                  <div className="flex gap-2">
                    {r.status === "playing" ? (
                      <>
                        <button
                          type="button"
                          onClick={() => {
                            watchLive(r.matchId);
                          }}
                          disabled={starting}
                          className="px-4 py-2 text-sm bg-purple-600 hover:bg-purple-700 disabled:opacity-60 text-white font-semibold rounded-md"
                        >
                          Watch live
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            watchLiveDelayed(r.matchId);
                          }}
                          disabled={starting}
                          className="px-4 py-2 text-sm bg-amber-600 hover:bg-amber-700 disabled:opacity-60 text-white font-semibold rounded-md"
                        >
                          5min delay
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        onClick={() => {
                          joinRoomById(r.matchId);
                        }}
                        disabled={starting}
                        className="px-4 py-2 text-sm bg-emerald-600 hover:bg-emerald-700 disabled:opacity-60 text-white font-semibold rounded-md"
                      >
                        Join game
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {error && (
        <p className="text-red-600 dark:text-red-400 text-sm font-medium mb-4">
          {error}
        </p>
      )}

      <div className="mt-4 border-t pt-4">
        <button
          type="button"
          onClick={() => {
            setShowDebug((v) => !v);
          }}
          className="text-sm text-emerald-700 dark:text-emerald-400 hover:underline"
        >
          {showDebug ? "▾ Hide debug seed" : "▸ Debug seed (engine testing)"}
        </button>

        {showDebug && (
          <div className="mt-4 space-y-4 p-4 bg-gray-50 dark:bg-gray-800 rounded-md text-sm">
            <p className="text-gray-600 dark:text-gray-300">
              Compact mahjong notation: digits inherit the next suit letter,
              e.g. <code>123456789m1234p</code> or <code>1234s45p7z</code>.
              Suits are <code>m</code> (man), <code>p</code> (pin),{" "}
              <code>s</code> (sou); honors use <code>z</code> (1z=East,
              2z=South, 3z=West, 4z=North, 5z=White, 6z=Green, 7z=Red);{" "}
              <code>0m</code>/<code>0p</code>/<code>0s</code> are red fives.
              Whitespace- or comma-separated groups are also fine. Leave any
              field blank to keep the random default. Debug fields are only
              meaningful for solo matches (seat 0 = you, seat 3 = left bot).
            </p>

            <DebugField
              label="Your starting hand (13 tiles)"
              value={humanHand}
              setValue={setHumanHand}
              placeholder={PLACEHOLDER_HAND}
            />
            <DebugField
              label="Your next draws (in order)"
              value={humanDraws}
              setValue={setHumanDraws}
              placeholder={PLACEHOLDER_DRAWS}
            />
            <DebugField
              label="Left bot's next discards (seat 3, in order)"
              value={leftDiscards}
              setValue={setLeftDiscards}
              placeholder={PLACEHOLDER_LEFT}
            />
          </div>
        )}
      </div>
    </main>
  );
}

interface DebugFieldProps {
  label: string;
  value: string;
  setValue: (v: string) => void;
  placeholder: string;
}

function DebugField({ label, value, setValue, placeholder }: DebugFieldProps) {
  return (
    <label className="block">
      <span className="block text-gray-700 dark:text-gray-200 font-medium mb-1">
        {label}
      </span>
      <textarea
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
        }}
        placeholder={placeholder}
        rows={1}
        className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 rounded-md font-mono text-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
      />
    </label>
  );
}
