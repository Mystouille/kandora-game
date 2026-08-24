import { useEffect, useMemo, useRef, useState } from "react";
import { EyeOutlined } from "@ant-design/icons";
import {
  useNavigate,
  useSearchParams,
  type LoaderFunctionArgs,
} from "react-router";
import { requireGameEnabled, getClientGameFlag } from "~/game/feature-gate";
import type {
  TableRenderer,
  SeatEnrichment,
} from "~/game/client/pixi/TableRenderer";
import { useMatchStore } from "~/game/client/store";
import {
  GameWS,
  GameWSConnectionDetailsError,
} from "~/game/client/ws";
import { mergeSeatNames } from "~/game/client/spectatorNames";
import {
  ViewerList,
  ViewerListToggle,
} from "~/game/components/ViewerList";
import { POST_HAND_PEEK_DISCARD_LIMIT } from "~/game/client/postHandPeek";
import {
  replayArrivalSoundTarget,
  replaySoundTarget,
} from "~/game/client/replaySound";
import {
  applyReplayEvent,
  initialView,
  replayViewToMatchView,
  rotateHandResult,
  type ReplayView,
} from "~/game/replay/player";
import { waitsForReplayView } from "~/game/replay/waits";
import { playSoundForEvent, playGameSound } from "~/game/client/sound";
import type {
  GameEvent,
  RoomState,
  Seat,
  ServerMessage,
  SnapshotState,
  ViewerPresence,
} from "~/game/protocol/messages";
import {
  ReplayOverlayPanel,
  defaultReplayOverlayState,
  type ReplayOverlayState,
} from "~/game/routes/ReplayOverlayPanel";

/**
 * Extract seat display names from the first `match_start` in an
 * event stream. Relay feeds (e.g. live Tenhou public games) have no
 * authoritative `room_state`, so the player names ride on this
 * event alone — the spectator view falls back to them for any seat
 * a richer source (room_state / host enrichment) hasn't filled.
 */
function seatNamesFromEvents(
  events: GameEvent[]
): [string, string, string, string] | null {
  const start = events.find((e) => e.type === "match_start");
  if (!start || start.type !== "match_start") {
    return null;
  }
  const names: [string, string, string, string] = ["", "", "", ""];
  for (const s of start.seats) {
    if (s.seat >= 0 && s.seat < 4) {
      names[s.seat] = s.displayName;
    }
  }
  return names;
}

/**
 * Shared read-only spectator view for an in-progress match. The host route
 * supplies the game-server match id through loader data.
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
export async function loader({ params }: LoaderFunctionArgs) {
  requireGameEnabled();
  const matchId = params.matchId;
  if (!matchId) {
    throw new Response("Missing match id.", { status: 404 });
  }
  return {
    matchId,
    flag: getClientGameFlag(),
  };
}

interface GameSpectateRouteProps {
  loaderData: Awaited<ReturnType<typeof loader>>;
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
    discardSources: s.discards.map((d) => d.map(() => null)),
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

/**
 * Fire-and-forget spectator telemetry to the host app's `/api/telemetry`
 * convention endpoint (same pattern as the session / enrichment fetches). Kept
 * dependency-free so the shared viewer stays decoupled from any host app.
 */
function beaconTelemetry(event: string, meta: Record<string, unknown>): void {
  try {
    const bp = (import.meta.env.BASE_URL || "/").replace(/\/$/, "");
    const body = JSON.stringify({
      events: [
        {
          type: "client",
          event,
          path: window.location.pathname,
          meta,
          ts: Date.now(),
        },
      ],
    });
    const blob = new Blob([body], { type: "application/json" });
    if (navigator.sendBeacon) {
      navigator.sendBeacon(`${bp}/api/telemetry`, blob);
    } else {
      void fetch(`${bp}/api/telemetry`, {
        method: "POST",
        body: blob,
        keepalive: true,
      }).catch(() => undefined);
    }
  } catch {
    // Telemetry is best-effort.
  }
}

