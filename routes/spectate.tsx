import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { requireGameEnabled, getClientGameFlag } from "~/game/feature-gate";
import type { TableRenderer } from "~/game/client/pixi/TableRenderer";
import { useMatchStore } from "~/game/client/store";
import { GameWS } from "~/game/client/ws";
import {
  applyReplayEvent,
  initialView,
  replayViewToMatchView,
  type ReplayView,
} from "~/game/replay/player";
import { playSoundForEvent } from "~/game/client/sound";
import type {
  GameEvent,
  RoomState,
  Seat,
  ServerMessage,
  SnapshotState,
} from "~/game/protocol/messages";
import {
  ReplayOverlayPanel,
  defaultReplayOverlayState,
  type ReplayOverlayState,
} from "./ReplayOverlayPanel";
import type { Route } from "./+types/spectate";

/**
 * `/spectate/:matchId` — read-only spectator view of an in-progress
 * match.
 *
 * Phase 4 (unified viewer): spectators see the same UI as the replay
 * viewer — a left-edge overlay panel (hide/show waits/hands/walls/
 * names) and a right-edge nav column (focus seat, round picker,
 * prev/next event, prev/next round, "Go live"). Stepping back via
 * any nav control pauses the playhead; the WebSocket keeps buffering
 * incoming events so "Go live" can snap forward to the latest one.
 *
 * Implementation: we ignore the live `useMatchStore` render path and
 * instead maintain a local `ReplayView` baseline (synthesized from
 * the first `snapshot` message) plus an append-only `GameEvent[]`
 * buffer. The displayed view at `playIndex` is computed by folding
 * `applyReplayEvent` from the baseline forward. When `live === true`
 * `playIndex` auto-tracks `events.length - 1`.
 *
 * Gated server-side by `requireGameEnabled()`.
 */
export async function loader({ params }: Route.LoaderArgs) {
  requireGameEnabled();
  return {
    matchId: params.matchId,
    flag: getClientGameFlag(),
  };
}

/**
 * Synthesize a `ReplayView` from a snapshot. The snapshot is the
 * spectator's omniscient view at attach time; everything except the
 * archival-only fields (`liveWall`/`deadWall`/`liveDrawSchedule`/
 * `lastHandResult`/`matchEnded`) maps directly. Those four default
 * to "unknown" — overlays that depend on them (e.g. wall reveal)
 * just won't have data until the next `hand_start` event arrives
 * with a fresh omniscient wall.
 */
function snapshotToReplayView(s: SnapshotState): ReplayView {
  const base = initialView();
  return {
    ...base,
    hands: s.hands.map((h) => [...h]),
    melds: s.melds.map((m) => [...m]),
    discards: s.discards.map((d) => [...d]),
    // Snapshots don't carry per-discard tsumogiri / ordinal info
    // (the fresh-tsumogiri darken effect is a transient cue, not
    // worth replicating on reconnect/attach). Initialize parallel
    // arrays so the renderer's per-tile lookups stay in bounds.
    discardTsumogiri: s.discards.map((d) => d.map(() => false)),
    discardOrdinals: s.discards.map((d) => d.map((_, i) => i)),
    totalDiscards: s.discards.reduce((acc, d) => acc + d.length, 0),
    wallRemaining: s.wallRemaining,
    drawsTaken: s.drawsTaken ?? 70 - s.wallRemaining,
    // Mid-hand wall reveal: the server attaches the starting live
    // wall plus the number of live-wall draws taken to spectator
    // snapshots, so the renderer's `showWalls` overlay can work
    // without waiting for the next `hand_start`.
    liveWall: s.liveWall ? [...s.liveWall] : null,
    liveDrawsTaken: s.liveDrawsTaken ?? 0,
    doraIndicators: [...s.doraIndicators],
    scores: [s.scores[0], s.scores[1], s.scores[2], s.scores[3]],
    dealer: s.dealer,
    roundWind: s.roundWind,
    roundNumber: s.roundNumber,
    honba: s.honba,
    riichiSticks: s.riichiSticks,
    riichiDeclared: [
      s.riichiDeclared[0],
      s.riichiDeclared[1],
      s.riichiDeclared[2],
      s.riichiDeclared[3],
    ],
    riichiTileIdx: s.riichiTileIdx
      ? [
          s.riichiTileIdx[0],
          s.riichiTileIdx[1],
          s.riichiTileIdx[2],
          s.riichiTileIdx[3],
        ]
      : [null, null, null, null],
    dice: s.dice ?? null,
    furiten: s.furiten
      ? [s.furiten[0], s.furiten[1], s.furiten[2], s.furiten[3]]
      : [false, false, false, false],
    // Buu Mahjong overlays. The server only emits `chips` /
    // `dabuken` on Buu snapshots, so their presence is also our
    // signal for `buuMode` — without this a mid-match spectator
    // attach would render the table as if the rule set were
    // tenhou-default (no chip row, no dabuken token, no sinking
    // tint).
    sinking: s.sinking
      ? [s.sinking[0], s.sinking[1], s.sinking[2], s.sinking[3]]
      : [false, false, false, false],
    chips: s.chips
      ? [s.chips[0], s.chips[1], s.chips[2], s.chips[3]]
      : [0, 0, 0, 0],
    dabuken: s.dabuken
      ? [s.dabuken[0], s.dabuken[1], s.dabuken[2], s.dabuken[3]]
      : [false, false, false, false],
    buuMode: s.chips !== undefined,
    scoreCap: s.scoreCap ?? null,
  };
}

