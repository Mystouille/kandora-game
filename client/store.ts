/**
 * Zustand store for the in-browser game session.
 *
 * Phase 0.5 keeps the shape minimal: connection status, last applied
 * `seq`, recipient seat, the four hands (own hand has real tile values;
 * opponents are arrays of `null` for redacted tiles), discard piles,
 * legal actions, and a match-end banner state.
 *
 * The store is a thin projection layer — it applies `GameEvent`s to
 * derive state. In Phase 1 it will defer to the shared `step()` reducer
 * from `~/game/rules/`; for now the slice does its own minimal apply
 * logic so a vertical slice can run before the rules engine exists.
 */
import { create } from "zustand";
import type {
  GameEvent,
  LegalAction,
  Meld,
  RoomState,
  Seat,
  SnapshotState,
  Tile,
} from "~/game/protocol/messages";

/**
 * Lightweight event bus for applied `GameEvent`s.
 *
 * The store is the canonical source of "what just happened in the
 * match" — so anything that's a side-effect of game events (sound
 * cues, animation triggers, future haptics, analytics) subscribes
 * here, not to the transport layer. `ws.ts` only knows how to
 * translate wire frames into store calls; it must not have a UI
 * concern in it.
 *
 * Snapshots intentionally do NOT publish: a snapshot is a state
 * rehydration (initial attach, resync, replay seek) and replaying
 * a burst of catch-up cues would be noise. Only the incremental
 * `applyEvent(event, seq)` path emits.
 */
export interface GameEventNotification {
  event: GameEvent;
  seq: number;
  /** Recipient seat, snapshotted at emit time so listeners don't
   * need to re-read the store. `null` before the match attaches. */
  mySeat: Seat | null;
}

type GameEventListener = (notification: GameEventNotification) => void;

const gameEventListeners = new Set<GameEventListener>();

/**
 * Register a listener that fires every time `applyEvent` lands a
 * new `GameEvent`. Returns an unsubscribe function. Listeners are
 * fired synchronously after the store `set` completes, so they
 * may read the updated state via `useMatchStore.getState()`.
 *
 * Errors thrown by a listener are caught and logged so one
 * misbehaving subscriber can't break the apply loop.
 */
export function subscribeToGameEvents(listener: GameEventListener): () => void {
  gameEventListeners.add(listener);
  return () => {
    gameEventListeners.delete(listener);
  };
}

function emitGameEvent(notification: GameEventNotification): void {
  for (const listener of gameEventListeners) {
    try {
      listener(notification);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[game-events] listener threw", err);
    }
  }
}

export type ConnStatus =
  | "idle"
  | "connecting"
  | "open"
  | "reconnecting"
  | "closed"
  /** No WebSocket is involved — the view was produced by the
   * replay reducer folding a stored `ReplayLog`. The renderer
   * uses this to suppress the live-connection HUD line. */
  | "replay";