export default function GameSpectateRoute({
  loaderData,
}: GameSpectateRouteProps) {
  const { matchId } = loaderData;
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const requestedReturnPath = searchParams.get("returnTo");
  const returnPath =
    requestedReturnPath === "/" ||
    requestedReturnPath?.startsWith("/online-tournaments/") === true
      ? requestedReturnPath
      : "/";
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
  const pendingSoundIndexRef = useRef<number | null>(null);
  const [live, setLive] = useState<boolean>(true);
  const [focusSeat, setFocusSeat] = useState<Seat>(0);
  const [eyeHeld, setEyeHeld] = useState(false);
  const [pondCenter, setPondCenter] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const [overlays, setOverlays] = useState<ReplayOverlayState>(
    defaultReplayOverlayState
  );
  const [seatNames, setSeatNames] = useState<[string, string, string, string]>([
    "",
    "",
    "",
    "",
  ]);
  const [seatEnrichment, setSeatEnrichment] = useState<
    [
      SeatEnrichment | null,
      SeatEnrichment | null,
      SeatEnrichment | null,
      SeatEnrichment | null,
    ]
  >([null, null, null, null]);
  const [roomState, setRoomState] = useState<RoomState | null>(null);
  const [conn, setConn] = useState<string>("idle");
  const [viewers, setViewers] = useState<ViewerPresence[]>([]);
  const [showViewerList, setShowViewerList] = useState(true);
  const lastRelaySeqRef = useRef(-1);

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
    const spectateOpenedAt = Date.now();
    beaconTelemetry("spectate_open", { matchId });

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
        // Show the full wall (face-down): the relay carries no tile
        // faces, but the draw count is tracked so the wall shrinks
        // correctly. `showWalls` (off here) is what reveals faces.
        renderer.setLiveSpectate(false);
        // Relay feeds deliver the next draw ~0ms after the previous
        // discard, so space them onto the animator's serial timeline
        // (discard slides + hovers, then the draw slides in as it
        // settles). The discard/draw SFX are retimed to the slide
        // landings here, so the per-event sound loop below skips them.
        renderer.setDrawSequencing(true, {
          onDiscardLand: (_seat, isRiichiDeclaration) =>
            playGameSound(isRiichiDeclaration ? "riichi" : "discard"),
          onDrawLand: () => playGameSound("draw"),
        });
        renderer.setOnRenderRequest(() => {
          const r = rendererRef.current;
          const args = latestRenderRef.current;
          if (r && args) {
            r.render(args);
          }
        });
        renderer.setPondCenterListener((point) => {
          setPondCenter(point);
        });
        void renderer.mount(container).then(() => {
          if (cancelled) {
            renderer.destroy();
            return;
          }
          rendererRef.current = renderer;
          // Host-app team enrichment for the nameplates (best-effort;
          // a 404 / empty response just leaves nameplates un-enriched).
          const bp = (import.meta.env.BASE_URL || "/").replace(/\/$/, "");
          void fetch(
            `${bp}/api/game/enrichment?matchId=${encodeURIComponent(matchId)}`,
            { credentials: "include" }
          )
            .then((res) => (res.ok ? res.json() : null))
            .then(
              (
                data: {
                  seats?: Array<{
                    seat: number;
                    playerName?: string | null;
                    teamName?: string | null;
                    teamLogoUrl?: string | null;
                  }>;
                } | null
              ) => {
                if (cancelled || !data || !Array.isArray(data.seats)) {
                  return;
                }
                const bySeat: (SeatEnrichment | null)[] = [
                  null,
                  null,
                  null,
                  null,
                ];
                const names: [string, string, string, string] = [
                  "",
                  "",
                  "",
                  "",
                ];
                for (const s of data.seats) {
                  if (s.seat >= 0 && s.seat < 4) {
                    names[s.seat] = s.playerName ?? "";
                    bySeat[s.seat] = {
                      teamName: s.teamName ?? null,
                      teamLogoUrl: s.teamLogoUrl ?? null,
                    };
                  }
                }
                setSeatNames((current) => mergeSeatNames(current, names));
                setSeatEnrichment([bySeat[0], bySeat[1], bySeat[2], bySeat[3]]);
              }
            )
            .catch(() => {
              // Enrichment is optional; ignore failures.
            });
        });
      }
    );

    const ws = new GameWS({
      getConnectionDetails: async () => {
        const basePath = (import.meta.env.BASE_URL || "/").replace(/\/$/, "");
        const res = await fetch(`${basePath}/api/game/session`, {
          credentials: "include",
        });
        if (res.status === 401 || res.status === 403) {
          window.location.reload();
          throw new GameWSConnectionDetailsError(
            "Live-game access requires authorization.",
            false
          );
        }
        if (!res.ok) {
          throw new GameWSConnectionDetailsError(
            `Session refresh failed (${res.status}).`,
            true
          );
        }
        const session = (await res.json()) as {
          token: string;
          wsUrl: string | null;
          wsPath: string;
        };
        const wsScheme = window.location.protocol === "https:" ? "wss:" : "ws:";
        const origin =
          session.wsUrl ?? `${wsScheme}//${window.location.host}${basePath}`;
        const fullUrl = `${origin}${session.wsPath}/${encodeURIComponent(matchId)}`;
        return { wsUrl: fullUrl, token: session.token };
      },
      matchId,
      spectate: true,
      ...(delayMs > 0 ? { delayMs } : {}),
      onMessage: (msg: ServerMessage) => {
            if (msg.type === "viewer_state") {
              setViewers(msg.viewers);
              return;
            }
            if (msg.type === "snapshot") {
              pendingSoundIndexRef.current = null;
              lastRelaySeqRef.current = msg.seq;
              if (msg.state.seatNames) {
                setSeatNames((current) =>
                  mergeSeatNames(current, msg.state.seatNames ?? [])
                );
              }
              setBaseline(snapshotToReplayView(msg.state));
              setEvents([]);
              setPlayIndex(-1);
              setLive(true);
              return;
            }
            if (msg.type === "event") {
              const startSeq = msg.seq - msg.events.length + 1;
              if (msg.seq <= lastRelaySeqRef.current) {
                return;
              }

              // Relay feeds carry player names only on `match_start`
              // (no room_state). Fill any seat not already named by a
              // more authoritative source.
              const relayNames = seatNamesFromEvents(msg.events);
              if (relayNames) {
                setSeatNames((current) =>
                  mergeSeatNames(current, relayNames)
                );
              }

              // Relay attach/reconnect sends the complete event history as a
              // seq-0 batch. It is an authoritative state baseline, not new
              // playback: animating it would rapidly replay the whole match.
              // The following resync response overlaps this batch, so the seq
              // guard above also prevents duplicate catch-up events.
              if (startSeq === 0 && msg.events.length > 1) {
                pendingSoundIndexRef.current = null;
                let hydrated = initialView();
                for (const event of msg.events) {
                  hydrated = applyReplayEvent(hydrated, event);
                }
                lastRelaySeqRef.current = msg.seq;
                setBaseline(hydrated);
                setEvents([]);
                setPlayIndex(-1);
                setLive(true);
                return;
              }

              const unseenOffset = Math.max(
                0,
                lastRelaySeqRef.current - startSeq + 1
              );
              const incoming = msg.events.slice(unseenOffset);
              if (incoming.length === 0) {
                return;
              }
              lastRelaySeqRef.current = msg.seq;
              // Relay matches have no engine snapshot. If no history batch
              // preceded this event, seed the reducer with its empty baseline.
              setBaseline((current) => current ?? initialView());
              setEvents((prev) => {
                const next = [...prev, ...incoming];
                if (liveRef.current) {
                  pendingSoundIndexRef.current =
                    replayArrivalSoundTarget(next.length, incoming.length);
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
              setSeatNames((current) => mergeSeatNames(current, names));
              // Capture the full room state so the renderer can
              // surface the per-seat `connected` flag (used to
              // paint the "disconnected" badge on nameplates).
              setRoomState(msg);
            }
      },
    });
    wsRef.current = ws;
    ws.connect();

    // Mirror useMatchStore.conn into local state so the banner can
    // display it without re-rendering the canvas on every store
    // mutation (the store still receives dispatches, but we don't
    // render from it).
    const unsub = useMatchStore.subscribe((state) => {
      setConn(state.conn);
    });

    return () => {
      cancelled = true;
      beaconTelemetry("spectate_leave", {
        matchId,
        durationMs: Date.now() - spectateOpenedAt,
      });
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
  const { view, postHandPeekResult } = useMemo<{
    view: ReplayView | null;
    postHandPeekResult: NonNullable<ReplayView["lastHandResult"]> | null;
  }>(() => {
    if (!baseline) {
      return { view: null, postHandPeekResult: null };
    }
    let v = baseline;
    let latestCompletedResult: NonNullable<
      ReplayView["lastHandResult"]
    > | null = baseline.lastHandResult;
    let focusedDiscardsAfterResult = 0;
    const upTo = Math.min(playIndex, events.length - 1);
    for (let i = 0; i <= upTo; i++) {
      const event = events[i];
      v = applyReplayEvent(v, event);
      if (v.lastHandResult) {
        latestCompletedResult = v.lastHandResult;
        focusedDiscardsAfterResult = 0;
      } else if (
        latestCompletedResult &&
        event.type === "discard" &&
        event.seat === focusSeat
      ) {
        focusedDiscardsAfterResult += 1;
      }
    }
    return {
      view: v,
      postHandPeekResult:
        !v.lastHandResult &&
        !v.matchEnded &&
        focusedDiscardsAfterResult < POST_HAND_PEEK_DISCARD_LIMIT
          ? latestCompletedResult
          : null,
    };
  }, [baseline, events, playIndex, focusSeat]);
  const renderedPostHandPeekResult = useMemo(
    () =>
      postHandPeekResult && focusSeat !== 0
        ? rotateHandResult(postHandPeekResult, focusSeat)
        : postHandPeekResult,
    [postHandPeekResult, focusSeat]
  );
  const currentWaits = useMemo(
    () => (view && overlays.showWaits ? waitsForReplayView(view) : null),
    [view, overlays.showWaits]
  );

  useEffect(() => {
    if (!eyeHeld) {
      return;
    }
    const release = (): void => {
      setEyeHeld(false);
    };
    window.addEventListener("pointerup", release);
    window.addEventListener("pointercancel", release);
    return () => {
      window.removeEventListener("pointerup", release);
      window.removeEventListener("pointercancel", release);
    };
  }, [eyeHeld]);

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

  // Sound is armed explicitly by one live arrival or one forward
  // event step. Round/wheel/go-live/catch-up jumps never iterate the
  // skipped range, so they cannot replay a burst of historical cues.
  useEffect(() => {
    const shouldPlay = pendingSoundIndexRef.current === playIndex;
    pendingSoundIndexRef.current = null;
    if (!shouldPlay) {
      return;
    }
    const event = events[playIndex];
    if (!event || event.type === "draw" || event.type === "discard") {
      return;
    }
    try {
      playSoundForEvent(event, null);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[game] spectator sound dispatch threw", err);
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
    r.setHandResultOverride(eyeHeld ? renderedPostHandPeekResult : null);
    // Staged per-yaku win reveal only while following the live head.
    // Paused on history, new relay events keep rebuilding the view
    // (fresh `lastHandResult`), which would restart the reveal every
    // frame — an endless loop. Show it fully revealed instead.
    r.setStagedRevealEnabled(live);
    r.setSeatEnrichment([
      seatEnrichment[(0 + focusSeat) % 4],
      seatEnrichment[(1 + focusSeat) % 4],
      seatEnrichment[(2 + focusSeat) % 4],
      seatEnrichment[(3 + focusSeat) % 4],
    ]);
    const args = replayViewToMatchView(view, {
      index: playIndex,
      mySeat: focusSeat,
      matchId,
      seatNames,
      currentWaits,
      roomState,
    });
    latestRenderRef.current = args;
    r.render(args);
  }, [
    view,
    playIndex,
    focusSeat,
    overlays,
    matchId,
    seatNames,
    seatEnrichment,
    roomState,
    live,
    eyeHeld,
    renderedPostHandPeekResult,
    currentWaits,
  ]);

  // -----------------------------------------------------------------------
  // Navigation helpers
  // -----------------------------------------------------------------------
  const minIndex = -1;
  const maxIndex = events.length - 1;
  const clamp = (n: number): number =>
    Math.max(minIndex, Math.min(n, maxIndex));
  /** Step to absolute event index `n`. Always pauses live mode. */
  const goto = (n: number): void => {
    pendingSoundIndexRef.current = null;
    setLive(false);
    setPlayIndex(clamp(n));
  };
  const goLive = (): void => {
    pendingSoundIndexRef.current = null;
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
    pendingSoundIndexRef.current = replaySoundTarget(
      playIndexRef.current,
      next,
      "step"
    );
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
    pendingSoundIndexRef.current = null;
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
        <ViewerListToggle
          visible={showViewerList}
          onToggle={() => {
            setShowViewerList((visible) => !visible);
          }}
        />
        <button
          type="button"
          onClick={() => {
            void navigate(returnPath);
          }}
          className="ml-2 px-2 py-0.5 rounded bg-white/10 hover:bg-white/20 text-xs"
        >
          Leave
        </button>
        <span className="ml-2 opacity-50 text-xs">{conn}</span>
      </div>
      {showViewerList && (
        <ViewerList viewers={viewers} className="absolute left-2 top-12" />
      )}

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
              stepBy(-1);
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
              stepBy(1);
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
        {/* Row 3: Go-live shortcut. Kept in the layout (just made
            invisible) when already live so its appearance doesn't
            shove the rows above it. */}
        <button
          type="button"
          onClick={goLive}
          disabled={isLive}
          aria-hidden={isLive}
          className={`px-3 py-2 text-base rounded bg-red-700 hover:bg-red-600 border border-red-900 text-white font-semibold flex items-center justify-center gap-2${
            isLive ? " invisible" : ""
          }`}
          aria-label="Go live"
          title="Jump to latest event and resume live updates"
        >
          <span className="inline-block w-2 h-2 rounded-full bg-white animate-pulse" />
          Go live
        </button>
        <span className="font-mono text-sm text-emerald-100/80 text-center">
          {playIndex + 1} / {events.length}
        </span>
      </div>

      {postHandPeekResult && pondCenter && (
        <button
          type="button"
          onPointerDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
            setEyeHeld(true);
          }}
          onPointerUp={(event) => {
            event.preventDefault();
            setEyeHeld(false);
          }}
          onPointerLeave={() => {
            setEyeHeld(false);
          }}
          className="pointer-events-auto absolute z-40 flex h-10 w-10 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full shadow-lg cursor-pointer select-none text-lg"
          style={{
            left: pondCenter.x,
            top: pondCenter.y,
            backgroundColor: "rgba(0, 0, 0, 0.8)",
            color: "#a7f3d0",
            border: "1px solid rgba(16, 185, 129, 0.5)",
          }}
          aria-label="Peek last hand result"
          title="Hold to peek at last hand result"
        >
          <EyeOutlined />
        </button>
      )}

      <ReplayOverlayPanel overlays={overlays} onChange={setOverlays} />

      <div ref={containerRef} className="w-full h-full" />
    </main>
  );
}
