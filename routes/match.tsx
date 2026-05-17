import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { EyeOutlined } from "@ant-design/icons";
import { requireGameEnabled, getClientGameFlag } from "~/game/feature-gate";
import type { TableRenderer } from "~/game/client/pixi/TableRenderer";
import { useMatchStore, type MatchView } from "~/game/client/store";
import { GameWS } from "~/game/client/ws";
import { takeAutoStart, takeMatchDebug } from "~/game/client/debugSeed";
import { MatchSoundToggle } from "~/game/client/MatchSoundToggle";
import {
  LivePlayMenu,
  LIVE_PLAY_MENU_DEFAULTS,
  type LivePlayMenuFlags,
} from "~/game/client/LivePlayMenu";
import { installGameSoundBindings, playGameSound } from "~/game/client/sound";
import { rotateMatchView } from "~/game/replay/player";
import type { RoomState } from "~/game/protocol/messages";
import { useLocale } from "~/contexts/LocaleContext";
import chipIconUrl from "~/game/client/icons/chips.png";
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
 * Buu multi-game session continue-vote overlay. Renders a dim
 * modal asking "Continue with another game?" after a `match_end`
 * when the server opens a vote window (Buu mode only). Shows the
 * four per-seat vote chips so each player can see who's pending
 * vs. yes/no, plus a wall-clock countdown. The local human votes
 * via the YES / NO buttons (idempotent on the wire). Once the
 * server resolves the window the overlay disappears
 * automatically — either via `match_start` (unanimous yes) or
 * `session_end` (any no / timeout).
 */
