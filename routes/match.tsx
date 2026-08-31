import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import {
  CheckOutlined,
  DeleteOutlined,
  EyeOutlined,
  RobotOutlined,
} from "@ant-design/icons";
import type {
  SeatEnrichment,
  TableRenderer,
} from "~/game/client/pixi/TableRenderer";
import {
  subscribeToGameEvents,
  useMatchStore,
  type MatchView,
} from "~/game/client/store";
import {
  GameWS,
  GameWSConnectionDetailsError,
} from "~/game/client/ws";
import { findTileAction } from "~/game/client/discardActions";
import { takeAutoStart, takeMatchDebug } from "~/game/client/debugSeed";
import { MatchSoundToggle } from "~/game/client/MatchSoundToggle";
import { WebTableTopControls } from "~/game/client/WebTableTopControls";
import { ViewerList } from "~/game/components/ViewerList";
import {
  advancePostHandPeekDiscardCount,
  shouldHidePostHandPeek,
} from "~/game/client/postHandPeek";
import {
  LivePlayMenu,
  buildInitialLivePlayMenuFlags,
  resetEphemeralFlags,
  writePersistedAutoSort,
  type LivePlayMenuFlags,
} from "~/game/client/LivePlayMenu";
import {
  installGameSoundBindings,
  playGameCountdownSound,
} from "~/game/client/sound";
import {
  advanceReadyCheckTick,
  type ReadyCheckTickState,
} from "~/game/client/readyCheckCountdown";
import { findNoCallAutoPass } from "~/game/client/callPrompt";
import { writeWebTableLayoutMode } from "~/game/client/webTableLayoutPreference";
import { rotateHandResult, rotateMatchView } from "~/game/replay/player";
import type { Meld, RoomState } from "~/game/protocol/messages";
import { useLocale } from "~/contexts/LocaleContext";
import chipIconUrl from "~/game/client/icons/chips.png";
import dabukenIconUrl from "~/game/client/icons/dabuken.png";

const publicBasePath = import.meta.env.BASE_URL || "/";
const tntLogoBlackUrl = `${publicBasePath}banner/TNT_logo-BLACK.png`;
const tntLogoWhiteUrl = `${publicBasePath}banner/TNT_logo-WHITE.png`;

/**
 * Pause inserted between a draw event and the auto-fired
 * discard for the local seat when it is auto-discarding —
 * either because the `autoDiscard` live-play toggle is on, or
 * because the seat has declared riichi (tsumogiri-locked).
 * Mirrors the server's `DRAW_TO_DISCARD_DELAY_MS` so every
 * seat (auto-played or otherwise) shares the same cadence.
 */
const DRAW_TO_DISCARD_DELAY_MS = 700;

const DEBUG_PLAYER_NAME_POOL = [
  "Akari",
  "BambooFox",
  "Chihiro",
  "DoraNova",
  "Emi",
  "HakuStorm",
  "Junpei",
  "Kokoro",
  "Mika",
  "RiichiRonin",
  "Sora",
  "Yuzu",
];
const DEBUG_TEAM_NAME_POOL = [
  "Crimson Winds",
  "Jade Dragons",
  "Moon Rabbits",
  "Golden Tiles",
  "White Flowers",
  "North Stars",
];
const DEBUG_TEAM_LOGOS = [
  tntLogoBlackUrl,
  tntLogoWhiteUrl,
  chipIconUrl,
  dabukenIconUrl,
];

interface DebugIdentityFixture {
  seatNames: [string, string, string, string];
  seatEnrichment: [
    SeatEnrichment,
    SeatEnrichment,
    SeatEnrichment,
    SeatEnrichment,
  ];
}

let cachedDebugIdentityFixture: DebugIdentityFixture | null = null;

function shuffled<T>(values: readonly T[]): T[] {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index--) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  return result;
}

function getDebugIdentityFixture(): DebugIdentityFixture {
  if (cachedDebugIdentityFixture) {
    return cachedDebugIdentityFixture;
  }
  const names = shuffled(DEBUG_PLAYER_NAME_POOL).slice(0, 4) as [
    string,
    string,
    string,
    string,
  ];
  const teams = shuffled(DEBUG_TEAM_NAME_POOL).slice(0, 4);
  const logos = shuffled(DEBUG_TEAM_LOGOS);
  cachedDebugIdentityFixture = {
    seatNames: names,
    seatEnrichment: names.map((_, seat) => ({
      teamName: teams[seat],
      teamLogoUrl: logos[seat],
    })) as DebugIdentityFixture["seatEnrichment"],
  };
  return cachedDebugIdentityFixture;
}

