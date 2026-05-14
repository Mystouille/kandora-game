import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { requireGameEnabled } from "~/game/feature-gate";
import { adapter } from "~/game/portal-adapter";
import { TableRenderer } from "~/game/client/pixi/TableRenderer";
import {
  applyReplayEvent,
  initialView,
  replayBounds,
  replayViewToMatchView,
  roundBoundaries,
} from "~/game/replay/player";
import type { ReplayView } from "~/game/replay/player";
import type { GameEvent } from "~/game/protocol/messages";
import { ReplayLogModel, type DbReplayLog } from "~/db/models/ReplayLog";
import { inferReplaySource } from "~/game/replay/inferSource";
import { fetchOrphanReplayLog } from "~/game/replay/fetchOrphanReplayLog.server";
import { synthesizeLiveWalls } from "~/game/replay/synthesizeLiveWalls";
import { annotateWallSchedule } from "~/game/replay/annotateWallSchedule";
import { annotateWaits } from "~/game/replay/annotateWaits";
import type { ReplayLog, ReplaySource } from "~/game/replay/types";
import type { Route } from "./+types/replay";
import {
  ReplayOverlayPanel,
  defaultReplayOverlayState,
  type ReplayOverlayState,
} from "./ReplayOverlayPanel";

/**
 * `/replays/:gameId` — Phase 4.5 replay viewer.
 *
 * The platform is inferred from the `:gameId` shape via
 * `inferReplaySource`; when inference returns `null` we fall back to
 * a source-agnostic lookup so debug / hand-crafted ids still resolve
 * when a unique row exists.
 *
 * Loader path:
 *   1. Look up the `ReplayLog` row by `(source, sourceGameId)` (or
 *      `sourceGameId` alone when inference returned null).
 *   2. On miss, dispatch to `fetchOrphanReplayLog(source, gameId)`
 *      which talks to the right `*LeagueConnector` to fetch + parse
 *      the platform log and upserts it as an orphan row (no
 *      `Game.replayLogRef` link). This makes replays viewable even
 *      when no `Game` doc exists yet — useful for ad-hoc URLs and
 *      for closing the gap between play-time and the next
 *      hydration cycle.
 *   3. On miss with no inferable source (e.g. hand-crafted id we
 *      don't know how to fetch), throw a 404.
 *
 * The component holds `index` in component state, derives a
 * `ReplayView` via the incremental reducer, and renders the Pixi
 * `TableRenderer` with prev / next / first / last / round picker
 * controls.
 *
 * Gated by `requireGameEnabled()`.
 */
export async function loader({ params }: Route.LoaderArgs) {
  requireGameEnabled();
  const gameId = params.gameId ?? "";
  if (!gameId) {
    throw new Response("Missing replay id.", { status: 404 });
  }
  const source = inferReplaySource(gameId);
  await adapter.ensureDbConnected();
  const query: Record<string, string> = { sourceGameId: gameId };
  if (source) {
    query.source = source;
  }
  const doc = await ReplayLogModel.findOne(query)
    .lean<DbReplayLog & { _id: unknown }>()
    .exec();

  // Cache hit: hand the persisted row straight to the component.
  if (doc) {
    const log: ReplayLog = {
      source: doc.source as ReplaySource,
      sourceGameId: doc.sourceGameId,
      ruleSet: doc.ruleSet,
      ruleSetDetails: doc.ruleSetDetails as Record<string, unknown> | undefined,
      startedAt: doc.startedAt,
      endedAt: doc.endedAt,
      seats: doc.seats as ReplayLog["seats"],
      // Pre-pass: derive each hand's `liveWall` from the event
      // sequence when the source didn't provide one (every
      // external-platform adapter falls into this bucket). The
      // `showWalls` overlay reads `view.liveWall` so this is what
      // actually populates the face-up tiles on Tenhou / MJSoul /
      // RiichiCity replays.
      events: annotateWallSchedule(
        synthesizeLiveWalls(doc.events as GameEvent[])
      ),
      schemaVersion: doc.schemaVersion,
    };
    // Pre-compute per-event wait snapshots server-side so the
    // renderer never runs shanten on the client.
    const waitsByIndex = annotateWaits(log.events);
    return { log, waitsByIndex };
  }

  // Cache miss: try to fetch + parse from the platform on-demand
  // (Phase 4.5 follow-up — orphan logs are fine for now, no
  // `Game.replayLogRef` link is created). We need a source to know
  // which connector to talk to; inference returning `null` means
  // we can only 404.
  if (!source) {
    throw new Response(
      "Replay not yet available; it will appear after the next hydration cycle.",
      { status: 404 }
    );
  }
  const fetched = await fetchOrphanReplayLog(source, gameId);
  if (!fetched) {
    throw new Response(
      "Replay not yet available; it will appear after the next hydration cycle.",
      { status: 404 }
    );
  }
  const annotatedLog = {
    ...fetched,
    events: annotateWallSchedule(synthesizeLiveWalls(fetched.events)),
  };
  return {
    log: annotatedLog,
    waitsByIndex: annotateWaits(annotatedLog.events),
  };
}