function SessionVoteOverlay({
  sessionVote,
  mySeat,
  seatNames,
  onVote,
}: {
  sessionVote: {
    deadline: number;
    votes: Array<"yes" | "no" | null>;
    gameIndex: number;
  } | null;
  mySeat: number | null;
  seatNames: [string, string, string, string] | null;
  onVote: (vote: "yes" | "no") => void;
}) {
  const [remainingMs, setRemainingMs] = useState<number>(() =>
    sessionVote ? Math.max(0, sessionVote.deadline - Date.now()) : 0
  );
  useEffect(() => {
    if (!sessionVote) {
      return;
    }
    let frame: number;
    const loop = () => {
      const ms = Math.max(0, sessionVote.deadline - Date.now());
      setRemainingMs(ms);
      if (ms > 0) {
        frame = requestAnimationFrame(loop);
      }
    };
    frame = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [sessionVote]);

  if (!sessionVote) {
    return null;
  }

  const names: [string, string, string, string] = seatNames ?? [
    "P1",
    "P2",
    "P3",
    "P4",
  ];
  const seconds = Math.ceil(remainingMs / 1000);
  const myVote = mySeat !== null ? sessionVote.votes[mySeat] : null;

  return (
    <div className="pointer-events-auto absolute inset-0 z-[110] flex items-center justify-center bg-black/55">
      <div className="relative flex flex-col items-center justify-center gap-5 rounded-xl border border-amber-400/60 bg-black/90 px-10 py-7 shadow-2xl">
        <div className="text-xs uppercase tracking-widest text-amber-300/80">
          Game {sessionVote.gameIndex + 1} complete
        </div>
        <div className="text-lg font-semibold text-white">
          Play another East game?
        </div>
        <div className="flex gap-3">
          {[0, 1, 2, 3].map((s) => {
            const v = sessionVote.votes[s];
            const color =
              v === "yes"
                ? "border-emerald-400/70 text-emerald-200 bg-emerald-500/15"
                : v === "no"
                  ? "border-rose-400/70 text-rose-200 bg-rose-500/15"
                  : "border-white/30 text-white/70 bg-white/5";
            return (
              <div
                key={s}
                className={`min-w-20 rounded border px-2 py-1 text-center text-xs ${color}`}
              >
                <div className="truncate font-medium">{names[s]}</div>
                <div className="mt-0.5 text-[0.7rem] tracking-widest">
                  {v === "yes" ? "YES" : v === "no" ? "NO" : "…"}
                </div>
              </div>
            );
          })}
        </div>
        {mySeat !== null && (
          <div className="flex gap-3">
            <button
              type="button"
              onClick={() => {
                onVote("yes");
              }}
              disabled={myVote === "yes"}
              className="rounded bg-emerald-500 px-5 py-1.5 text-base font-bold text-black shadow disabled:cursor-default disabled:bg-emerald-800 disabled:text-emerald-300"
            >
              YES
            </button>
            <button
              type="button"
              onClick={() => {
                onVote("no");
              }}
              disabled={myVote === "no"}
              className="rounded bg-rose-500 px-5 py-1.5 text-base font-bold text-black shadow disabled:cursor-default disabled:bg-rose-800 disabled:text-rose-300"
            >
              NO
            </button>
          </div>
        )}
        <div className="font-mono text-sm text-amber-200">{seconds}s</div>
      </div>
    </div>
  );
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
  chips,
  buuMode,
  resultPanelBounds,
  onReady,
}: {
  readyCheck: {
    deadline: number;
    acked: [boolean, boolean, boolean, boolean];
  } | null;
  mySeat: number | null;
  seatNames: [string, string, string, string] | null;
  chips: [number, number, number, number] | null;
  buuMode: boolean;
  resultPanelBounds: { x: number; y: number; w: number; h: number } | null;
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

  // Compact variant: when the renderer is showing a hand-result
  // panel (post-hand ready check), pin the OK button + countdown
  // Compact variant: when the renderer is showing a hand-result
  // panel (post-hand ready check), pin the OK button + countdown
  // to the bottom-right corner of that panel. We stop event
  // propagation so the parent container's press-to-hide handler
  // doesn't swallow the click.
  if (resultPanelBounds) {
    return (
      <div
        className="pointer-events-auto absolute z-[100] flex items-center gap-3 rounded-lg border border-emerald-500/60 bg-black/85 px-4 py-2 shadow-2xl"
        style={{
          left: resultPanelBounds.x + resultPanelBounds.w - 8,
          top: resultPanelBounds.y + resultPanelBounds.h - 8,
          transform: "translate(-100%, -100%)",
        }}
        onMouseDown={(e) => {
          e.stopPropagation();
        }}
        onTouchStart={(e) => {
          e.stopPropagation();
        }}
      >
        <button
          type="button"
          disabled={humanAcked}
          onClick={() => {
            if (!humanAcked) {
              onReady();
            }
          }}
          className="rounded bg-emerald-500 px-4 py-1.5 text-base font-bold text-black shadow disabled:cursor-default disabled:bg-emerald-800 disabled:text-emerald-300"
        >
          {humanAcked ? "READY" : "OK"}
        </button>
        <div className="font-mono text-base text-emerald-200">{seconds}s</div>
      </div>
    );
  }

  const seatLabel = (seat: 0 | 1 | 2 | 3) => (
    <span
      className={
        readyCheck.acked[seat]
          ? "flex flex-col items-center text-emerald-300 font-semibold"
          : "flex flex-col items-center text-white/80"
      }
    >
      <span>
        {names[seat]}
        {readyCheck.acked[seat] ? " ✓" : ""}
      </span>
      {buuMode && chips ? (
        <span className="mt-1 inline-flex items-center gap-1.5 font-mono font-bold text-amber-300">
          <img
            src={chipIconUrl}
            alt=""
            width={28}
            height={28}
            className="inline-block"
            style={{ imageRendering: "auto" }}
          />
          <span className="text-[26px] leading-none">{chips[seat]}</span>
        </span>
      ) : null}
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
  const navigate = useNavigate();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const rendererRef = useRef<TableRenderer | null>(null);
  const wsRef = useRef<GameWS | null>(null);

  const view = useMatchStore();
  const { t } = useLocale();

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
  // Live-play options menu state. Starts at
  // {@link LIVE_PLAY_MENU_DEFAULTS} on every page load — no
  // persistence — and round-trips with the renderer so a
  // manual drag flipping `autoSort` off updates the menu UI.
  const [liveMenuFlags, setLiveMenuFlags] = useState<LivePlayMenuFlags>(
    LIVE_PLAY_MENU_DEFAULTS
  );
  const handleLiveMenuChange = useCallback((next: LivePlayMenuFlags) => {
    setLiveMenuFlags((prev) => {
      if (next.autoSort !== prev.autoSort && rendererRef.current !== null) {
        rendererRef.current.setAutoSort(next.autoSort);
      }
      return next;
    });
  }, []);
  // Dedupe ref for auto-action dispatch: tracks the last
  // legal-action id we fired so the effect doesn't re-fire on
  // unrelated store mutations that arrive before the server's
  // ack clears `legalActions`.
  const lastAutoActedIdRef = useRef<string | null>(null);
  useEffect(() => {
    const ws = wsRef.current;
    if (!ws) {
      return;
    }
    if (view.mySeat === null) {
      return;
    }
    const actions = view.legalActions;
    if (actions.length === 0) {
      lastAutoActedIdRef.current = null;
      return;
    }
    const fire = (id: string): void => {
      if (lastAutoActedIdRef.current === id) {
        return;
      }
      lastAutoActedIdRef.current = id;
      ws.act(id);
    };
    const hasWin = actions.some((a) => a.type === "ron" || a.type === "tsumo");
    // 1) Auto-win — fires regardless of other flags so a player
    //    never misses a ron / tsumo.
    if (liveMenuFlags.autoWin) {
      const win = actions.find((a) => a.type === "ron" || a.type === "tsumo");
      if (win) {
        fire(win.id);
        return;
      }
    }
    // 2) No-calls — pass on any chi / pon / daiminkan decision
    //    window. Suppressed when a win is also available so the
    //    player doesn't unintentionally skip a ron alongside.
    if (liveMenuFlags.noCall && !hasWin) {
      const hasCall = actions.some(
        (a) =>
          a.type === "chi" ||
          a.type === "pon" ||
          (a.type === "kan" && a.kanKind === "daiminkan")
      );
      const pass = actions.find((a) => a.type === "pass");
      if (hasCall && pass) {
        fire(pass.id);
        return;
      }
    }
    // 3) Auto-discard — tsumogiri the drawn tile. Suppressed
    //    when a win is available (don't dump a winning tile).
    if (liveMenuFlags.autoDiscard && !hasWin) {
      const mySeat = view.mySeat;
      if (view.freshlyDrawnSeat !== mySeat) {
        return;
      }
      const hand = view.hands[mySeat] ?? [];
      const drawn = hand[hand.length - 1];
      if (!drawn) {
        return;
      }
      const discard = actions.find(
        (a) => a.type === "discard" && a.tile === drawn
      );
      if (discard) {
        useMatchStore
          .getState()
          .setPendingDiscard({ seat: mySeat, tile: drawn });
        fire(discard.id);
      }
    }
  }, [
    view.legalActions,
    view.mySeat,
    view.hands,
    view.freshlyDrawnSeat,
    liveMenuFlags.autoWin,
    liveMenuFlags.noCall,
    liveMenuFlags.autoDiscard,
  ]);
  // Canvas-pixel centre of the focused seat's discard pond,
  // published by the renderer. Used to anchor the post-hand
  // "peek" eye button to the middle of the pond.
  const [pondCenter, setPondCenter] = useState<{ x: number; y: number } | null>(
    null
  );

  // Canvas-pixel rect of the currently-visible result panel,
  // published by the renderer. Used to anchor the post-hand
  // ready-check OK button to the bottom-right of the win panel.
  const [resultPanelBounds, setResultPanelBounds] = useState<{
    x: number;
    y: number;
    w: number;
    h: number;
  } | null>(null);

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

  // Auto-start: the lobby's "Start solo match" button sets a
  // per-tab flag so the match route fires `startMatch()` as soon
  // as the first `room_state` arrives — no extra click needed.
  // The flag is one-shot: consumed on the first observation, so a
  // reconnect into a "playing" room won't re-fire it.
  const autoStartArmedRef = useRef<boolean | null>(null);
  useEffect(() => {
    if (autoStartArmedRef.current === null) {
      autoStartArmedRef.current = takeAutoStart(matchId);
    }
    if (
      autoStartArmedRef.current &&
      view.roomState?.status === "waiting" &&
      wsRef.current
    ) {
      autoStartArmedRef.current = false;
      wsRef.current.startMatch();
    }
  }, [matchId, view.roomState]);

  // AFK self-report: 25s after each call/discard prompt arrives,
  // if the player hasn't clicked anything, send `afk: true` so
  // the server flips us to disconnected (skips all our open and
  // future windows). The timer resets every time a new legal-
  // action set arrives (which happens on every action of ours,
  // since the server echoes the post-act legals). Cleared when
  // legals go empty (off-turn) or we're already flagged
  // disconnected.
  const ownOccupant =
    view.mySeat !== null
      ? view.roomState?.seats[view.mySeat]?.occupant
      : undefined;
  const ownConnected =
    ownOccupant?.kind === "human" ? ownOccupant.connected !== false : true;
  useEffect(() => {
    if (
      view.mySeat === null ||
      view.legalActions.length === 0 ||
      !ownConnected
    ) {
      return;
    }
    const timer = setTimeout(() => {
      if (wsRef.current) {
        wsRef.current.sendAfk(true);
      }
    }, 25_000);
    return () => {
      clearTimeout(timer);
    };
  }, [view.legalActions, view.mySeat, ownConnected]);

  // Mount Pixi + WS once, tear down on unmount.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    let cancelled = false;

    // Reset store for this match; mySeat is unknown until the
    // server's first `room_state` / `snapshot` arrives.
    useMatchStore.getState().setMatch(matchId);

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
          renderer.setResultPanelBoundsListener((rect) => {
            setResultPanelBounds(rect);
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
            const v = useMatchStore.getState();
            renderer.render(
              v.mySeat != null && v.mySeat !== 0
                ? rotateMatchView(v, v.mySeat)
                : v
            );
          });
          // Sync live-play menu's "Auto sort" preference into
          // the renderer at mount, and listen for engine-driven
          // flips (e.g. the player drags a tile → auto-sort
          // turns off) so the menu indicator stays accurate.
          renderer.setOnAutoSortChange((on) => {
            setLiveMenuFlags((prev) => {
              if (prev.autoSort === on) {
                return prev;
              }
              return { ...prev, autoSort: on };
            });
          });
          renderer.setAutoSort(LIVE_PLAY_MENU_DEFAULTS.autoSort);
          // Initial draw with whatever the store currently holds.
          const v0 = useMatchStore.getState();
          renderer.render(
            v0.mySeat != null && v0.mySeat !== 0
              ? rotateMatchView(v0, v0.mySeat)
              : v0
          );
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
      rendererRef.current.setCenterLabels({
        repeat: t.match.centerRepeat,
        riichi: t.match.centerRiichi,
        tiles: t.match.centerTiles,
      });
      rendererRef.current.setResultLabels({
        exhaustiveDraw: t.match.exhaustiveDraw,
        abortTitle: t.match.abortTitle,
        abortKinds: t.match.abortKinds,
        chomboTitle: t.match.chomboTitle,
        chomboReasons: t.match.chomboReasons,
      });
      // The Pixi renderer is seat-relative — it always paints
      // seat 0 at the bottom. Rotate the live view so the
      // human's actual seat lands there (replays already do the
      // same in their projector).
      const rendered =
        view.mySeat != null && view.mySeat !== 0
          ? rotateMatchView(view, view.mySeat)
          : view;
      rendererRef.current.render(rendered);
    }
  }, [view, eyeHeld, livePressed, stashedResult, t]);

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
        {/* Reconnect overlay: shown whenever the server has
            flagged this seat as disconnected (network loss or a
            previous AFK self-report). The button sends
            `afk: false` to opt back in; pending action windows
            stay defaulted but future ones wait normally again. */}
        {view.mySeat !== null && !ownConnected && !view.matchEnded && (
          <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/65 pointer-events-auto">
            <div className="flex flex-col items-center gap-4 rounded-xl border border-amber-500/50 bg-emerald-950/95 px-8 py-6 shadow-2xl">
              <div className="text-amber-300 text-lg font-semibold">
                Disconnected
              </div>
              <div className="text-emerald-100/80 text-sm text-center max-w-xs">
                Your actions are being auto-skipped. Click reconnect to resume
                playing.
              </div>
              <button
                type="button"
                onClick={() => {
                  if (wsRef.current) {
                    wsRef.current.sendAfk(false);
                  }
                }}
                className="px-5 py-2 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-emerald-950 font-bold shadow"
              >
                Reconnect
              </button>
            </div>
          </div>
        )}
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
        {/* Left-side live-play options menu (semi-collapsible).
            UI only for now; behaviour wiring lands in a
            follow-up. */}
        <LivePlayMenu flags={liveMenuFlags} onChange={handleLiveMenuChange} />
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
          chips={view.chips}
          buuMode={view.buuMode}
          resultPanelBounds={view.lastHandResult ? resultPanelBounds : null}
          onReady={() => {
            wsRef.current?.ready();
          }}
        />
        <SessionVoteOverlay
          sessionVote={view.sessionVote}
          mySeat={view.mySeat}
          seatNames={view.seatNames}
          onVote={(vote) => {
            wsRef.current?.voteContinue(vote);
          }}
        />
        <WaitingRoomOverlay
          matchId={matchId}
          roomState={view.roomState}
          onStart={() => {
            wsRef.current?.startMatch();
          }}
          onLeave={() => {
            // Tell the server to release the seat, then bounce back
            // to the lobby. `releaseSeat` nulls our socket before
            // broadcasting the new room_state, so we'd never see
            // the update anyway — navigating away closes the
            // socket and unmounts the route cleanly.
            wsRef.current?.leaveSeat();
            void navigate("/lobby");
          }}
        />
      </div>
    </div>
  );
}

