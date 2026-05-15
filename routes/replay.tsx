import { useEffect, useMemo, useRef, useState } from "react";
import { Link, redirect, useSearchParams } from "react-router";
import { requireGameEnabled } from "~/game/feature-gate";
import { adapter } from "~/game/portal-adapter";
import type { TableRenderer } from "~/game/client/pixi/TableRenderer";
import {
  applyReplayEvent,
  initialView,
  replayBounds,
  replayViewToMatchView,
  roundBoundaries,
} from "~/game/replay/player";
import type { ReplayView } from "~/game/replay/player";
import type { GameEvent, Seat } from "~/game/protocol/messages";
import { ReplayLogModel, type DbReplayLog } from "~/db/models/ReplayLog";
import { inferReplaySource } from "~/game/replay/inferSource";
import { fetchOrphanReplayLog } from "~/game/replay/fetchOrphanReplayLog.server";
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
export async function loader({ params, request }: Route.LoaderArgs) {
  requireGameEnabled();
  const gameId = params.gameId ?? "";
  if (!gameId) {
    throw new Response("Missing replay id.", { status: 404 });
  }

  // Normalize platform-native viewer-link suffixes so that pasting
  // a raw majsoul / Riichi City URL fragment "just works":
  //
  //   - Majsoul appends `_a<accountId>` to its share URLs to mark
  //     which player generated the link. We strip the suffix from
  //     the id and — if the cached replay knows that accountId —
  //     surface the matching seat through the `?seat=` deeplink
  //     param so the viewer opens with that player at the bottom.
  //     Majsoul stashes the per-seat `accountId` (as a string) on
  //     the `match_start` event's `seats[].userId`.
  //   - Riichi City appends `@<n>` (0–3) to a log id to mark which
  //     seat that share link is from. We strip the suffix from the
  //     id and surface the seat through the `?seat=` deeplink
  //     param so the viewer opens with that player at the bottom.
  //
  // Either fixup issues a 302 to the canonical URL so the cleaned
  // form lands in the address bar and downstream caching keys
  // collapse onto a single canonical id.
  // React Router's `redirect()` prepends the configured
  // `basename` (e.g. `/kandora/` in REMOTE dev) to whatever path
  // we hand it, so we must hand it a basename-RELATIVE path —
  // never the raw `url.pathname`, which already includes the
  // basename and would otherwise produce `/kandora/kandora/...`.
  const url = new URL(request.url);
  const majsoulSuffix = /_a\d+$/.exec(gameId);
  if (majsoulSuffix) {
    // Majsoul appends `_a<obfuscated-sharer-id>` to its share
    // URLs. The number is the URL-sharer's account id passed
    // through Majsoul's private web-client encoding (it's NOT the
    // raw `account_id`, NOT a friend-id `searchAccountByPattern`
    // can decode, and in general not one of the seats in the
    // replay anyway — the sharer can be a spectator). So we
    // just strip it for a clean canonical URL and leave the
    // viewer to default to seat 0; the user can pick a seat from
    // the dropdown or pass `?seat=N` explicitly.
    const cleanId = gameId.slice(0, majsoulSuffix.index);
    const qs = url.searchParams.toString();
    throw redirect(`/replays/${cleanId}${qs ? `?${qs}` : ""}`);
  }
  const rcSuffix = /@([0-3])$/.exec(gameId);
  if (rcSuffix) {
    const seat = rcSuffix[1];
    const cleanId = gameId.slice(0, rcSuffix.index);
    const search = new URLSearchParams(url.searchParams);
    if (!search.has("seat")) {
      search.set("seat", seat);
    }
    const qs = search.toString();
    throw redirect(`/replays/${cleanId}${qs ? `?${qs}` : ""}`);
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
      events: annotateWallSchedule(doc.events as GameEvent[]),
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
    events: annotateWallSchedule(fetched.events),
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

  // URL deeplink state. Three optional search params, all
  // independently set so a partial URL still makes sense:
  //   ?seat=N      focused player (0–3)
  //   ?round=N     1-based round ordinal (matches the round
  //                picker). When `event` is absent we jump to
  //                that round's `hand_start`.
  //   ?event=N     absolute event index. When present it is
  //                authoritative for the playhead and `round`
  //                is purely informational.
  // We keep the URL in sync via `setSearchParams({ replace })`
  // so scrubbing doesn't pollute browser history.
  const [searchParams, setSearchParams] = useSearchParams();

  const clampSeat = (n: number): Seat => {
    if (n === 1 || n === 2 || n === 3) {
      return n;
    }
    return 0;
  };
  const clampToBounds = (n: number): number => {
    return Math.max(bounds.min, Math.min(n, bounds.max));
  };

  // Resolve the initial playhead + seat from the URL exactly
  // once at mount; subsequent navigation flows through
  // component state.
  const initial = useMemo(() => {
    const seatRaw = Number(searchParams.get("seat"));
    const seat: Seat = Number.isFinite(seatRaw) ? clampSeat(seatRaw) : 0;

    const eventRaw = searchParams.get("event");
    if (eventRaw !== null && eventRaw !== "") {
      const n = Number(eventRaw);
      if (Number.isFinite(n)) {
        return { seat, index: clampToBounds(Math.trunc(n)) };
      }
    }
    const roundRaw = searchParams.get("round");
    if (roundRaw !== null && roundRaw !== "") {
      const n = Number(roundRaw);
      if (Number.isFinite(n)) {
        const ord = Math.trunc(n) - 1;
        const r = rounds[ord];
        if (r !== undefined) {
          return { seat, index: clampToBounds(r) };
        }
      }
    }
    // Open one event past the first hand_start when available
    // so the viewer doesn't greet the user with an empty table.
    return { seat, index: rounds[0] ?? bounds.min };
    // Snapshot-only: deliberately ignore later searchParams /
    // bounds / rounds changes here — the playhead is driven by
    // component state from this point on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [index, setIndex] = useState<number>(initial.index);
  const [overlays, setOverlays] = useState<ReplayOverlayState>(
    defaultReplayOverlayState
  );
  const [focusSeat, setFocusSeat] = useState<Seat>(initial.seat);
  const [copied, setCopied] = useState<boolean>(false);

  // Write `seat`, `round`, `event` back to the URL on every
  // state change. `round` is derived (largest hand_start ≤
  // index, 1-based) so it always matches the picker label.
  useEffect(() => {
    let roundOrdinal = 0;
    for (let i = 0; i < rounds.length; i++) {
      if (rounds[i] <= index) {
        roundOrdinal = i + 1;
      }
    }
    const next = new URLSearchParams(searchParams);
    next.set("seat", String(focusSeat));
    if (roundOrdinal > 0) {
      next.set("round", String(roundOrdinal));
    } else {
      next.delete("round");
    }
    next.set("event", String(index));
    if (next.toString() !== searchParams.toString()) {
      setSearchParams(next, { replace: true });
    }
  }, [focusSeat, index, rounds, searchParams, setSearchParams]);

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
    // Pixi.js touches `navigator` at module-eval time, so it must
    // only load in the browser. Dynamic-import keeps it out of the
    // SSR bundle.
    void import("~/game/client/pixi/TableRenderer").then(
      ({ TableRenderer }) => {
        if (cancelled) {
          return;
        }
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
            mySeat: focusSeat,
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
      }
    );
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
        mySeat: focusSeat,
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
    focusSeat,
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
      className="fixed inset-0 z-[9999] bg-black"
      style={{
        paddingTop: "env(safe-area-inset-top)",
        paddingBottom: "env(safe-area-inset-bottom)",
        paddingLeft: "env(safe-area-inset-left)",
        paddingRight: "env(safe-area-inset-right)",
      }}
    >
      <div
        ref={containerRef}
        className="relative w-full h-full bg-black overflow-hidden"
        style={{ touchAction: "none" }}
      >
        {/* Top-left: replay metadata label. */}
        <div className="pointer-events-none absolute top-2 left-2 z-30 font-mono text-xs text-emerald-100/80 px-2 py-1 rounded bg-black/40">
          replay · {log.source} · {log.sourceGameId} · {currentRound}
        </div>
        {/* Bottom-right: tile-art attribution. */}
        <div className="absolute bottom-2 right-2 z-30 font-mono text-[10px] text-emerald-100/70 px-2 py-1 rounded bg-black/40">
          Tile design copyright of{" "}
          <a
            href="https://tenhou.net/"
            target="_blank"
            rel="noopener noreferrer"
            className="underline hover:text-emerald-200"
          >
            Tenhou.net
          </a>
          , C-Egg
        </div>
        {/* Top-right: share + close icons. */}
        <button
          type="button"
          onClick={() => {
            // Copy the current canonical deeplink to the clipboard
            // (defaults to the current URL — `seat`/`round`/`event`
            // are kept in sync by the effect above). Falls back to
            // a temporary textarea on browsers without the async
            // clipboard API (e.g. http-only contexts).
            const url =
              typeof window !== "undefined" ? window.location.href : "";
            const done = (): void => {
              setCopied(true);
              window.setTimeout(() => {
                setCopied(false);
              }, 1500);
            };
            if (navigator.clipboard?.writeText) {
              void navigator.clipboard.writeText(url).then(done, done);
            } else {
              const ta = document.createElement("textarea");
              ta.value = url;
              ta.setAttribute("readonly", "");
              ta.style.position = "absolute";
              ta.style.left = "-9999px";
              document.body.appendChild(ta);
              ta.select();
              try {
                document.execCommand("copy");
              } catch {
                /* best-effort */
              }
              document.body.removeChild(ta);
              done();
            }
          }}
          aria-label="Copy share link"
          title={copied ? "Copied!" : "Copy share link"}
          className="absolute top-2 right-[5.25rem] z-30 h-8 min-w-[4rem] px-3 flex items-center justify-center gap-1 rounded bg-black/70 hover:bg-emerald-800 text-emerald-100 hover:text-white text-xs transition-colors"
        >
          {copied ? "Copied" : "Share"}
        </button>
        <Link
          to="/lobby"
          aria-label="Close replay"
          className="absolute top-2 right-2 z-30 h-8 min-w-[4rem] px-3 inline-flex items-center justify-center gap-1 rounded bg-black/70 hover:bg-emerald-800 text-emerald-100 hover:text-white text-xs no-underline transition-colors"
          style={{ backgroundColor: "rgba(0, 0, 0, 0.7)" }}
        >
          ✕
        </Link>
        {/* Right-side: seat / round selectors + nav buttons. */}
        <div className="absolute top-1/2 right-2 -translate-y-1/2 z-30 flex flex-col items-stretch gap-2 text-emerald-100 text-sm">
          {/* Row 1: seat selection, then round selection. */}
          <div className="flex items-center gap-2">
            <select
              aria-label="Focus seat"
              value={String(focusSeat)}
              onChange={(e) => {
                setFocusSeat(Number(e.target.value) as Seat);
              }}
              className="bg-black/60 border border-emerald-700 rounded px-2 py-1 text-xs text-emerald-100"
            >
              {([0, 1, 2, 3] as const).map((s) => {
                const name = log.seats[s]?.displayName ?? `Seat ${s}`;
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
                className="bg-black/60 border border-emerald-700 rounded px-2 py-1 text-xs text-emerald-100"
              >
                {rounds.map((r, i) => {
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
            )}
          </div>
          {/* Row 2: prev round, prev event, next event, next round. */}
          {(() => {
            // Find the current round's index in `rounds` (largest
            // boundary <= index). Prev/next round step through that
            // list; first/last are reachable by the bookends.
            let currentRoundIdx = -1;
            for (let i = 0; i < rounds.length; i++) {
              if (rounds[i] <= index) {
                currentRoundIdx = i;
              }
            }
            const prevRound =
              currentRoundIdx > 0 ? rounds[currentRoundIdx - 1] : null;
            const nextRound =
              currentRoundIdx >= 0 && currentRoundIdx < rounds.length - 1
                ? rounds[currentRoundIdx + 1]
                : null;
            return (
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => {
                    if (prevRound !== null) {
                      goto(prevRound);
                    }
                  }}
                  disabled={prevRound === null}
                  className="px-2 py-1 rounded bg-black/60 hover:bg-emerald-800 disabled:opacity-40 border border-emerald-700 text-emerald-100"
                  aria-label="Previous round"
                  title="Previous round"
                >
                  ⏮
                </button>
                <button
                  type="button"
                  onClick={() => {
                    goto(index - 1);
                  }}
                  disabled={index <= bounds.min}
                  className="px-2 py-1 rounded bg-black/60 hover:bg-emerald-800 disabled:opacity-40 border border-emerald-700 text-emerald-100"
                  aria-label="Previous event"
                  title="Previous event"
                >
                  ◀
                </button>
                <button
                  type="button"
                  onClick={() => {
                    goto(index + 1);
                  }}
                  disabled={index >= bounds.max}
                  className="px-2 py-1 rounded bg-black/60 hover:bg-emerald-800 disabled:opacity-40 border border-emerald-700 text-emerald-100"
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
                  className="px-2 py-1 rounded bg-black/60 hover:bg-emerald-800 disabled:opacity-40 border border-emerald-700 text-emerald-100"
                  aria-label="Next round"
                  title="Next round"
                >
                  ⏭
                </button>
              </div>
            );
          })()}
          <span className="font-mono text-[10px] text-emerald-100/70 text-center">
            {index + 1} / {log.events.length}
          </span>
        </div>
        <ReplayOverlayPanel overlays={overlays} onChange={setOverlays} />
      </div>
    </div>
  );
}