function getDebugWallDice(search: URLSearchParams): [number, number] | null {
  const values = search.get("debugWallDice")?.split(",");
  if (!values || values.length !== 2) {
    return null;
  }
  const dice = values.map(Number);
  if (
    dice.some((value) => !Number.isInteger(value) || value < 1 || value > 6)
  ) {
    return null;
  }
  return [dice[0], dice[1]];
}

function hasDebugWallFixture(): boolean {
  if (!import.meta.env.DEV || typeof window === "undefined") {
    return false;
  }
  return getDebugWallDice(new URLSearchParams(window.location.search)) !== null;
}

function prepareRenderedMatchView(view: MatchView): MatchView {
  const rotated =
    view.mySeat != null && view.mySeat !== 0
      ? rotateMatchView(view, view.mySeat)
      : view;
  if (!import.meta.env.DEV || typeof window === "undefined") {
    return rotated;
  }

  const search = new URLSearchParams(window.location.search);
  const debugFourKans = search.get("debugFourKans") === "1";
  const debugFullDiscards = search.get("debugFullDiscards") === "1";
  const debugPlayerNames = search.get("debugPlayerNames") === "1";
  const debugTeamLogos = search.get("debugTeamLogos") === "1";
  const debugIdentity =
    debugPlayerNames || debugTeamLogos ? getDebugIdentityFixture() : null;
  const debugWallDice = getDebugWallDice(search);
  const debugWallDealerRaw = Number(search.get("debugWallDealer") ?? "0");
  const debugWallDealer = (
    Number.isInteger(debugWallDealerRaw) &&
    debugWallDealerRaw >= 0 &&
    debugWallDealerRaw <= 3
      ? debugWallDealerRaw
      : 0
  ) as 0 | 1 | 2 | 3;
  if (
    !debugFourKans &&
    !debugFullDiscards &&
    !debugIdentity &&
    !debugWallDice
  ) {
    return rotated;
  }

  const kanTiles = ["1m", "2p", "3s", "4z"];
  const melds: Meld[][] = Array.from({ length: 4 }, (_, seat) =>
    kanTiles.map((tile, index) => ({
      type: "daiminkan",
      tiles: [tile, tile, tile, tile],
      claimedTile: tile,
      from: ((seat + index + 1) % 4) as 0 | 1 | 2 | 3,
    }))
  );
  const discardTiles: MatchView["discards"][number] = [
    "1m",
    "2m",
    "3m",
    "4m",
    "5m",
    "6m",
    "7m",
    "8m",
    "9m",
    "1p",
    "2p",
    "3p",
    "4p",
    "5p",
    "6p",
    "7p",
    "8p",
    "9p",
    "1s",
    "2s",
  ];
  const discards = Array.from({ length: 4 }, () => [...discardTiles]);
  const discardTsumogiri = Array.from({ length: 4 }, () =>
    discardTiles.map(() => false)
  );
  const discardOrdinals = Array.from({ length: 4 }, (_, seat) =>
    discardTiles.map((_, index) => seat * discardTiles.length + index)
  );
  const wallTiles: MatchView["liveWall"] = Array.from(
    { length: 122 },
    (_, index) => `${(index % 9) + 1}${["m", "p", "s"][index % 3]}` as never
  );
  const deadWall: NonNullable<MatchView["deadWall"]> = [
    "1z",
    "2z",
    "3z",
    "4z",
    "5z",
    "6z",
    "7z",
    "1m",
    "2m",
    "3m",
    "4m",
    "5m",
    "6m",
    "7m",
  ];
  const debugKanCount = debugFourKans ? 4 : 0;
  const debugDoraIndicators = [5, 7, 9, 11, 13].map((index) => deadWall[index]);

  return {
    ...rotated,
    ...(debugIdentity && { seatNames: debugIdentity.seatNames }),
    ...(debugFourKans && {
      hands: [["5m"], [null], [null], [null]],
      melds,
      freshlyDrawnSeat: null,
    }),
    ...(debugFullDiscards && {
      discards,
      discardTsumogiri,
      discardOrdinals,
      totalDiscards: discardTiles.length * 4,
      riichiTileIdx: [null, null, null, null],
      freshlyDiscardedSeat: null,
    }),
    ...(debugWallDice && {
      dealer: debugWallDealer,
      dice: debugWallDice,
      liveWall: wallTiles,
      deadWall,
      doraIndicators: debugDoraIndicators.slice(0, debugKanCount + 1),
      drawsTaken: debugKanCount,
      liveDrawsTaken: 0,
      wallRemaining: 70 - debugKanCount,
    }),
  };
}

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
export interface GameMatchLoaderData {
  matchId: string;
  flag: { gameEnabled: boolean };
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
  const readyDeadline = readyCheck?.deadline ?? null;
  const [remainingMs, setRemainingMs] = useState<number>(() =>
    readyDeadline === null ? 0 : Math.max(0, readyDeadline - Date.now())
  );
  const lastTickRef = useRef<ReadyCheckTickState>({
    deadline: null,
    seconds: -1,
  });
  const [submittedDeadline, setSubmittedDeadline] = useState<number | null>(
    null
  );
  const humanAcked =
    readyCheck !== null && mySeat !== null
      ? readyCheck.acked[mySeat as 0 | 1 | 2 | 3]
      : false;
  const locallyReady =
    humanAcked ||
    (readyDeadline !== null && submittedDeadline === readyDeadline);