/**
 * Pre-match waiting-room overlay. Shown while the server reports
 * `status === "waiting"`. Lists the four seats with their current
 * occupants (you / friend / bot / empty), a "Start match" button
 * that fills empties with bots and begins the ready check, and a
 * "Leave seat" button. The match URL is exposed for sharing.
 *
 * Hidden in `playing` / `finished` status so the canvas takes
 * over without interference.
 */
function WaitingRoomOverlay({
  matchId,
  roomState,
  onStart,
  onLeave,
}: {
  matchId: string;
  roomState: RoomState | null;
  onStart: () => void;
  onLeave: () => void;
}) {
  const [copied, setCopied] = useState(false);

  if (!roomState || roomState.status !== "waiting") {
    return null;
  }

  const shareUrl =
    typeof window !== "undefined" ? window.location.href : matchId;

  const handleCopy = (): void => {
    if (typeof navigator === "undefined" || !navigator.clipboard) {
      return;
    }
    void navigator.clipboard
      .writeText(shareUrl)
      .then(() => {
        setCopied(true);
        setTimeout(() => {
          setCopied(false);
        }, 1500);
      })
      .catch(() => {
        // Clipboard blocked — the URL is visible in the address
        // bar so this is a soft failure.
      });
  };

  return (
    <div className="pointer-events-auto absolute inset-0 z-[120] flex items-center justify-center bg-black/70">
      <div className="flex w-[min(420px,90vw)] flex-col gap-4 rounded-xl border border-emerald-500/40 bg-emerald-950 px-6 py-6 shadow-2xl">
        <header>
          <h2 className="text-xl font-bold text-emerald-100">Waiting room</h2>
          <p className="text-sm text-emerald-300/80">
            Share this URL with friends to fill seats — or hit Start to play
            against bots.
          </p>
        </header>

        <div className="flex items-center gap-2">
          <input
            type="text"
            readOnly
            value={shareUrl}
            className="flex-1 rounded border border-emerald-700 bg-emerald-900/60 px-3 py-2 font-mono text-xs text-emerald-100"
            onFocus={(e) => {
              e.currentTarget.select();
            }}
          />
          <button
            type="button"
            onClick={handleCopy}
            className="rounded bg-emerald-700 px-3 py-2 text-xs font-semibold text-white hover:bg-emerald-600"
          >
            {copied ? "Copied" : "Copy"}
          </button>
        </div>

        <ul className="flex flex-col gap-2">
          {roomState.seats.map((slot) => {
            const isMine = slot.seat === roomState.mySeat;
            let label: string;
            let tone: string;
            if (slot.occupant.kind === "empty") {
              label = "Empty seat";
              tone = "text-emerald-300/60 italic";
            } else if (slot.occupant.kind === "bot") {
              label = `${slot.occupant.displayName} (bot)`;
              tone = "text-amber-200";
            } else {
              const conn = slot.occupant.connected ? "" : " · offline";
              label = `${slot.occupant.displayName}${conn}`;
              tone = slot.occupant.connected
                ? "text-sky-200"
                : "text-sky-300/50";
            }
            return (
              <li
                key={slot.seat}
                className={`flex items-center justify-between rounded border px-3 py-2 ${
                  isMine
                    ? "border-emerald-400 bg-emerald-900/50"
                    : "border-emerald-800/60 bg-emerald-900/20"
                }`}
              >
                <span className="font-mono text-xs text-emerald-300/80">
                  seat {slot.seat}
                </span>
                <span className={`text-sm ${tone}`}>
                  {isMine ? "You · " : ""}
                  {label}
                </span>
              </li>
            );
          })}
        </ul>

        <div className="flex gap-2 pt-2">
          <button
            type="button"
            onClick={onStart}
            className="flex-1 rounded bg-emerald-500 px-4 py-2 font-semibold text-black hover:bg-emerald-400"
          >
            Start match
          </button>
          <button
            type="button"
            onClick={onLeave}
            className="rounded border border-emerald-700 px-4 py-2 text-sm font-semibold text-emerald-200 hover:bg-emerald-900"
          >
            Leave
          </button>
        </div>
      </div>
    </div>
  );
}