export interface MatchView {
  matchId: string | null;
  mySeat: Seat | null;
  /** Hand-by-seat: `Tile[]` for own seat, `(Tile|null)[]` for opponents. */
  hands: Array<Array<Tile | null>>;
  /** Open / declared melds per seat, in declaration order. */
  melds: Meld[][];
  discards: Tile[][];
  wallRemaining: number;
  /** Omniscient live wall in draw order at the start of the
   * current hand (70 tiles after the initial 4×13 deal). `null`
   * in live play — the wire snapshot never carries this field,
   * and the live event apply path never sets it. Populated only
   * by the replay reducer (via `replayViewToMatchView`) so the
   * `showWalls` overlay can reveal tile faces in replays. */
  liveWall: Tile[] | null;
  /** Omniscient dead-wall snapshot (14 tiles in Tenhou yama-index
   * order) at the start of the current hand. `null` in live play
   * (never broadcast); populated only by the replay reducer.
   * Drives the `showWalls` overlay's dead-wall reveal
   * (rinshan / dora / ura / kan-dora positions). */
  deadWall: Tile[] | null;
  /**
   * Number of live-wall tiles actually drawn since the current
   * hand started. Drives the wall-shrinkage visualization in the
   * renderer; reset to 0 on every `hand_start`, incremented on
   * every `draw` event.
   */
  drawsTaken: number;
  /**
   * Number of live-wall tiles drawn since the current hand
   * started, excluding rinshan replacement draws. Populated by
   * the replay reducer; in live play matches `drawsTaken`
   * because the live broadcast path doesn't increment it for
   * rinshan draws (no annotation pass runs on live events).
   */
  liveDrawsTaken: number;
  /**
   * Live-wall draw schedule for the current hand:
   * `liveDrawSchedule[i]` is the seat that will draw
   * `liveWall[i]`. `null` in live play (the future is unknown).
   * Drives the `showWalls` overlay's green highlight on tiles
   * the focused seat will draw.
   */
  liveDrawSchedule: Seat[] | null;
  /**
   * The two dice rolled at the start of the current hand. `null`
   * when unknown (older replays / synthetic logs).
   */
  dice: [number, number] | null;
  doraIndicators: Tile[];
  legalActions: LegalAction[];
  lastSeq: number;
  conn: ConnStatus;
  /** Optimistic discard markers; tile shown gray until server confirms. */
  pendingDiscard: { seat: Seat; tile: Tile } | null;
  /**
   * Unix-ms deadline for the current legal-action window, as sent
   * by the server in the most recent `snapshot` / `event` frame.
   * `null` when the server didn't supply one (slice servers, replays).
   * Drives the renderer's countdown HUD.
   */
  actionDeadline: number | null;
  /**
   * Per-hand "think buffer" in ms remaining for the human seat,
   * as supplied by the server. Drives the trailing component
   * ("X + Y") of the bottom-left HUD timer. `null` when the
   * server didn't supply one (slice servers, replays).
   */
  actionBufferMs: number | null;
  /** Per-seat display names. Populated from the `match_start`
   * event (live) or `ReplayLog.seats` (replay). `null` until the
   * match starts; falls back to the seat wind in the renderer
   * when missing. */
  seatNames: [string, string, string, string] | null;
  /** Per-seat current wait tiles, populated by the replay loader
   * (`annotateWaits` pass). Length 4; an empty inner array means
   * the seat is not in a tenpai shape at this step. `null` in
   * live play — only the replay path runs the precompute. Drives
   * the renderer's red wait-tile tint when `showWaits` is on. */
  currentWaits: Tile[][] | null;
  /** Per-seat current scores (1000-point chips × multiplier). */
  scores: [number, number, number, number];
  /** Current dealer seat. */
  dealer: Seat;
  /** Round wind (E / S / W / N). */
  roundWind: "E" | "S" | "W" | "N";
  /** 1-indexed hand within the round wind. */
  roundNumber: number;
  /** Honba (repeat-hand) counter. */
  honba: number;
  /** Riichi sticks currently on the table. */
  riichiSticks: number;
  /** Per-seat: has this seat declared riichi this hand. */
  riichiDeclared: [boolean, boolean, boolean, boolean];
  /** Per-seat: is this seat currently in furiten (any flavor —
   * self-discard, riichi-permanent, or temporary missed ron).
   * Mirrors the engine's `isFuritenForRon` predicate and is
   * driven by `furiten` wire events. Drives the "Furiten"
   * indicator on each seat's leftmost tile. Reset on
   * `hand_start`. */
  furiten: [boolean, boolean, boolean, boolean];
  /** Per-seat: index into `discards[seat]` of the riichi declaration
   * tile (null when not in riichi). Used to render the tilted tile. */
  riichiTileIdx: [number | null, number | null, number | null, number | null];
  /**
   * Most recently completed hand result panel payload. Cleared at
   * the next `hand_start`. Mirrors the wire `HandEndEvent` shape
   * with one optional addition (the trailing `WinEvent` payload, so
   * the result panel can show yaku / han / fu without the renderer
   * needing to merge two events itself).
   */
  lastHandResult: null | {
    reason: "exhaustive_draw" | "ron" | "tsumo" | "abort";
    abortKind?: "kyuushuu" | "suufon_renda" | "suucha_riichi" | "sanchahou";
    delta?: number[];
    tenpai?: boolean[];
    nagashi?: boolean[];
    scores?: number[];
    honba?: number;
    riichiSticks?: number;
    /** Per-seat wait tiles at hand end (length 4). `null` for
     * seats not in tenpai; absent when the source doesn't record
     * waits. Drives the renderer's `showWaits` overlay. */
    waits?: (Tile[] | null)[];
    /** Per-seat concealed hands at exhaustive draw (length 4),
     * populated only for tenpai seats; `null` otherwise. */
    tenpaiHands?: (Tile[] | null)[];
    /**
     * One entry per winner. For tsumo or single ron this is a
     * one-element array; for multi-ron the engine emits one
     * `win` event per winner and we append to this array so the
     * result panel can display every winning hand. Empty / absent
     * for exhaustive draws and aborts.
     */
    wins?: Array<{
      seat: Seat;
      loser?: Seat | null;
      winTile?: Tile;
      han?: number;
      fu?: number;
      ten?: number;
      yakumanCount?: number;
      yaku?: Record<string, string>;
      hand?: Tile[];
      melds?: Meld[];
      doraIndicators?: Tile[];
      uraDoraIndicators?: Tile[];
    }>;
  };
  matchEnded: null | {
    reason:
      | "round_limit"
      | "busted"
      | "agari_yame"
      | "tenpai_yame"
      | "mangan_end";
    finalScores: Array<{ seat: Seat; score: number; place: number }>;
  };
  /**
   * Seat that has a freshly drawn tile sitting at the end of its
   * closed hand (not yet discarded). `null` outside of a draw→
   * discard window. Used by the renderer to decide whether to
   * display the last tile separated from the rest of the hand
   * (the "tsumo gap"). Hand-length alone is ambiguous — after a
   * chi/pon the closed hand is also length 11 (== 2 mod 3) even
   * though no tile was drawn — so we track this explicitly.
   * Set on every `draw`; cleared on `discard`, `call`,
   * `hand_start`, and snapshot resync.
   */
  freshlyDrawnSeat: Seat | null;