  useEffect(() => {
    if (readyDeadline === null) {
      setRemainingMs(0);
      return;
    }
    let frame: number;
    const loop = () => {
      const ms = Math.max(0, readyDeadline - Date.now());
      setRemainingMs(ms);
      if (ms > 0) {
        frame = requestAnimationFrame(loop);
      }
    };
    loop();
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [readyDeadline]);

  const seconds = Math.ceil(remainingMs / 1000);
  useEffect(() => {
    const tick = advanceReadyCheckTick(
      lastTickRef.current,
      readyDeadline,
      seconds,
      locallyReady
    );
    lastTickRef.current = tick.next;
    if (tick.play && mySeat !== null && readyDeadline !== null) {
      playGameCountdownSound(
        "game-start-tick",
        `ready:${readyDeadline}`,
        seconds
      );
    }
  }, [locallyReady, mySeat, readyDeadline, seconds]);

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
          disabled={locallyReady}
          onClick={() => {
            if (!locallyReady) {
              setSubmittedDeadline(readyDeadline);
              onReady();
            }
          }}
          className="rounded bg-emerald-500 px-4 py-1.5 text-base font-bold text-black shadow disabled:cursor-default disabled:bg-emerald-800 disabled:text-emerald-300"
        >
          {locallyReady ? "READY" : "OK"}
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
          disabled={locallyReady}
          onClick={() => {
            if (!locallyReady) {
              setSubmittedDeadline(readyDeadline);
              onReady();
            }
          }}
          className="flex flex-row items-center gap-2 rounded-lg bg-emerald-500 px-8 py-3 text-2xl font-bold text-black shadow disabled:cursor-default disabled:bg-emerald-800 disabled:text-emerald-300"
        >
          <span>{locallyReady ? "READY" : "GO"}</span>
          <span className="font-mono text-xs font-normal opacity-80">
            {seconds}s
          </span>
        </button>
      </div>
    </div>
  );
}