export default function GameSpectateRoute({
  loaderData,
}: Route.ComponentProps) {
  const { matchId } = loaderData;
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  // `?delay=<ms>` — non-negative integer. Defaults to 0 (live).
  // The server caps this at 30 min.
  const delayMs = Math.max(0, Number(searchParams.get("delay") ?? 0)) | 0;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const rendererRef = useRef<TableRenderer | null>(null);
  const wsRef = useRef<GameWS | null>(null);
  // Latest render args, snapshotted on every dispatch into the
  // renderer. Read back by the renderer's `onRenderRequest`
  // callback so animation-frame re-renders (discard slide,
  // hand-sort tween, etc.) replay against the freshest view
  // even when no React state change has fired since the last
  // dispatch — without this hook the discard tile parks at
  // its phase-A start position (next to the discarder's hand)
  // during call-window pauses, instead of sliding to the
  // +10/+10 nudged position in the pond.
  const latestRenderRef = useRef<ReturnType<
    typeof replayViewToMatchView
  > | null>(null);

  // ---- Local replay-style state -----------------------------------------
  const [baseline, setBaseline] = useState<ReplayView | null>(null);
  const [events, setEvents] = useState<GameEvent[]>([]);
  // `-1` = baseline (snapshot view). `>= 0` = state after applying
  // events[0..playIndex] over the baseline.
  const [playIndex, setPlayIndex] = useState<number>(-1);
  const [live, setLive] = useState<boolean>(true);
  const [focusSeat, setFocusSeat] = useState<Seat>(0);
  const [overlays, setOverlays] = useState<ReplayOverlayState>(
    defaultReplayOverlayState
  );
  const [seatNames, setSeatNames] = useState<[string, string, string, string]>([
    "",
    "",
    "",
    "",
  ]);
  const [roomState, setRoomState] = useState<RoomState | null>(null);
  const [conn, setConn] = useState<string>("idle");

  // Refs for stale-closure-safe access inside the WS callback.
  const liveRef = useRef<boolean>(live);
  useEffect(() => {
    liveRef.current = live;
  }, [live]);

  // -----------------------------------------------------------------------
  // Mount: Pixi renderer + WS
  // -----------------------------------------------------------------------
  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    let cancelled = false;

    useMatchStore.getState().setMatch(matchId, null);
    // NOTE: we deliberately do not call `installGameSoundBindings()`
    // here. That helper plays SFX off the live store's apply-event
    // bus, which would mean a spectator browsing past events (live
    // off) still hears the live action arriving over the WS. Sound
    // is driven from the local `playIndex` instead — see the
    // dedicated effect below — so cues track the event the user is
    // actually watching, both in live mode (playhead auto-advances)
    // and while stepping through history (silent on backward seeks).

    void import("~/game/client/pixi/TableRenderer").then(
      ({ TableRenderer }) => {
        if (cancelled) {
          return;
        }
        const renderer = new TableRenderer();
        renderer.setOnRenderRequest(() => {
          const r = rendererRef.current;
          const args = latestRenderRef.current;
          if (r && args) {
            r.render(args);
          }
        });
        void renderer.mount(container).then(() => {
          if (cancelled) {
            renderer.destroy();
            return;
          }
          rendererRef.current = renderer;
        });
      }
    );

    void (async () => {
      try {
        const basePath = (import.meta.env.BASE_URL || "/").replace(/\/$/, "");
        const res = await fetch(`${basePath}/api/game/session`, {
          credentials: "include",
        });
        if (!res.ok) {
          return;
        }
        const session = (await res.json()) as {
          token: string;
          wsUrl: string | null;
          wsPath: string;
        };
        if (cancelled) {
          return;
        }
        const wsScheme = window.location.protocol === "https:" ? "wss:" : "ws:";
        const origin =
          session.wsUrl ?? `${wsScheme}//${window.location.host}${basePath}`;
        const fullUrl = `${origin}${session.wsPath}/${encodeURIComponent(matchId)}`;
        const ws = new GameWS({
          wsUrl: fullUrl,
          token: session.token,
          matchId,
          spectate: true,
          ...(delayMs > 0 ? { delayMs } : {}),
          onMessage: (msg: ServerMessage) => {
            if (msg.type === "snapshot") {
              setBaseline(snapshotToReplayView(msg.state));
              setEvents([]);
              setPlayIndex(-1);
              setLive(true);
              return;
            }
            if (msg.type === "event") {
              setEvents((prev) => {
                const next = [...prev, ...msg.events];
                if (liveRef.current) {
                  // Snap playhead to the last event in the new buffer.
                  // Use a setTimeout-free direct call: `setPlayIndex`
                  // is safe inside an updater because React batches
                  // both updates in the same tick.
                  setPlayIndex(next.length - 1);
                }
                return next;
              });
              return;
            }
            if (msg.type === "room_state") {
              const names: [string, string, string, string] = ["", "", "", ""];
              for (const s of msg.seats) {
                const occ = s.occupant;
                if (occ.kind !== "empty") {
                  names[s.seat] = occ.displayName;
                }
              }
              setSeatNames(names);
              // Capture the full room state so the renderer can
              // surface the per-seat `connected` flag (used to
              // paint the "disconnected" badge on nameplates).
              setRoomState(msg);
            }
          },
        });
        wsRef.current = ws;
        ws.connect();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("[game] spectator session fetch failed", err);
      }
    })();

    // Mirror useMatchStore.conn into local state so the banner can
    // display it without re-rendering the canvas on every store
    // mutation (the store still receives dispatches, but we don't
    // render from it).
    const unsub = useMatchStore.subscribe((state) => {
      setConn(state.conn);
    });

    return () => {
      cancelled = true;
      unsub();
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
      if (rendererRef.current) {
        rendererRef.current.destroy();
        rendererRef.current = null;
      }
      useMatchStore.getState().reset();
    };
    // matchId is loader-stable for a single visit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // -----------------------------------------------------------------------
  // Derived view + renderer dispatch
  // -----------------------------------------------------------------------
  const view = useMemo<ReplayView | null>(() => {
    if (!baseline) {
      return null;
    }
    let v = baseline;
    const upTo = Math.min(playIndex, events.length - 1);
    for (let i = 0; i <= upTo; i++) {
      v = applyReplayEvent(v, events[i]);
    }
    return v;
  }, [baseline, events, playIndex]);

  // Round-boundary indices within `events` (each `hand_start`).
  const rounds = useMemo<number[]>(() => {
    const out: number[] = [];
    for (let i = 0; i < events.length; i++) {
      if (events[i].type === "hand_start") {
        out.push(i);
      }
    }
    return out;
  }, [events]);

  // Sound cue dispatch — driven off the local `playIndex` rather
  // than the live store's event bus (see the mount effect for the
  // rationale). Forward steps emit one cue per newly-revealed
  // event; backward seeks and snapshot resets advance the cursor
  // silently. Mirrors the live player's per-event soundscape
  // when `live === true` (playhead auto-tracks new arrivals).
  const lastPlayedSoundIndexRef = useRef<number>(-1);
  useEffect(() => {
    const from = lastPlayedSoundIndexRef.current;
    lastPlayedSoundIndexRef.current = playIndex;
    if (playIndex <= from) {
      return;
    }
    for (let i = from + 1; i <= playIndex && i < events.length; i++) {
      try {
        playSoundForEvent(events[i], null);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("[game] spectator sound dispatch threw", err);
      }
    }
  }, [playIndex, events]);

  useEffect(() => {
    const r = rendererRef.current;
    if (!r || !view) {
      return;
    }
    r.setShowLayoutDebug(overlays.showLayoutDebug);
    r.setShowWaits(overlays.showWaits);
    r.setShowHands(overlays.showHands);
    r.setShowWalls(overlays.showWalls);
    r.setShowNames(overlays.showNames);
    const args = replayViewToMatchView(view, {
      index: playIndex,
      mySeat: focusSeat,
      matchId,
      seatNames,
      roomState,
    });
    latestRenderRef.current = args;
    r.render(args);
  }, [view, playIndex, focusSeat, overlays, matchId, seatNames, roomState]);

  // -----------------------------------------------------------------------
  // Navigation helpers
  // -----------------------------------------------------------------------
  const minIndex = -1;
  const maxIndex = events.length - 1;
  const clamp = (n: number): number =>
    Math.max(minIndex, Math.min(n, maxIndex));
  /** Step to absolute event index `n`. Always pauses live mode. */
  const goto = (n: number): void => {
    setLive(false);
    setPlayIndex(clamp(n));
  };
  const goLive = (): void => {
    setLive(true);
    setPlayIndex(maxIndex);
  };
  const isLive = live && playIndex === maxIndex;

  // Find current round's index in `rounds` (largest boundary <= playIndex).
  let currentRoundIdx = -1;
  for (let i = 0; i < rounds.length; i++) {
    if (rounds[i] <= playIndex) {
      currentRoundIdx = i;
    }
  }
  const prevRound = currentRoundIdx > 0 ? rounds[currentRoundIdx - 1] : null;
  const nextRound =
    currentRoundIdx >= 0 && currentRoundIdx < rounds.length - 1
      ? rounds[currentRoundIdx + 1]
      : null;

  // -----------------------------------------------------------------------
  // Mouse-wheel + click scrubbing on the canvas — mirrors replay.tsx.
  //
  // Wheel: snap to the next/previous `discard` or `hand_end` event per
  // tick (one visible turn change per notch). Down = forward, up = back.
  //
  // Click: left → +1 event, right → −1 event. `contextmenu` is
  // suppressed so right-clicks don't pop the browser menu. Clicks that
  // land on overlay HUD controls (buttons / selects / etc.) fall
  // through untouched.
  //
  // Stepping backward pauses live mode; stepping forward while live
  // stays live (the auto-advance effect re-pins `playIndex` to the
  // last buffered event on each new arrival).
  // -----------------------------------------------------------------------
  const wheelAccumRef = useRef(0);
  const wheelLastRef = useRef(0);
  // Stale-closure refs for the listeners — rebinding the listeners on
  // every state change would be wasteful and miss in-flight wheel
  // accumulation.
  const eventsRef = useRef<GameEvent[]>(events);
  const playIndexRef = useRef<number>(playIndex);
  const liveStepRef = useRef<boolean>(live);
  useEffect(() => {
    eventsRef.current = events;
  }, [events]);
  useEffect(() => {
    playIndexRef.current = playIndex;
  }, [playIndex]);
  useEffect(() => {
    liveStepRef.current = live;
  }, [live]);

  /**
   * Step the playhead by `delta` discrete events. Pauses live mode
   * when stepping backward; stepping forward while live is a no-op
   * (live mode already auto-advances).
   */
  const stepBy = (delta: number): void => {
    if (delta > 0 && liveStepRef.current) {
      return;
    }
    const max = eventsRef.current.length - 1;
    const next = Math.max(-1, Math.min(playIndexRef.current + delta, max));
    if (delta < 0) {
      setLive(false);
    }
    setPlayIndex(next);
  };

  /**
   * Jump to the next/previous `discard` or `hand_end` event from the
   * current playhead. Used by the wheel handler to step one visible
   * turn per notch.
   */
  const stepToStop = (dir: 1 | -1): void => {
    const buf = eventsRef.current;
    const max = buf.length - 1;
    const isStop = (i: number): boolean => {
      const t = buf[i]?.type;
      return t === "discard" || t === "hand_end";
    };
    let target = playIndexRef.current;
    if (dir > 0) {
      if (liveStepRef.current) {
        return;
      }
      target = max;
      for (let j = playIndexRef.current + 1; j <= max; j++) {
        if (isStop(j)) {
          target = j;
          break;
        }
      }
    } else {
      target = -1;
      for (let j = playIndexRef.current - 1; j >= -1; j--) {
        if (isStop(j)) {
          target = j;
          break;
        }
      }
      setLive(false);
    }
    setPlayIndex(target);
  };

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      const now = Date.now();
      if (now - wheelLastRef.current > 200) {
        wheelAccumRef.current = 0;
      }
      wheelLastRef.current = now;
      wheelAccumRef.current += e.deltaY;
      const threshold = 30;
      if (wheelAccumRef.current >= threshold) {
        wheelAccumRef.current = 0;
        stepToStop(1);
      } else if (wheelAccumRef.current <= -threshold) {
        wheelAccumRef.current = 0;
        stepToStop(-1);
      }
    };
    const isInteractiveTarget = (target: EventTarget | null): boolean => {
      if (!(target instanceof Element)) {
        return false;
      }
      return (
        target.closest("button, input, label, select, a, [role=button]") !==
        null
      );
    };
    const onMouseDown = (e: MouseEvent): void => {
      if (e.button !== 0 && e.button !== 2) {
        return;
      }
      if (isInteractiveTarget(e.target)) {
        return;
      }
      e.preventDefault();
      stepBy(e.button === 0 ? 1 : -1);
    };
    const onContextMenu = (e: MouseEvent): void => {
      if (isInteractiveTarget(e.target)) {
        return;
      }
      e.preventDefault();
    };
    container.addEventListener("wheel", onWheel, { passive: false });
    container.addEventListener("mousedown", onMouseDown);
    container.addEventListener("contextmenu", onContextMenu);
    return () => {
      container.removeEventListener("wheel", onWheel);
      container.removeEventListener("mousedown", onMouseDown);
      container.removeEventListener("contextmenu", onContextMenu);
    };
    // Handlers read from refs; no deps needed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <main className="fixed inset-0 bg-black">
      {/* Top-left status banner */}
      <div className="absolute top-2 left-2 z-30 flex items-center gap-2 px-3 py-1 rounded-md bg-black/60 text-white text-sm font-mono">
        <span
          className={`inline-block w-2 h-2 rounded-full ${
            isLive
              ? delayMs > 0
                ? "bg-amber-400"
                : "bg-red-500"
              : "bg-slate-400"
          }`}
        />
        <span>
          {isLive
            ? delayMs > 0
              ? `Live (${Math.round(delayMs / 60_000)}min delay)`
              : "Live"
            : "Paused"}
        </span>
        <span className="opacity-60">·</span>
        <span className="opacity-75 truncate max-w-[200px]">{matchId}</span>
        <button
          type="button"
          onClick={() => {
            void navigate("/lobby");
          }}
          className="ml-2 px-2 py-0.5 rounded bg-white/10 hover:bg-white/20 text-xs"
        >
          Leave
        </button>
        <span className="ml-2 opacity-50 text-xs">{conn}</span>
      </div>

      {/* Right-side: seat / round selectors + nav buttons. */}
      <div className="absolute top-1/2 right-2 -translate-y-1/2 z-30 flex flex-col items-stretch gap-3 text-emerald-100 text-base">
        {/* Row 1: seat selection, then round selection. */}
        <div className="flex items-center gap-2">
          <select
            aria-label="Focus seat"
            value={String(focusSeat)}
            onChange={(e) => {
              setFocusSeat(Number(e.target.value) as Seat);
            }}
            className="bg-black/60 border border-emerald-700 rounded px-3 py-2 text-base text-emerald-100"
          >
            {([0, 1, 2, 3] as const).map((s) => {
              const name = seatNames[s] || `Seat ${s}`;
              return (
                <option key={s} value={String(s)}>
                  {name}
                </option>
              );
            })}
          </select>
          {rounds.length > 0 && (
            <select
              aria-label="Round"
              value={(() => {
                let pick = -1;
                for (const r of rounds) {
                  if (r <= playIndex) {
                    pick = r;
                  }
                }
                return pick === -1 ? "" : String(pick);
              })()}
              onChange={(e) => {
                const v = e.target.value;
                if (v === "") {
                  return;
                }
                goto(Number(v));
              }}
              className="bg-black/60 border border-emerald-700 rounded px-3 py-2 text-base text-emerald-100"
            >
              {rounds.map((r) => {
                const ev = events[r];
                if (ev.type !== "hand_start") {
                  return null;
                }
                const label = `${ev.roundWind}${ev.roundNumber}`;
                return (
                  <option key={r} value={String(r)}>
                    {label}
                  </option>
                );
              })}
            </select>
          )}
        </div>
        {/* Row 2: prev round, prev event, next event, next round. */}
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => {
              if (prevRound !== null) {
                goto(prevRound);
              }
            }}
            disabled={prevRound === null}
            className="px-3 py-2 text-lg rounded bg-black/60 hover:bg-emerald-800 disabled:opacity-40 border border-emerald-700 text-emerald-100"
            aria-label="Previous round"
            title="Previous round"
          >
            ⏮
          </button>
          <button
            type="button"
            onClick={() => {
              goto(playIndex - 1);
            }}
            disabled={playIndex <= minIndex}
            className="px-3 py-2 text-lg rounded bg-black/60 hover:bg-emerald-800 disabled:opacity-40 border border-emerald-700 text-emerald-100"
            aria-label="Previous event"
            title="Previous event"
          >
            ◀
          </button>
          <button
            type="button"
            onClick={() => {
              goto(playIndex + 1);
            }}
            disabled={playIndex >= maxIndex}
            className="px-3 py-2 text-lg rounded bg-black/60 hover:bg-emerald-800 disabled:opacity-40 border border-emerald-700 text-emerald-100"
            aria-label="Next event"
            title="Next event"
          >
            ▶
          </button>
          <button
            type="button"
            onClick={() => {
              if (nextRound !== null) {
                goto(nextRound);
              }
            }}
            disabled={nextRound === null}
            className="px-3 py-2 text-lg rounded bg-black/60 hover:bg-emerald-800 disabled:opacity-40 border border-emerald-700 text-emerald-100"
            aria-label="Next round"
            title="Next round"
          >
            ⏭
          </button>
        </div>
        {/* Row 3: Go-live shortcut. Hidden when already live + at
            the buffer head; shown otherwise so the viewer can snap
            forward without manually stepping through. */}
        {!isLive && (
          <button
            type="button"
            onClick={goLive}
            className="px-3 py-2 text-base rounded bg-red-700 hover:bg-red-600 border border-red-900 text-white font-semibold flex items-center justify-center gap-2"
            aria-label="Go live"
            title="Jump to latest event and resume live updates"
          >
            <span className="inline-block w-2 h-2 rounded-full bg-white animate-pulse" />
            Go live
          </button>
        )}
        <span className="font-mono text-sm text-emerald-100/80 text-center">
          {playIndex + 1} / {events.length}
        </span>
      </div>

      <ReplayOverlayPanel overlays={overlays} onChange={setOverlays} />

      <div ref={containerRef} className="w-full h-full" />
    </main>
  );
}