  /**
   * Seat whose latest discard hasn't been "settled" yet — i.e.
   * the discard tile that's still hanging out, pre-call-window,
   * before the next draw or hand-end pulls it flush against the
   * rest of the pond. `null` outside of a discard→next-event
   * window. The renderer uses this to offset just that one tile
   * by a few px so the eye can register which tile was just put
   * down. Set on every `discard`; cleared on `draw`, `call`,
   * `win`, `hand_start`, and snapshot resync.
   */
  freshlyDiscardedSeat: Seat | null;

  /**
   * Pre-match ready-check state. `null` while no ready check is
   * in flight (i.e. before `match_start` and once dealing has
   * begun). `deadline` is the wall-clock ms at which the
   * server auto-advances. `acked` is the per-seat bitmap so
   * the overlay can render which seats have already pressed GO.
   */
  readyCheck: {
    deadline: number;
    acked: [boolean, boolean, boolean, boolean];
  } | null;

  /**
   * Latest `room_state` frame from the server, or `null` until
   * one arrives. Drives the pre-match waiting-room UI: when
   * `status === "waiting"` the match route shows the lobby
   * panel instead of the Pixi canvas; once it flips to
   * `"playing"` the canvas takes over. Updated on every
   * membership / connection / status change.
   */
  roomState: RoomState | null;
}

interface MatchStore extends MatchView {
  setConn: (status: ConnStatus) => void;
  setMatch: (matchId: string, mySeat?: Seat | null) => void;
  applyEvent: (event: GameEvent, seq: number) => void;
  hydrateSnapshot: (state: SnapshotState, seq: number) => void;
  setLegalActions: (actions: LegalAction[]) => void;
  setPendingDiscard: (p: { seat: Seat; tile: Tile } | null) => void;
  setActionDeadline: (deadline: number | null) => void;
  setActionBufferMs: (ms: number | null) => void;
  setReadyCheck: (
    rc: { deadline: number; acked: [boolean, boolean, boolean, boolean] } | null
  ) => void;
  setRoomState: (rs: RoomState | null) => void;
  reset: () => void;
}

const emptyHands: Array<Array<Tile | null>> = [[], [], [], []];
const emptyDiscards: Tile[][] = [[], [], [], []];
const emptyMelds: Meld[][] = [[], [], [], []];

const initialState: MatchView = {
  matchId: null,
  mySeat: null,
  hands: emptyHands,
  melds: emptyMelds,
  discards: emptyDiscards,
  wallRemaining: 70,
  liveWall: null,
  deadWall: null,
  drawsTaken: 0,
  liveDrawsTaken: 0,
  liveDrawSchedule: null,
  dice: null,
  doraIndicators: [],
  legalActions: [],
  lastSeq: -1,
  conn: "idle",
  pendingDiscard: null,
  actionDeadline: null,
  actionBufferMs: null,
  scores: [25000, 25000, 25000, 25000],
  dealer: 0,
  roundWind: "E",
  roundNumber: 1,
  honba: 0,
  riichiSticks: 0,
  seatNames: null,
  riichiDeclared: [false, false, false, false],
  riichiTileIdx: [null, null, null, null],
  lastHandResult: null,
  matchEnded: null,
  currentWaits: null,
  freshlyDrawnSeat: null,
  freshlyDiscardedSeat: null,
  readyCheck: null,
  furiten: [false, false, false, false],
  roomState: null,
};