export default function ReplayRoute({ loaderData }: Route.ComponentProps) {
  const { log, waitsByIndex } = loaderData;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const rendererRef = useRef<TableRenderer | null>(null);
  // Mirrors the latest `MatchView` rendered so the renderer's
  // resize callback (mount-time-only closure) always has fresh
  // state to re-render with.
  const latestRenderRef = useRef<ReturnType<
    typeof replayViewToMatchView
  > | null>(null);

  const bounds = useMemo(() => replayBounds(log), [log]);
  const rounds = useMemo(() => roundBoundaries(log), [log]);
  // Open one event past the first hand_start when available so the
  // viewer doesn't greet the user with an empty table.
  const initialIndex = rounds[0] ?? bounds.min;
  const [index, setIndex] = useState<number>(initialIndex);
  const [overlays, setOverlays] = useState<ReplayOverlayState>(
    defaultReplayOverlayState
  );

  // Incremental fold: we keep prefix views in a ref so a "next"
  // click is O(1) instead of O(index). Whole-fold path on seek.
  const viewCacheRef = useRef<{
    builtTo: number;
    view: ReplayView;
  } | null>(null);

  const currentView = useMemo<ReplayView>(() => {
    const cache = viewCacheRef.current;
    if (cache && cache.builtTo === index) {
      return cache.view;
    }
    if (cache && index === cache.builtTo + 1) {
      const next = applyReplayEvent(cache.view, log.events[index]);
      viewCacheRef.current = { builtTo: index, view: next };
      return next;
    }
    // Cache miss / backward jump / arbitrary seek — re-fold.
    let v = initialView();
    for (let i = 0; i <= index && i < log.events.length; i++) {
      v = applyReplayEvent(v, log.events[i]);
    }
    viewCacheRef.current = { builtTo: index, view: v };
    return v;
  }, [log, index]);

  // Mount Pixi once.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    let cancelled = false;
    const renderer = new TableRenderer();
    void renderer.mount(container).then(() => {
      if (cancelled) {
        renderer.destroy();
        return;
      }
      rendererRef.current = renderer;
      // Wire the renderer's resize hook to a re-render. The
      // renderer's ResizeObserver calls this whenever the canvas
      // container changes size (window resize, devtools open, etc.);
      // we read the latest view from `latestRenderRef` so the
      // callback never closes over stale state.
      renderer.setOnRenderRequest(() => {
        const r = rendererRef.current;
        const args = latestRenderRef.current;
        if (r && args) {
          r.render(args);
        }
      });
      const initialArgs = replayViewToMatchView(currentView, {
        index,
        matchId: log.sourceGameId,
        seatNames: [
          log.seats[0]?.displayName ?? "",
          log.seats[1]?.displayName ?? "",
          log.seats[2]?.displayName ?? "",
          log.seats[3]?.displayName ?? "",
        ],
        currentWaits: waitsByIndex[index] ?? null,
      });
      latestRenderRef.current = initialArgs;
      renderer.render(initialArgs);
    });
    return () => {
      cancelled = true;
      if (rendererRef.current) {
        rendererRef.current.destroy();
        rendererRef.current = null;
      }
    };
    // Mount-once: deliberately ignore `currentView`/`index` here;
    // the dedicated re-render effect below handles updates.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-render on every step.
  useEffect(() => {
    if (rendererRef.current) {
      rendererRef.current.setShowLayoutDebug(overlays.showLayoutDebug);
      rendererRef.current.setShowWaits(overlays.showWaits);
      rendererRef.current.setShowHands(overlays.showHands);
      rendererRef.current.setShowWalls(overlays.showWalls);
      rendererRef.current.setShowNames(overlays.showNames);
      const args = replayViewToMatchView(currentView, {
        index,
        matchId: log.sourceGameId,
        seatNames: [
          log.seats[0]?.displayName ?? "",
          log.seats[1]?.displayName ?? "",
          log.seats[2]?.displayName ?? "",
          log.seats[3]?.displayName ?? "",
        ],
        currentWaits: waitsByIndex[index] ?? null,
      });
      latestRenderRef.current = args;
      rendererRef.current.render(args);
    }
  }, [
    currentView,
    index,
    log.sourceGameId,
    log.seats,
    waitsByIndex,
    overlays.showLayoutDebug,
    overlays.showWaits,
    overlays.showHands,
    overlays.showWalls,
    overlays.showNames,
  ]);

  const clamp = (n: number): number =>
    Math.max(bounds.min, Math.min(n, bounds.max));
  const goto = (n: number): void => {
    setIndex(clamp(n));
  };

  // Mouse-wheel scrubbing on the canvas container: scroll down →
  // advance one event, scroll up → rewind one event. Each wheel
  // tick is a single step; we throttle to avoid blasting through
  // a round on a high-resolution trackpad.
  const wheelAccumRef = useRef(0);
  const wheelLastRef = useRef(0);
  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      const now = Date.now();
      // Reset the accumulator when the gesture pauses, so an
      // intentional small flick doesn't get diluted by stale dy.
      if (now - wheelLastRef.current > 200) {
        wheelAccumRef.current = 0;
      }
      wheelLastRef.current = now;
      wheelAccumRef.current += e.deltaY;
      const threshold = 30;
      while (wheelAccumRef.current >= threshold) {
        wheelAccumRef.current -= threshold;
        setIndex((i) => Math.max(bounds.min, Math.min(i + 1, bounds.max)));
      }
      while (wheelAccumRef.current <= -threshold) {
        wheelAccumRef.current += threshold;
        setIndex((i) => Math.max(bounds.min, Math.min(i - 1, bounds.max)));
      }
    };
    container.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      container.removeEventListener("wheel", onWheel);
    };
  }, [bounds.min, bounds.max]);

  // Click scrubbing on the canvas container: left-click → advance
  // one event, right-click → rewind one event. `contextmenu` is
  // suppressed so the right-click step doesn't pop the browser
  // menu. Listeners filter out clicks on overlay panel controls
  // (`button`, `input`, `label`, `select`) so the overlay HUD
  // remains usable.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
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
      const delta = e.button === 0 ? 1 : -1;
      setIndex((i) => Math.max(bounds.min, Math.min(i + delta, bounds.max)));
    };
    const onContextMenu = (e: MouseEvent): void => {
      if (isInteractiveTarget(e.target)) {
        return;
      }
      e.preventDefault();
    };
    container.addEventListener("mousedown", onMouseDown);
    container.addEventListener("contextmenu", onContextMenu);
    return () => {
      container.removeEventListener("mousedown", onMouseDown);
      container.removeEventListener("contextmenu", onContextMenu);
    };
  }, [bounds.min, bounds.max]);

  // For the round picker label.
  const currentRound = (() => {
    if (index < 0) {
      return "—";
    }
    return `${currentView.roundWind}${currentView.roundNumber}`;
  })();

  return (
    <div
      className="fixed inset-0 z-[9999] flex flex-col bg-emerald-950"
      style={{
        paddingTop: "env(safe-area-inset-top)",
        paddingBottom: "env(safe-area-inset-bottom)",
        paddingLeft: "env(safe-area-inset-left)",
        paddingRight: "env(safe-area-inset-right)",
      }}
    >
      <div className="flex items-center justify-between px-4 py-2 text-sm text-emerald-100/80 bg-emerald-950/95 border-b border-emerald-800">
        <span className="font-mono text-xs">
          replay · {log.source} · {log.sourceGameId} · {currentRound}
        </span>
        <Link
          to="/lobby"
          className="px-3 py-1.5 rounded bg-emerald-800 hover:bg-emerald-700 text-white text-xs font-semibold transition-colors"
        >
          Close
        </Link>
      </div>
      <div
        ref={containerRef}
        className="relative flex-1 w-full bg-emerald-900 overflow-hidden"
        style={{ touchAction: "none" }}
      >
        <ReplayOverlayPanel overlays={overlays} onChange={setOverlays} />
      </div>
      <div className="flex flex-wrap items-center gap-2 px-4 py-2 bg-emerald-950/95 border-t border-emerald-800 text-emerald-100 text-sm">
        <button
          type="button"
          onClick={() => {
            goto(bounds.min);
          }}
          disabled={index <= bounds.min}
          className="px-2 py-1 rounded bg-emerald-800 disabled:opacity-40 hover:bg-emerald-700"
          aria-label="First event"
        >
          ⏮
        </button>
        <button
          type="button"
          onClick={() => {
            goto(index - 1);
          }}
          disabled={index <= bounds.min}
          className="px-2 py-1 rounded bg-emerald-800 disabled:opacity-40 hover:bg-emerald-700"
          aria-label="Previous event"
        >
          ◀
        </button>
        <button
          type="button"
          onClick={() => {
            goto(index + 1);
          }}
          disabled={index >= bounds.max}
          className="px-2 py-1 rounded bg-emerald-800 disabled:opacity-40 hover:bg-emerald-700"
          aria-label="Next event"
        >
          ▶
        </button>
        <button
          type="button"
          onClick={() => {
            goto(bounds.max);
          }}
          disabled={index >= bounds.max}
          className="px-2 py-1 rounded bg-emerald-800 disabled:opacity-40 hover:bg-emerald-700"
          aria-label="Last event"
        >
          ⏭
        </button>
        <span className="font-mono text-xs ml-2">
          event {index + 1} / {log.events.length}
        </span>
        {rounds.length > 0 && (
          <label className="ml-4 flex items-center gap-2 text-xs">
            round
            <select
              value={(() => {
                // Pick the latest hand_start whose index is ≤ current.
                let pick = -1;
                for (const r of rounds) {
                  if (r <= index) {
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
              className="bg-emerald-900 border border-emerald-700 rounded px-1 py-0.5 text-xs"
            >
              {rounds.map((r, i) => {
                // Peek the event's wind/round for a label.
                const ev = log.events[r];
                if (ev.type !== "hand_start") {
                  return null;
                }
                const label = `${ev.roundWind ?? "?"}${ev.roundNumber ?? i + 1}`;
                return (
                  <option key={r} value={String(r)}>
                    {label}
                  </option>
                );
              })}
            </select>
          </label>
        )}
      </div>
    </div>
  );
}
