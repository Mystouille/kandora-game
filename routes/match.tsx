import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { EyeOutlined } from "@ant-design/icons";
import { requireGameEnabled, getClientGameFlag } from "~/game/feature-gate";
import type { TableRenderer } from "~/game/client/pixi/TableRenderer";
import { useMatchStore, type MatchView } from "~/game/client/store";
import { GameWS } from "~/game/client/ws";
import { takeMatchDebug } from "~/game/client/debugSeed";
import { MatchSoundToggle } from "~/game/client/MatchSoundToggle";
import { installGameSoundBindings, playGameSound } from "~/game/client/sound";
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

/**
 * Pre-match ready-check overlay. Renders a centred dark panel
 * with the four seat names anchored to the panel's edges by
 * absolute position (mySeat = bottom), a big GO button for the
 * human, and a "Xs" countdown driven by `readyCheck.deadline`.
 * Plays the `game-start-tick` SFX on every full-second crossing.
 */
function ReadyCheckOverlay({
  readyCheck,
  mySeat,
  seatNames,
  onReady,
}: {
  readyCheck: {
    deadline: number;
    acked: [boolean, boolean, boolean, boolean];
  } | null;
  mySeat: number | null;
  seatNames: [string, string, string, string] | null;
  onReady: () => void;
}) {
  const [remainingMs, setRemainingMs] = useState<number>(() =>
    readyCheck ? Math.max(0, readyCheck.deadline - Date.now()) : 0
  );
  // Last full-second already ticked; -1 forces a tick on the
  // first render that the overlay is visible (e.g. "5s" tick).
  const lastTickRef = useRef<number>(-1);

  useEffect(() => {
    if (!readyCheck) {
      lastTickRef.current = -1;
      return;
    }
    lastTickRef.current = -1;
    let frame: number;
    const loop = () => {
      const ms = Math.max(0, readyCheck.deadline - Date.now());
      setRemainingMs(ms);
      const secs = Math.ceil(ms / 1000);
      if (secs > 0 && secs !== lastTickRef.current) {
        lastTickRef.current = secs;
        playGameSound("game-start-tick");
      }
      if (ms > 0) {
        frame = requestAnimationFrame(loop);
      }
    };
    frame = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [readyCheck]);

  if (!readyCheck || mySeat === null) {
    return null;
  }

  const names: [string, string, string, string] = seatNames ?? [
    "P1",
    "P2",
    "P3",
    "P4",
  ];
  // Resolve absolute seats by visible position (bottom = mySeat,
  // right = mySeat+1, etc.). Mirrors the renderer's seat layout.
  const bottomSeat = mySeat as 0 | 1 | 2 | 3;
  const rightSeat = ((mySeat + 1) % 4) as 0 | 1 | 2 | 3;
  const topSeat = ((mySeat + 2) % 4) as 0 | 1 | 2 | 3;
  const leftSeat = ((mySeat + 3) % 4) as 0 | 1 | 2 | 3;

  const seconds = Math.ceil(remainingMs / 1000);
  const humanAcked = readyCheck.acked[mySeat as 0 | 1 | 2 | 3];

  const seatLabel = (seat: 0 | 1 | 2 | 3) => (
    <span
      className={
        readyCheck.acked[seat]
          ? "text-emerald-300 font-semibold"
          : "text-white/80"
      }
    >
      {names[seat]}
      {readyCheck.acked[seat] ? " ✓" : ""}
    </span>
  );

  return (
    <div className="pointer-events-auto absolute inset-0 z-[100] flex items-center justify-center bg-black/40">
      <div
        className="relative flex flex-col items-center justify-center gap-4 rounded-xl border border-emerald-500/40 bg-black/85 px-10 py-8 shadow-2xl"
        style={{ minWidth: 360, minHeight: 220 }}
      >
        <div className="absolute left-1/2 top-2 -translate-x-1/2 text-sm">
          {seatLabel(topSeat)}
        </div>
        <div className="absolute right-2 top-1/2 -translate-y-1/2 text-sm">
          {seatLabel(rightSeat)}
        </div>
        <div className="absolute left-1/2 bottom-2 -translate-x-1/2 text-sm">
          {seatLabel(bottomSeat)}
        </div>
        <div className="absolute left-2 top-1/2 -translate-y-1/2 text-sm">
          {seatLabel(leftSeat)}
        </div>
        <button
          type="button"
          disabled={humanAcked}
          onClick={() => {
            if (!humanAcked) {
              onReady();
            }
          }}
          className="rounded-lg bg-emerald-500 px-8 py-3 text-2xl font-bold text-black shadow disabled:cursor-default disabled:bg-emerald-800 disabled:text-emerald-300"
        >
          {humanAcked ? "READY" : "GO"}
        </button>
        <div className="font-mono text-base text-emerald-200">{seconds}s</div>
      </div>
    </div>
  );
}

export default function GameMatchRoute({ loaderData }: Route.ComponentProps) {
  const { matchId } = loaderData;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const rendererRef = useRef<TableRenderer | null>(null);
  const wsRef = useRef<GameWS | null>(null);

  const view = useMatchStore();

  // Eye-button state: after the hand-result auto-advance clears
  // `view.lastHandResult`, we keep the most recent result around
  // so the player can press-and-hold the eye button to peek at
  // it. Cleared when the player has discarded twice in the new
  // hand (they've moved on) or a fresh hand ends (the new result
  // becomes the active one).
  const [stashedResult, setStashedResult] = useState<NonNullable<
    MatchView["lastHandResult"]
  > | null>(null);
  const [stashDiscardBaseline, setStashDiscardBaseline] = useState<
    number | null
  >(null);
  const [eyeHeld, setEyeHeld] = useState(false);
  // While the live win-info panel is showing
  // (`view.lastHandResult` non-null), pressing anywhere on the
  // canvas hides it; releasing brings it back. Mirrors the
  // replay route's annotation-overlay press-to-hide pattern.
  const [livePressed, setLivePressed] = useState(false);
  // Canvas-pixel centre of the focused seat's discard pond,
  // published by the renderer. Used to anchor the post-hand
  // "peek" eye button to the middle of the pond.
  const [pondCenter, setPondCenter] = useState<{ x: number; y: number } | null>(
    null
  );

  // Stash the active hand result the moment it arrives — keeps a
  // copy that survives the next `hand_start` clearing the store.
  // Baseline is intentionally cleared here: `hand_start` resets
  // `view.discards[mySeat]` to `[]`, so capturing the previous
  // hand's discard count would be wrong. The "two new discards"
  // baseline is taken in the effect below, on the first tick
  // after the live panel clears (i.e. once the new hand's
  // discard array is in scope).
  useEffect(() => {
    if (view.lastHandResult) {
      setStashedResult(view.lastHandResult);
      setStashDiscardBaseline(null);
    }
  }, [view.lastHandResult]);

  // Drop the stash (hides the eye button) once the player has
  // discarded twice in the new hand. A fresh `lastHandResult`
  // overrides via the effect above, so no extra clean-up needed
  // for the "new hand_end" branch.
  useEffect(() => {
    if (stashedResult === null || view.mySeat === null) {
      return;
    }
    if (view.lastHandResult) {
      // Still in the live win-info phase; baseline gets taken
      // once it clears.
      return;
    }
    const current = view.discards[view.mySeat].length;
    if (stashDiscardBaseline === null) {
      setStashDiscardBaseline(current);
      return;
    }
    if (current - stashDiscardBaseline >= 2) {
      setStashedResult(null);
      setStashDiscardBaseline(null);
    }
  }, [
    view.discards,
    view.mySeat,
    view.lastHandResult,
    stashedResult,
    stashDiscardBaseline,
  ]);

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

    // Sound bindings subscribe to the store's game-event bus. Scoped
    // to the match-route lifecycle so SFX only fire while a match
    // is mounted.
    const uninstallSound = installGameSoundBindings();

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
          renderer.setPondCenterListener((pt) => {
            setPondCenter(pt);
          });
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
      }
    );

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

    // Right-click on the canvas → pass (during a call window) or
    // tsumogiri (discard the freshly-drawn tile). Always suppress
    // the browser context menu so the gesture is reliable. Lives
    // here (not on the renderer) because the dispatch needs the
    // store snapshot + the live WS handle.
    const onContextMenu = (e: MouseEvent): void => {
      e.preventDefault();
      const ws = wsRef.current;
      if (!ws) {
        return;
      }
      const state = useMatchStore.getState();
      const legals = state.legalActions;
      const pass = legals.find((a) => a.type === "pass");
      if (pass) {
        ws.act(pass.id);
        return;
      }
      // Tsumogiri shortcut: the freshly-drawn tile is the last
      // entry in the player's hand. Find the matching legal
      // discard and fire it.
      const mySeat = state.mySeat;
      if (mySeat === null || state.freshlyDrawnSeat !== mySeat) {
        return;
      }
      const hand = state.hands[mySeat] ?? [];
      const drawn = hand[hand.length - 1];
      if (!drawn) {
        return;
      }
      const discard = legals.find(
        (a) => a.type === "discard" && a.tile === drawn
      );
      if (discard) {
        state.setPendingDiscard({ seat: mySeat, tile: drawn });
        ws.act(discard.id);
      }
    };
    container.addEventListener("contextmenu", onContextMenu);

    return () => {
      cancelled = true;
      uninstallSound();
      container.removeEventListener("contextmenu", onContextMenu);
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
      // Live press-to-hide: while the win-info panel is on screen
      // and the user is holding the canvas down, suppress the
      // panel; otherwise either show the live result, the
      // peek-override, or nothing.
      const liveActive = !!view.lastHandResult && !view.matchEnded;
      const suppressLive = liveActive && livePressed;
      rendererRef.current.setShowHandResult(!suppressLive);
      rendererRef.current.setHandResultOverride(
        eyeHeld && !view.lastHandResult ? stashedResult : null
      );
      rendererRef.current.render(view);
    }
  }, [view, eyeHeld, livePressed, stashedResult]);

  // Global mouseup / touchend so the press-to-hide gesture
  // releases even if the cursor leaves the canvas mid-press.
  useEffect(() => {
    if (!livePressed) {
      return;
    }
    const release = () => {
      setLivePressed(false);
    };
    window.addEventListener("mouseup", release);
    window.addEventListener("touchend", release);
    return () => {
      window.removeEventListener("mouseup", release);
      window.removeEventListener("touchend", release);
    };
  }, [livePressed]);

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
      <div
        ref={containerRef}
        // `touch-action: none` so the browser doesn't intercept
        // taps / swipes / long-press as scroll or text-selection
        // gestures — critical for tile clicks on touch devices.
        className="relative flex-1 w-full bg-emerald-900 overflow-hidden"
        style={{ touchAction: "none" }}
        onMouseDown={() => {
          // Live press-to-hide: only engage while a win-info
          // panel is actually on screen, so normal clicks (tile
          // discards, action buttons) aren't affected outside
          // the result phase.
          if (view.lastHandResult && !view.matchEnded) {
            setLivePressed(true);
          }
        }}
        onTouchStart={() => {
          if (view.lastHandResult && !view.matchEnded) {
            setLivePressed(true);
          }
        }}
      >
        {/* Match id pinned above the Pixi debug HUD (which renders
            at design-pixel (16,16) inside the canvas). DOM overlay
            so the value is selectable / copy-pasteable for bug
            reports. */}
        <span className="pointer-events-none absolute top-0 left-4 font-mono text-[10px] text-emerald-100/70 select-text">
          match {matchId}
        </span>
        {/* Top-right controls: sound toggle + close. Absolutely
            positioned so the canvas occupies the full container;
            `pointer-events: auto` on the wrapper so clicks land
            (the outer overlay disables touch gestures on the
            canvas itself). */}
        <div className="absolute top-2 right-2 flex items-center gap-2 pointer-events-auto">
          <MatchSoundToggle />
          <Link
            to="/lobby"
            className="px-3 py-1.5 rounded bg-emerald-800/90 hover:bg-emerald-700 text-white text-xs font-semibold transition-colors shadow"
          >
            Close
          </Link>
        </div>
        {/* Post-hand peek eye — anchored to the centre of the
            focused seat's discard pond. Visible after the auto-
            advance clears `view.lastHandResult` until the player
            has discarded twice in the new hand. Press-and-hold:
            the previous panel re-appears while the eye is held. */}
        {stashedResult &&
          !view.lastHandResult &&
          !view.matchEnded &&
          pondCenter && (
            <button
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setEyeHeld(true);
              }}
              onMouseUp={(e) => {
                e.preventDefault();
                setEyeHeld(false);
              }}
              onMouseLeave={() => {
                setEyeHeld(false);
              }}
              onTouchStart={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setEyeHeld(true);
              }}
              onTouchEnd={(e) => {
                e.preventDefault();
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
        <ReadyCheckOverlay
          readyCheck={view.readyCheck}
          mySeat={view.mySeat}
          seatNames={view.seatNames}
          onReady={() => {
            wsRef.current?.ready();
          }}
        />
      </div>
    </div>
  );
}