export const useMatchStore = create<MatchStore>((set) => ({
  ...initialState,

  setConn: (conn) => {
    set({ conn });
  },

  setMatch: (matchId, mySeat = null) => {
    set({
      ...initialState,
      matchId,
      mySeat,
      hands: [[], [], [], []],
      melds: [[], [], [], []],
      discards: [[], [], [], []],
    });
  },

  setLegalActions: (legalActions) => {
    set({ legalActions });
  },

  setPendingDiscard: (pendingDiscard) => {
    set({ pendingDiscard });
  },

  setActionDeadline: (actionDeadline) => {
    set({ actionDeadline });
  },

  setActionBufferMs: (actionBufferMs) => {
    set({ actionBufferMs });
  },

  setReadyCheck: (readyCheck) => {
    set({ readyCheck });
  },

  setRoomState: (roomState) => {
    // Adopting the server's seat assignment as soon as a
    // `room_state` arrives lets the renderer compose itself
    // correctly even before the first `snapshot` (which is what
    // would otherwise set `mySeat`).
    set((state) => ({
      ...state,
      roomState,
      mySeat: roomState?.mySeat ?? state.mySeat,
    }));
  },

  hydrateSnapshot: (snap, seq) => {
    set((state) => ({
      ...state,
      mySeat: snap.mySeat,
      hands: snap.hands.map((h) => [...h]),
      melds: snap.melds.map((m) => m.map((x) => ({ ...x }))),
      discards: snap.discards.map((d) => [...d]),
      wallRemaining: snap.wallRemaining,
      dice: snap.dice ? [snap.dice[0], snap.dice[1]] : null,
      // Prefer the server's exact count when present; older
      // snapshots without `drawsTaken` get a wall-size derivation
      // that's exact for normal play (rinshan draws come off the
      // dead wall and don't affect `wallRemaining`).
      drawsTaken: snap.drawsTaken ?? Math.max(0, 70 - snap.wallRemaining),
      // Live snapshots never carry a draw schedule (it's a
      // replay-only post-process artifact); reset to safe
      // defaults so the renderer falls through to plain wall
      // rendering.
      liveDrawsTaken: snap.drawsTaken ?? Math.max(0, 70 - snap.wallRemaining),
      liveDrawSchedule: null,
      doraIndicators: [...snap.doraIndicators],
      dealer: snap.dealer,
      roundWind: snap.roundWind,
      roundNumber: snap.roundNumber,
      honba: snap.honba,
      riichiSticks: snap.riichiSticks,
      riichiDeclared: [...snap.riichiDeclared] as [
        boolean,
        boolean,
        boolean,
        boolean,
      ],
      riichiTileIdx: (snap.riichiTileIdx
        ? [...snap.riichiTileIdx]
        : [null, null, null, null]) as [
        number | null,
        number | null,
        number | null,
        number | null,
      ],
      scores: [...snap.scores] as [number, number, number, number],
      lastSeq: seq,
      // A snapshot is the authoritative current view; clear any
      // optimistic / panel state that may not survive the resync.
      pendingDiscard: null,
      lastHandResult: null,
      matchEnded: null,
      freshlyDrawnSeat: null,
      freshlyDiscardedSeat: null,
      // Furiten state: the snapshot carries the recipient's own
      // status truthfully and `false` for the other three seats
      // (opponent furiten is private). For back-compat with
      // pre-furiten snapshots, fall back to all-false and rely on
      // subsequent `furiten` events to repopulate the indicator.
      furiten: (snap.furiten
        ? [...snap.furiten]
        : [false, false, false, false]) as [boolean, boolean, boolean, boolean],
    }));
  },

  applyEvent: (event, seq) => {
    set((state) => {
      const next: MatchView = {
        ...state,
        lastSeq: seq,
      };
      switch (event.type) {
        case "match_start": {
          const namesArr = new Array<string>(4).fill("");
          for (const s of event.seats) {
            namesArr[s.seat] = s.displayName;
          }
          return {
            ...next,
            seatNames: [namesArr[0], namesArr[1], namesArr[2], namesArr[3]] as [
              string,
              string,
              string,
              string,
            ],
          };
        }
        case "hand_start": {
          const hands: Array<Array<Tile | null>> = [[], [], [], []];
          if (state.mySeat === null && event.startingHands) {
            // Spectator path: server forwards omniscient
            // `startingHands` so the client can render every
            // seat's hand. Populate all four seats from it.
            for (let s = 0; s < 4; s++) {
              hands[s] = [...event.startingHands[s]];
            }
          } else {
            if (state.mySeat !== null && event.hand) {
              hands[state.mySeat] = [...event.hand];
            }
            // Opponents start with 13 redacted tiles.
            for (let s = 0; s < 4; s++) {
              if (s !== state.mySeat) {
                hands[s] = new Array<Tile | null>(13).fill(null);
              }
            }
          }
          return {
            ...next,
            hands,
            melds: [[], [], [], []],
            discards: [[], [], [], []],
            doraIndicators: [...event.doraIndicators],
            wallRemaining: 70,
            drawsTaken: 0,
            liveDrawsTaken: 0,
            liveDrawSchedule: event.liveDrawSchedule
              ? [...event.liveDrawSchedule]
              : null,
            dice: event.dice ? [event.dice[0], event.dice[1]] : null,
            dealer: event.dealer,
            roundWind: event.roundWind ?? state.roundWind,
            roundNumber: event.roundNumber ?? state.roundNumber,
            honba: event.honba ?? 0,
            riichiSticks: event.riichiSticks ?? 0,
            scores: (event.scores ?? state.scores) as [
              number,
              number,
              number,
              number,
            ],
            riichiDeclared: [false, false, false, false],
            riichiTileIdx: [null, null, null, null],
            lastHandResult: null,
            matchEnded: null,
            freshlyDrawnSeat: null,
            freshlyDiscardedSeat: null,
            furiten: [false, false, false, false],
          };
        }
        case "draw": {
          const hands = state.hands.map((h) => [...h]);
          if (event.tile) {
            hands[event.seat].push(event.tile);
          } else {
            hands[event.seat].push(null);
          }
          return {
            ...next,
            hands,
            wallRemaining: event.wallRemaining,
            drawsTaken: state.drawsTaken + 1,
            liveDrawsTaken: event.fromDeadWall
              ? state.liveDrawsTaken
              : state.liveDrawsTaken + 1,
            freshlyDrawnSeat: event.seat,
            freshlyDiscardedSeat: null,
          };
        }
        case "discard": {
          const hands = state.hands.map((h) => [...h]);
          // A hand slot is "visible" (real tile, not a redacted
          // null placeholder) when it's our own seat or when we
          // are a spectator (mySeat=null and the server forwarded
          // omniscient hands). Either way we remove the actual
          // tile; for opponents of a player we still hold null
          // placeholders, so we pop one of those.
          const visibleHand =
            state.mySeat === null || event.seat === state.mySeat;
          const idx = visibleHand
            ? hands[event.seat].lastIndexOf(event.tile)
            : hands[event.seat].findIndex((t) => t === null);
          if (idx >= 0) {
            hands[event.seat].splice(idx, 1);
          }
          const discards = state.discards.map((d) => [...d]);
          discards[event.seat].push(event.tile);
          // Riichi declaration: record the index where this tile
          // landed in the seat's pile and flip the seat's flag. The
          // server folds the rotation into the same `discard` event
          // via the optional `riichi: true` payload.
          const riichiDeclared = event.riichi
            ? ((): [boolean, boolean, boolean, boolean] => {
                const arr = [...state.riichiDeclared] as [
                  boolean,
                  boolean,
                  boolean,
                  boolean,
                ];
                arr[event.seat] = true;
                return arr;
              })()
            : state.riichiDeclared;
          const riichiTileIdx = event.riichi
            ? ((): [
                number | null,
                number | null,
                number | null,
                number | null,
              ] => {
                const arr = [...state.riichiTileIdx] as [
                  number | null,
                  number | null,
                  number | null,
                  number | null,
                ];
                arr[event.seat] = discards[event.seat].length - 1;
                return arr;
              })()
            : state.riichiTileIdx;
          // Riichi declaration also deposits a 1000-point stick on
          // the table: optimistically deduct the seat's score and
          // bump the stick counter so the UI reflects it the moment
          // the declaration tile lands, without waiting for the
          // server's authoritative score event.
          const scores = event.riichi
            ? ((): [number, number, number, number] => {
                const arr = [...state.scores] as [
                  number,
                  number,
                  number,
                  number,
                ];
                arr[event.seat] = arr[event.seat] - 1000;
                return arr;
              })()
            : state.scores;
          const riichiSticks = event.riichi
            ? state.riichiSticks + 1
            : state.riichiSticks;
          // Clear optimistic marker on our own confirmed discard.
          const pendingDiscard =
            state.pendingDiscard &&
            state.pendingDiscard.seat === event.seat &&
            state.pendingDiscard.tile === event.tile
              ? null
              : state.pendingDiscard;
          return {
            ...next,
            hands,
            discards,
            riichiDeclared,
            riichiTileIdx,
            scores,
            riichiSticks,
            pendingDiscard,
            freshlyDrawnSeat: null,
            freshlyDiscardedSeat: event.seat,
          };
        }
        case "win": {
          // Stash the win payload so the eventual `hand_end` can
          // attach it to `lastHandResult`. For multi-ron the
          // engine emits one `win` event per winner before the
          // shared `hand_end`; we append each into `wins`.
          // If a `hand_end` arrived first (rare/unexpected
          // ordering), fold the win into the existing payload.
          const existing = state.lastHandResult;
          const win = {
            seat: event.seat,
            loser: event.loser ?? null,
            winTile: event.winTile,
            han: event.han,
            fu: event.fu,
            ten: event.ten,
            yakumanCount: event.yakumanCount,
            yaku: event.yaku,
            hand: event.hand ? [...event.hand] : undefined,
            melds: event.melds ? event.melds.map((m) => ({ ...m })) : undefined,
            doraIndicators: event.doraIndicators
              ? [...event.doraIndicators]
              : undefined,
            uraDoraIndicators: event.uraDoraIndicators
              ? [...event.uraDoraIndicators]
              : undefined,
          };
          const wins = existing?.wins ? [...existing.wins, win] : [win];
          return {
            ...next,
            lastHandResult: existing
              ? { ...existing, wins }
              : {
                  // Derive the win reason from `loser`: a ron win
                  // names the discarder, a tsumo win has none. The
                  // `hand_end` event will overwrite this with the
                  // authoritative reason, but until then we must
                  // not mislabel a ron as a tsumo.
                  reason: win.loser !== null ? "ron" : "tsumo",
                  wins,
                },
          };
        }
        case "hand_end": {
          const existingWins = state.lastHandResult?.wins;
          return {
            ...next,
            scores: (event.scores ?? state.scores) as [
              number,
              number,
              number,
              number,
            ],
            riichiSticks: event.riichiSticks ?? state.riichiSticks,
            lastHandResult: {
              reason: event.reason,
              ...(event.abortKind ? { abortKind: event.abortKind } : {}),
              ...(event.delta ? { delta: [...event.delta] } : {}),
              ...(event.tenpai ? { tenpai: [...event.tenpai] } : {}),
              ...(event.nagashi ? { nagashi: [...event.nagashi] } : {}),
              ...(event.scores ? { scores: [...event.scores] } : {}),
              ...(event.honba !== undefined ? { honba: event.honba } : {}),
              ...(event.riichiSticks !== undefined
                ? { riichiSticks: event.riichiSticks }
                : {}),
              ...(event.tenpaiHands
                ? {
                    tenpaiHands: event.tenpaiHands.map((h) =>
                      h ? [...h] : null
                    ),
                  }
                : {}),
              ...(existingWins ? { wins: existingWins } : {}),
            },
          };
        }
        case "new_dora": {
          return {
            ...next,
            doraIndicators: [...state.doraIndicators, event.indicator],
          };
        }
        case "call": {
          // Apply the meld to the caller's hand + remove the claimed
          // tile from the discarder's pile. Slice-grade: just enough
          // to keep `hands`/`discards` consistent so the next draws/
          // discards don't trip the renderer.
          const hands = state.hands.map((h) => [...h]);
          const discards = state.discards.map((d) => [...d]);
          const caller = event.seat;
          const meld = event.meld;
          // Remove the claimed tile from the discarder's pile (chi/
          // pon/daiminkan/shouminkan — never ankan).
          if (meld.from !== null && meld.claimedTile !== null) {
            const pile = discards[meld.from];
            const idx = pile.lastIndexOf(meld.claimedTile);
            if (idx >= 0) {
              pile.splice(idx, 1);
            }
          }
          // Remove the caller's contributed tiles from their hand.
          // For our own seat we know the exact tile strings; for
          // opponents we still hold redacted `null` placeholders, so
          // drop one `null` per contributed tile.
          // NB: remove a SINGLE copy of the claimed tile (pon/kan of
          // identical tiles like "1m,1m,1m" would otherwise filter
          // every match and incorrectly drop the caller's own copies).
          const contributed = (() => {
            const rest = [...meld.tiles];
            if (meld.claimedTile !== null) {
              const i = rest.indexOf(meld.claimedTile);
              if (i >= 0) {
                rest.splice(i, 1);
              }
            }
            return rest;
          })();
          for (const t of contributed) {
            const hand = hands[caller];
            // Same visibility rule as `discard`: a spectator sees
            // every seat's real tiles, a player sees only their
            // own seat's tiles (others are null placeholders).
            const visibleHand =
              state.mySeat === null || caller === state.mySeat;
            if (visibleHand) {
              const i = hand.lastIndexOf(t);
              if (i >= 0) {
                hand.splice(i, 1);
              }
            } else {
              const i = hand.findIndex((x) => x === null);
              if (i >= 0) {
                hand.splice(i, 1);
              }
            }
          }
          // Append the meld so it can be rendered next to the hand.
          // For shouminkan we'd want to upgrade the existing pon
          // in-place; the engine ships a fresh `shouminkan`-typed
          // meld with the same tiles, so for the slice we just
          // replace the matching pon if found, otherwise append.
          const melds = state.melds.map((m) => [...m]);
          if (meld.type === "shouminkan") {
            // Match on `meld.tiles` rather than `claimedTile`: some
            // platform adapters (e.g. Majsoul's
            // `RecordAnGangAddGang`) emit shouminkan with
            // `claimedTile: null`, in which case the old
            // claimedTile-equality check silently failed and the
            // viewer rendered the original pon alongside a separate
            // kan instead of upgrading the pon.
            const kanTile = meld.tiles[0];
            const norm = (t: Tile): string =>
              `${t[0] === "0" ? "5" : t[0]}${t[1]}`;
            const kanKey = kanTile ? norm(kanTile) : null;
            const ponIdx = kanKey
              ? melds[caller].findIndex(
                  (m) =>
                    m.type === "pon" && m.tiles.some((x) => norm(x) === kanKey)
                )
              : -1;
            if (ponIdx >= 0) {
              // Carry over the original pon's `claimedTile` / `from`
              // so the renderer can position the tilted called tile
              // in the same slot as the original pon (the kan tile
              // stacks on top of that slot). Some adapters (notably
              // Majsoul) ship shouminkan with `claimedTile: null` /
              // `from: null` which would otherwise force the
              // renderer's default right-most slot fallback.
              const original = melds[caller][ponIdx];
              melds[caller][ponIdx] = {
                ...meld,
                claimedTile: meld.claimedTile ?? original.claimedTile,
                from: meld.from ?? original.from,
              };
            } else {
              melds[caller].push(meld);
            }
          } else {
            melds[caller].push(meld);
          }
          return {
            ...next,
            hands,
            melds,
            discards,
            freshlyDrawnSeat: null,
            freshlyDiscardedSeat: null,
          };
        }
        case "match_end": {
          return {
            ...next,
            matchEnded: {
              reason: event.reason,
              finalScores: event.finalScores,
            },
          };
        }
        case "furiten": {
          const furiten = [...state.furiten] as [
            boolean,
            boolean,
            boolean,
            boolean,
          ];
          furiten[event.seat] = event.active;
          return { ...next, furiten };
        }
        default: {
          // Exhaustiveness — Phase 1 will tighten as new event types land.
          return next;
        }
      }
    });
    // Notify side-effect subscribers (sound, future analytics) after
    // the state transition has landed. Snapshots do NOT fire this
    // path on purpose — see `subscribeToGameEvents`.
    emitGameEvent({ event, seq, mySeat: useMatchStore.getState().mySeat });
  },

  reset: () => {
    set({ ...initialState });
  },
}));
