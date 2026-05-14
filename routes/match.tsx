import { useEffect, useRef } from "react";
import { Link } from "react-router";
import { requireGameEnabled, getClientGameFlag } from "~/game/feature-gate";
import { TableRenderer } from "~/game/client/pixi/TableRenderer";
import { useMatchStore } from "~/game/client/store";
import { GameWS } from "~/game/client/ws";
import { takeMatchDebug } from "~/game/client/debugSeed";
import type { Route } from "./+types/match";

/**
 * Mobile-shell prep, scoped to the match route only:
 *
 *   - Swap the global viewport meta to one with `maximum-scale=1`
 *     and `user-scalable=no` so iOS doesn't double-tap-zoom or
 *     pinch-zoom the Pixi canvas. Restored on unmount; the rest of
 *     the portal keeps regular pinch-zoom.
 *   - Acquire a screen wake lock so the device doesn't dim mid-
 *     hand. Released on unmount. Feature-detected (older iOS
 *     Safari has no Wake Lock API — silent no-op).
 *
 * Both also benefit the web today (no need to wait for Phase M).
 */
function useMatchPageEffects(): void {
  useEffect(() => {
    const viewport = document.querySelector('meta[name="viewport"]');
    const previousContent = viewport?.getAttribute("content") ?? null;
    if (viewport) {
      viewport.setAttribute(
        "content",
        "width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover"
      );
    }

    // Wake lock: the API can reject (permissions, focus loss, no
    // support); none of those should bubble to the user.
    interface WakeLockSentinel {
      release(): Promise<void>;
    }
    interface WakeLockApi {
      request(type: "screen"): Promise<WakeLockSentinel>;
    }
    let sentinel: WakeLockSentinel | null = null;
    let cancelled = false;
    const nav = navigator as Navigator & { wakeLock?: WakeLockApi };
    if (nav.wakeLock && typeof nav.wakeLock.request === "function") {
      nav.wakeLock
        .request("screen")
        .then((s) => {
          if (cancelled) {
            void s.release().catch(() => undefined);
            return;
          }
          sentinel = s;
        })
        .catch(() => {
          // Request denied / not visible / unsupported — fine.
        });
    }

    return () => {
      cancelled = true;
      if (viewport && previousContent !== null) {
        viewport.setAttribute("content", previousContent);
      }
      if (sentinel) {
        void sentinel.release().catch(() => undefined);
        sentinel = null;
      }
    };
  }, []);
}