export default function GameMatchRoute({
  loaderData,
}: {
  loaderData: GameMatchLoaderData;
}) {
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
  const postHandDiscardCountRef = useRef(0);
  const [eyeHeld, setEyeHeld] = useState(false);
  const [showViewerList, setShowViewerList] = useState(true);
  // Live-play options menu state. `autoSort` is persisted to
  // `localStorage` and reloaded on every fresh mount; the other
  // three "auto play" flags (autoWin / noCall / autoDiscard)
  // are deliberately ephemeral and reset to `false` on every
  // hand boundary (see the `useEffect` below keyed on the
  // active hand identity).
  const [liveMenuFlags, setLiveMenuFlags] = useState<LivePlayMenuFlags>(
    buildInitialLivePlayMenuFlags
  );
  const noCallRef = useRef(liveMenuFlags.noCall);
  const handleLiveMenuChange = useCallback((next: LivePlayMenuFlags) => {
    noCallRef.current = next.noCall;
    setLiveMenuFlags((prev) => {
      if (next.autoSort !== prev.autoSort) {
        // Persist the autoSort preference so it survives both
        // hand boundaries and page reloads.
        writePersistedAutoSort(next.autoSort);
        if (rendererRef.current !== null) {
          rendererRef.current.setAutoSort(next.autoSort);
        }
      }
      if (next.autoWin !== prev.autoWin && rendererRef.current !== null) {
        // Mirror to the renderer so the on-canvas ron/tsumo
        // buttons disappear immediately when the toggle flips on.
        rendererRef.current.setAutoWinEnabled(next.autoWin);
      }
      if (next.noCall !== prev.noCall && rendererRef.current !== null) {
        rendererRef.current.setNoCallEnabled(next.noCall);
      }
      if (next.compactLayout !== prev.compactLayout) {
        const mode = next.compactLayout ? "compact" : "standard";
        writeWebTableLayoutMode(mode);
        rendererRef.current?.setWebTableLayoutMode(mode);
      }
      return next;
    });
  }, []);
  useEffect(() => {
    noCallRef.current = liveMenuFlags.noCall;
  }, [liveMenuFlags.noCall]);
  // Per-hand ephemeral-flag reset. Whenever the active hand
  // identity (round / honba / dealer) flips we clear autoWin,
  // noCall, and autoDiscard back to `false` so they only apply
  // for the hand the player explicitly enabled them on. The
  // `autoSort` preference is preserved.
  const handKey = `${view.roundWind}:${view.roundNumber}:${view.honba}:${view.dealer}`;
  useEffect(() => {
    noCallRef.current = false;
    setLiveMenuFlags((prev) => resetEphemeralFlags(prev));
  }, [handKey]);
  // Keep the renderer's autoWin mirror in sync with the live
  // menu state — covers the per-hand ephemeral reset above as
  // well as any other path that mutates `liveMenuFlags.autoWin`
  // without going through `handleLiveMenuChange` (e.g. future
  // bulk-reset buttons).
  useEffect(() => {
    if (rendererRef.current !== null) {
      rendererRef.current.setAutoWinEnabled(liveMenuFlags.autoWin);
    }
  }, [liveMenuFlags.autoWin]);
  useEffect(() => {
    if (rendererRef.current !== null) {
      rendererRef.current.setNoCallEnabled(liveMenuFlags.noCall);
    }
  }, [liveMenuFlags.noCall]);
  // Dedupe ref for auto-action dispatch: tracks the last
  // legal-action id we fired so the effect doesn't re-fire on
  // unrelated store mutations that arrive before the server's
  // ack clears `legalActions`.
  const lastAutoActedIdRef = useRef<string | null>(null);
  // Pending timer for the human auto-discard delay (riichi or
  // the `autoDiscard` toggle). Held in a ref so the effect can
  // cancel it whenever the legal-actions snapshot changes
  // before the timer fires (e.g. an interrupting ron window),
  // and so the unmount cleanup can clear it too.
  const autoDiscardTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  );
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
      if (autoDiscardTimerRef.current !== null) {
        clearTimeout(autoDiscardTimerRef.current);
        autoDiscardTimerRef.current = null;
      }
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
    const noCallPass = findNoCallAutoPass(actions, liveMenuFlags.noCall);
    if (noCallPass) {
      fire(noCallPass.id);
      return;
    }
    // 3) Auto-discard — tsumogiri the drawn tile. Triggered
    //    either by the `autoDiscard` toggle or because the seat
    //    is locked into tsumogiri by an active riichi. Suppressed
    //    when a win is available (don't dump a winning tile).
    //    Mirrors the shared draw→discard pacing so the table
    //    doesn't feel jarring when on autopilot: the discard
    //    is scheduled `DRAW_TO_DISCARD_DELAY_MS` after the
    //    draw, and the timer is cancelled if the legal-actions
    //    snapshot changes before it fires (e.g. an interrupting
    //    ron window for another seat clearing this seat's legals).
    const mySeat = view.mySeat;
    const inRiichi = view.riichiDeclared[mySeat];
    // Ankan stays interactive even on autopilot: in riichi the
    // player can still close-kan a freshly-drawn tile (subject
    // to wait-preservation rules the server enforces), and
    // under the manual autoDiscard toggle a closed kan is a
    // strategic choice we shouldn't swallow. So whenever an
    // ankan legal action is offered we skip the auto-tsumogiri
    // and let the player decide.
    const hasAnkan = actions.some(
      (a) => a.type === "kan" && a.kanKind === "ankan"
    );
    if ((liveMenuFlags.autoDiscard || inRiichi) && !hasWin && !hasAnkan) {
      if (view.freshlyDrawnSeat !== mySeat) {
        return;
      }
      const hand = view.hands[mySeat] ?? [];
      const drawn = hand[hand.length - 1];
      if (!drawn) {
        return;
      }
      const discard = findTileAction(actions, "discard", drawn, "draw");
      if (discard && lastAutoActedIdRef.current !== discard.id) {
        // If a previous timer is still pending (shouldn't happen
        // in practice — `legalActions` changing re-runs the
        // effect and clears it), drop it before scheduling a new
        // one so we never double-fire.
        if (autoDiscardTimerRef.current !== null) {
          clearTimeout(autoDiscardTimerRef.current);
        }
        autoDiscardTimerRef.current = setTimeout(() => {
          autoDiscardTimerRef.current = null;
          // Re-check the live store: another event could have
          // landed during the delay (ron window opening, hand
          // ending, etc.) and invalidated this discard.
          const live = useMatchStore.getState();
          if (live.mySeat !== mySeat) {
            return;
          }
          const stillLegal = live.legalActions.some((a) => a.id === discard.id);
          if (!stillLegal) {
            return;
          }
          live.setPendingDiscard({
            seat: mySeat,
            tile: drawn,
            displayIndex: hand.length - 1,
          });
          fire(discard.id);
        }, DRAW_TO_DISCARD_DELAY_MS);
      }
    }
  }, [
    view.legalActions,
    view.mySeat,
    view.hands,
    view.freshlyDrawnSeat,
    view.riichiDeclared,
    liveMenuFlags.autoWin,
    liveMenuFlags.noCall,
    liveMenuFlags.autoDiscard,
  ]);
  // Clear any pending auto-discard timer on unmount so it can't
  // fire against a closed `ws` or a stale store snapshot.
  useEffect(() => {
    return () => {
      if (autoDiscardTimerRef.current !== null) {
        clearTimeout(autoDiscardTimerRef.current);
        autoDiscardTimerRef.current = null;
      }
    };
  }, []);
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
  // Reset the monotonic event counter for this completed result;
  // `hand_start` resets it again before new-hand discards arrive.
  useEffect(() => {
    if (view.lastHandResult) {
      setStashedResult(
        view.mySeat !== null && view.mySeat !== 0
          ? rotateHandResult(view.lastHandResult, view.mySeat)
          : view.lastHandResult
      );
      postHandDiscardCountRef.current = 0;
    }
  }, [view.lastHandResult, view.mySeat]);

  // Count actual discard events rather than the visible pond length:
  // calls remove claimed tiles from `view.discards`, so pile length is
  // not monotonic and could leave the eye alive indefinitely.
  useEffect(() => {
    return subscribeToGameEvents(({ event, mySeat }) => {
      if (event.type === "hand_start") {
        postHandDiscardCountRef.current = 0;
        return;
      }
      postHandDiscardCountRef.current = advancePostHandPeekDiscardCount(
        postHandDiscardCountRef.current,
        event,
        mySeat
      );
      if (shouldHidePostHandPeek(postHandDiscardCountRef.current)) {
        setStashedResult(null);
        setEyeHeld(false);
      }
    });
  }, []);

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
      const room = view.roomState;
      const mySeat = room.mySeat;
      const ownSlot = mySeat === null ? null : room.seats[mySeat];
      if (mySeat === null || ownSlot?.occupant.kind !== "human") {
        return;
      }
      if (!ownSlot.ready) {
        wsRef.current.setWaitingRoomReady(true);
        return;
      }
      if (room.hostSeat === mySeat && room.canStart) {
        autoStartArmedRef.current = false;
        wsRef.current.startMatch();
      }
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
    const uninstallSound = installGameSoundBindings({
      isNoCallEnabled: () => noCallRef.current,
    });

    // Pixi.js touches `navigator` at module-eval time, so it must
    // only load in the browser. Dynamic-import keeps it out of the
    // SSR bundle.
    void import("~/game/client/pixi/TableRenderer").then(
      ({ TableRenderer }) => {
        if (cancelled) {
          return;
        }
        const renderer = new TableRenderer({
          webTableLayoutMode: liveMenuFlags.compactLayout
            ? "compact"
            : "standard",
        });
        renderer.setMinimumDrawToDiscardDelayEnabled(true);
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
          renderer.setOnTileClick(({ index, tile, discardSource }) => {
            // Optimistic discard for own seat; the server confirmation
            // (a `discard` event) will clear `pendingDiscard`.
            const state = useMatchStore.getState();
            if (state.mySeat === null) {
              return;
            }
            // Find the matching legal action and forward it.
            const legal = findTileAction(
              state.legalActions,
              "discard",
              tile,
              discardSource
            );
            if (legal && wsRef.current) {
              state.setPendingDiscard({
                seat: state.mySeat,
                tile,
                displayIndex: index,
              });
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
            // Optimistically clear our legal actions so the call
            // button strip disappears the instant the user clicks.
            // The next server snapshot will repopulate them if the
            // turn comes back around. Without this the strip lingers
            // visibly until the server's response round-trips
            // (especially noticeable on riichi / ron / tsumo).
            useMatchStore.getState().setLegalActions([]);
          });
          renderer.setOnRenderRequest(() => {
            // Renderer internal-state changes (e.g. riichi mode toggle)
            // need an explicit re-render — store state hasn't changed,
            // so the subscribe-driven loop won't fire.
            const v = useMatchStore.getState();
            renderer.render(prepareRenderedMatchView(v));
          });
          // Sync live-play menu's "Auto sort" preference into
          // the renderer at mount, and listen for engine-driven
          // flips (e.g. the player drags a tile → auto-sort
          // turns off) so the menu indicator stays accurate.
          // Engine-driven flips also persist so the next mount
          // reflects the player's last actually-used setting.
          renderer.setOnAutoSortChange((on) => {
            writePersistedAutoSort(on);
            setLiveMenuFlags((prev) => {
              if (prev.autoSort === on) {
                return prev;
              }
              return { ...prev, autoSort: on };
            });
          });
          // Initialise the renderer from the persisted preference
          // rather than the hardcoded default so a player who
          // turned auto-sort off on a previous session keeps it
          // off here.
          renderer.setAutoSort(liveMenuFlags.autoSort);
          renderer.setAutoWinEnabled(liveMenuFlags.autoWin);
          renderer.setNoCallEnabled(liveMenuFlags.noCall);
          const debugSearch = new URLSearchParams(window.location.search);
          renderer.setSeatEnrichment(
            import.meta.env.DEV && debugSearch.get("debugTeamLogos") === "1"
              ? getDebugIdentityFixture().seatEnrichment
              : []
          );
          renderer.setShowWallZonesDebug(
            debugSearch.get("debugWallZones") === "1"
          );
          renderer.setShowWalls(
            hasDebugWallFixture() && debugSearch.get("debugWallReveal") === "1"
          );
          renderer.setShowUndealtWall(hasDebugWallFixture());
          // Initial draw with whatever the store currently holds.
          const v0 = useMatchStore.getState();
          renderer.render(prepareRenderedMatchView(v0));
        });
      }
    );

    const ws = new GameWS({
      getConnectionDetails: async () => {
        // Mirror `~/utils/basePath` (the boundary rule blocks `~/utils/*`):
        // honor Vite's BASE_URL so this works when the app is mounted
        // under a non-root basename (e.g. `/kandora/` in `dev:remote`).
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
        return { wsUrl: fullUrl, token: session.token };
      },
      matchId,
      // Lobby may have stowed a debug seed under this matchId; sent
      // once in the `hello` frame and consumed by the game-server
      // on first attach.
      debug: takeMatchDebug(matchId),
      onMessage: (message) => {
        if (message.type === "spectate_redirect") {
          void navigate(
            `/spectate/${encodeURIComponent(message.matchId)}`,
            { replace: true }
          );
          return;
        }
        if (message.type === "room_kicked") {
          void navigate("/lobby", { replace: true });
        }
      },
    });
    wsRef.current = ws;
    ws.connect();

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
      const discard = findTileAction(legals, "discard", drawn, "draw");
      if (discard) {
        state.setPendingDiscard({
          seat: mySeat,
          tile: drawn,
          displayIndex: hand.length - 1,
        });
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
      rendererRef.current.render(prepareRenderedMatchView(view));
    }
  }, [view, eyeHeld, stashedResult, t]);

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
      >
        {/* Match id pinned above the Pixi debug HUD (which renders
            at design-pixel (16,16) inside the canvas). DOM overlay
            so the value is selectable / copy-pasteable for bug
            reports. */}
        <div className="absolute top-0 left-4 z-30 flex h-5 items-center gap-1 font-mono text-[10px] text-emerald-100/70">
          <span className="pointer-events-none select-text">
            match {matchId}
          </span>
        </div>
        <div className="pointer-events-none absolute bottom-2 left-4 top-5 z-30 flex items-start">
          <ViewerList
            viewers={view.viewers}
            expanded={showViewerList}
            onToggle={() => {
              setShowViewerList((visible) => !visible);
            }}
          />
        </div>
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
        {/* Transport-level disconnect overlay: shown whenever the
            WebSocket itself has dropped and the client is in the
            middle of (re)connecting. Distinct from the server-flag
            "Disconnected" overlay above — that one means the server
            has already marked us absent; this one means we lost the
            link before the server even noticed (silent TCP stall,
            wifi drop, mobile NAT timeout, browser sleep). The
            button cancels backoff and reconnects immediately. */}
        {view.mySeat !== null &&
          !view.matchEnded &&
          ownConnected &&
          (view.conn === "reconnecting" || view.conn === "connecting") &&
          view.lastSeq >= 0 && (
            <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/65 pointer-events-auto">
              <div className="flex flex-col items-center gap-4 rounded-xl border border-amber-500/50 bg-emerald-950/95 px-8 py-6 shadow-2xl">
                <div className="text-amber-300 text-lg font-semibold">
                  Connection lost
                </div>
                <div className="text-emerald-100/80 text-sm text-center max-w-xs">
                  Reconnecting… If the game stays frozen, click below to retry
                  now.
                </div>
                <button
                  type="button"
                  onClick={() => {
                    if (wsRef.current) {
                      wsRef.current.forceReconnect();
                    }
                  }}
                  className="px-5 py-2 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-emerald-950 font-bold shadow"
                >
                  Reconnect now
                </button>
              </div>
            </div>
          )}
        <WebTableTopControls
          compactLayout={liveMenuFlags.compactLayout}
          onCompactLayoutChange={(compactLayout) => {
            handleLiveMenuChange({ ...liveMenuFlags, compactLayout });
          }}
          onQuit={() => {
            if (view.roomState?.status === "waiting") {
              wsRef.current?.leaveSeat();
            }
            void navigate("/lobby");
          }}
          quitLabel={
            view.roomState?.status === "waiting"
              ? "Leave waiting room"
              : "Quit game"
          }
        >
          <MatchSoundToggle />
        </WebTableTopControls>
        {/* Left-side live-play options menu (semi-collapsible).
            UI only for now; behaviour wiring lands in a
            follow-up. */}
        <LivePlayMenu flags={liveMenuFlags} onChange={handleLiveMenuChange} />
        {/* Bottom-of-hand quick toggles: duplicates of "Auto win"
            and "No call" from the left drawer. Anchored at the
            horizontal centre of the canvas and extending to the
            right, so the row sits under the right half of the
            focused player's hand (which itself spans most of the
            centred play area). Mirror the drawer's expanded-row
            styling so the active state reads the same. */}
        <div className="pointer-events-auto absolute left-1/2 bottom-0 z-30 flex gap-2">
          {(["autoWin", "noCall"] as const).map((key) => {
            const label = key === "autoWin" ? "Auto win" : "No call";
            const letter = key === "autoWin" ? "W" : "C";
            const active = liveMenuFlags[key];
            const toggle = (): void => {
              handleLiveMenuChange({ ...liveMenuFlags, [key]: !active });
            };
            return (
              <button
                key={key}
                type="button"
                onClick={toggle}
                onContextMenu={(e) => {
                  e.preventDefault();
                  toggle();
                }}
                aria-pressed={active}
                className={
                  "h-7 flex items-center rounded text-xs font-semibold transition-colors shadow-lg border border-emerald-700/60 " +
                  (active
                    ? "bg-emerald-500 text-emerald-950 hover:bg-emerald-400"
                    : "bg-emerald-950/85 text-white hover:bg-emerald-800")
                }
              >
                <span className="w-7 h-7 flex items-center justify-center font-mono font-bold text-sm">
                  {letter}
                </span>
                <span className="pr-3">{label}</span>
              </button>
            );
          })}
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
          key={view.readyCheck?.deadline ?? "inactive"}
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
          onReadyChange={(ready) => {
            wsRef.current?.setWaitingRoomReady(ready);
          }}
          onAddBot={() => {
            wsRef.current?.addWaitingRoomBot();
          }}
          onKick={(seat) => {
            wsRef.current?.kickWaitingRoomSeat(seat);
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
 * The match URL is exposed for sharing; leaving is handled by the
 * persistent top-right quit control.
 *
 * Hidden in `playing` / `finished` status so the canvas takes
 * over without interference.
 */
function WaitingRoomOverlay({
  matchId,
  roomState,
  onStart,
  onReadyChange,
  onAddBot,
  onKick,
}: {
  matchId: string;
  roomState: RoomState | null;
  onStart: () => void;
  onReadyChange: (ready: boolean) => void;
  onAddBot: () => void;
  onKick: (seat: 0 | 1 | 2 | 3) => void;
}) {
  const [copied, setCopied] = useState(false);

  if (!roomState || roomState.status !== "waiting") {
    return null;
  }

  const shareUrl =
    typeof window !== "undefined" ? window.location.href : matchId;
  const isHost = roomState.mySeat === roomState.hostSeat;
  const ownSlot =
    roomState.mySeat === null ? null : roomState.seats[roomState.mySeat];
  const ownReady = ownSlot?.ready ?? false;
  const hasEmptySeat = roomState.seats.some(
    ({ occupant }) => occupant.kind === "empty"
  );

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
            Share this URL with friends, then ready up when the table is set.
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
            const isRoomHost = slot.seat === roomState.hostSeat;
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
                <div className="flex min-w-0 items-center gap-2">
                  <span className={`truncate text-sm ${tone}`}>
                    {isMine ? "You · " : ""}
                    {isRoomHost ? "Host · " : ""}
                    {label}
                  </span>
                  {slot.occupant.kind !== "empty" && (
                    <span
                      className={`shrink-0 text-xs font-semibold ${
                        slot.ready ? "text-emerald-300" : "text-slate-400"
                      }`}
                    >
                      {slot.ready ? "Ready" : "Not ready"}
                    </span>
                  )}
                  {isHost &&
                    !isMine &&
                    slot.occupant.kind !== "empty" && (
                      <button
                        type="button"
                        onClick={() => {
                          onKick(slot.seat);
                        }}
                        className="flex h-8 w-8 shrink-0 items-center justify-center rounded border border-red-500/50 text-red-200 hover:bg-red-950/60"
                        aria-label={`Kick ${label}`}
                        title={`Kick ${label}`}
                      >
                        <DeleteOutlined />
                      </button>
                    )}
                </div>
              </li>
            );
          })}
        </ul>

        <div className="flex flex-wrap gap-2 pt-2">
          <button
            type="button"
            onClick={() => {
              onReadyChange(!ownReady);
            }}
            aria-pressed={ownReady}
            className={`flex min-w-28 flex-1 items-center justify-center gap-2 rounded px-4 py-2 font-semibold ${
              ownReady
                ? "bg-emerald-500 text-black hover:bg-emerald-400"
                : "border border-emerald-600 text-emerald-100 hover:bg-emerald-900"
            }`}
          >
            <CheckOutlined />
            {ownReady ? "Ready" : "Ready up"}
          </button>
          {isHost && (
            <button
              type="button"
              onClick={onAddBot}
              disabled={!hasEmptySeat}
              className="flex items-center justify-center gap-2 rounded border border-amber-500/60 px-4 py-2 text-sm font-semibold text-amber-100 hover:bg-amber-950/50 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <RobotOutlined />
              Add bot
            </button>
          )}
          {isHost && (
            <button
              type="button"
              onClick={onStart}
              disabled={!roomState.canStart}
              className="min-w-28 flex-1 rounded bg-emerald-500 px-4 py-2 font-semibold text-black hover:bg-emerald-400 disabled:cursor-not-allowed disabled:bg-emerald-900 disabled:text-emerald-300/50"
            >
              Start match
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