/**
 * `/game/:matchId` — the in-game route.
 *
 * Mounts the Pixi `TableRenderer` into a container `<div>`, subscribes
 * it to the Zustand store, and (eventually) wires a `GameWS` to the
 * game-server. Phase 0.5 ships ahead of the server: when no `wsUrl` is
 * configured, the renderer runs in detached mode and shows the empty
 * table — proves the route/mount/store seam works end-to-end.
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

export default function GameMatchRoute({ loaderData }: Route.ComponentProps) {
  const { matchId } = loaderData;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const rendererRef = useRef<TableRenderer | null>(null);
  const wsRef = useRef<GameWS | null>(null);

  const view = useMatchStore();

  useMatchPageEffects();

  // Mount Pixi + WS once, tear down on unmount.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    let cancelled = false;

    // Reset store for this match; seat 0 = the user (slice convention).
    useMatchStore.getState().setMatch(matchId, 0);

    const renderer = new TableRenderer();
    void renderer.mount(container).then(() => {
      if (cancelled) {
        renderer.destroy();
        return;
      }
      rendererRef.current = renderer;
      renderer.setOnTileClick(({ tile }) => {
        // Optimistic discard for own seat; the server confirmation
        // (a `discard` event) will clear `pendingDiscard`.
        const state = useMatchStore.getState();
        if (state.mySeat === null) {
          return;
        }
        state.setPendingDiscard({ seat: state.mySeat, tile });
        // Find the matching legal action and forward it.
        const legal = state.legalActions.find(
          (a) => a.type === "discard" && a.tile === tile
        );
        if (legal && wsRef.current) {
          wsRef.current.act(legal.id);
        }
      });
      renderer.setOnActionClick(({ action }) => {
        // Generic dispatch for call / pass / ron / etc. buttons. The
        // server validated these into `legalActions`, so we just echo
        // the id back.
        if (wsRef.current) {
          wsRef.current.act(action.id);
        }
      });
      renderer.setOnRenderRequest(() => {
        // Renderer internal-state changes (e.g. riichi mode toggle)
        // need an explicit re-render — store state hasn't changed,
        // so the subscribe-driven loop won't fire.
        renderer.render(useMatchStore.getState());
      });
      // Initial draw with whatever the store currently holds.
      renderer.render(useMatchStore.getState());
    });

    // Fetch a session token + ws URL from the portal, then connect.
    void (async () => {
      try {
        // Mirror `~/utils/basePath` (the boundary rule blocks `~/utils/*`):
        // honor Vite's BASE_URL so this works when the app is mounted
        // under a non-root basename (e.g. `/kandora/` in `dev:remote`).
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
        // Same-origin default: derive ws/wss from the current page so
        // it works behind a TLS reverse proxy without env config.
        // The WS path is mounted under the app basename so the public
        // reverse proxy (which only forwards `${basePath}/*` to Vite
        // in `dev:remote`) routes it correctly; Vite's proxy strips
        // the basename before forwarding to the game-server.
        const wsScheme = window.location.protocol === "https:" ? "wss:" : "ws:";
        const origin =
          session.wsUrl ?? `${wsScheme}//${window.location.host}${basePath}`;
        const fullUrl = `${origin}${session.wsPath}/${encodeURIComponent(matchId)}`;
        const ws = new GameWS({
          wsUrl: fullUrl,
          token: session.token,
          matchId,
          // Lobby may have stowed a debug seed under this matchId; sent
          // once in the `hello` frame and consumed by the game-server
          // on first attach.
          debug: takeMatchDebug(matchId),
        });
        wsRef.current = ws;
        ws.connect();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("[game] session fetch failed", err);
      }
    })();

    return () => {
      cancelled = true;
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
  }, [matchId]);

  // Re-render the canvas whenever the projected view changes.
  useEffect(() => {
    if (rendererRef.current) {
      rendererRef.current.render(view);
    }
  }, [view]);

  return (
    <div
      // Full-viewport overlay: covers the site header / sidebar so
      // they're neither visible nor clickable while a match is in
      // progress. The fixed position + max z-index lifts it above
      // any AntD `Layout` chrome rendered by `Navigation`. Padding
      // honors iOS safe-area insets (notch / home indicator) —
      // no-op on non-notched devices.
      className="fixed inset-0 z-[9999] flex flex-col bg-emerald-950"
      style={{
        paddingTop: "env(safe-area-inset-top)",
        paddingBottom: "env(safe-area-inset-bottom)",
        paddingLeft: "env(safe-area-inset-left)",
        paddingRight: "env(safe-area-inset-right)",
      }}
    >
      <div className="flex items-center justify-between px-4 py-2 text-sm text-emerald-100/80 bg-emerald-950/95 border-b border-emerald-800">
        <span className="font-mono text-xs">match {matchId}</span>
        <Link
          to="/lobby"
          className="px-3 py-1.5 rounded bg-emerald-800 hover:bg-emerald-700 text-white text-xs font-semibold transition-colors"
        >
          Close
        </Link>
      </div>
      <div
        ref={containerRef}
        // `touch-action: none` so the browser doesn't intercept
        // taps / swipes / long-press as scroll or text-selection
        // gestures — critical for tile clicks on touch devices.
        className="flex-1 w-full bg-emerald-900 overflow-hidden"
        style={{ touchAction: "none" }}
      />
    </div>
  );
}
