/**
 * Replay reducer — Phase 4.5, step 2.
 *
 * Pure function: given a `ReplayLog` and a current event index, fold
 * events `[0..index]` into a `ReplayView` that the route component
 * hands to `TableRenderer`. No timers, no subscriptions, no
 * lifecycle.
 *
 * The replay reducer operates on the **archived omniscient** event
 * log. Both writers — `archiveReplayLog` in `game-server/src/persist`
 * and the platform adapters (Majsoul / Tenhou / Riichi City) —
 * always include `startingHands` on every `hand_start`, every
 * `draw` carries its real `tile`, every `discard` carries the real
 * tile, etc. The reducer therefore treats all seats omnisciently
 * (no `null` redaction placeholders, no projection branching by
 * seat).
 *
 * The live wire schema also accepts `startingHands` (optional), but
 * the projection layer (`game-server/src/projection.ts`) strips it
 * before sending to live clients so opponents stay redacted during
 * the match. Replay archival happens before projection, so the
 * archived events keep the omniscient field.
 *
 * Live play uses a separate apply path in `app/game/client/store.ts`
 * that DOES branch on `mySeat` because its events arrive projected.
 * The two paths intentionally diverge on that one point and share
 * everything else through the `GameEvent` schema.
 */
import type { GameEvent, Meld, Seat, Tile } from "~/game/protocol/messages";
import type { MatchView } from "~/game/client/store";
import type { ReplayLog } from "./types";

export interface ReplayView {
  /** Hand-by-seat. `null` = unknown tile (opponent starting tiles
   * before first draw). Real `Tile` strings everywhere else. */
  hands: Array<Array<Tile | null>>;
  /** Open / declared melds per seat, in declaration order. */
  melds: Meld[][];
  discards: Tile[][];
  wallRemaining: number;
  /** Omniscient live wall in draw order at the start of the
   * current hand (70 tiles). `null` when the source replay log
   * doesn't record it (older logs / platform adapters that
   * haven't been backfilled). Used by the renderer's `showWalls`
   * overlay to reveal tile faces. */
  liveWall: Tile[] | null;
  /** Omniscient dead-wall snapshot (14 tiles in Tenhou yama-index
   * order) at the start of the current hand. `null` when the
   * source log doesn't carry it. Used by `showWalls` to reveal
   * rinshan, ura-dora, kan-dora etc. */
  deadWall: Tile[] | null;
  /** Number of live-wall tiles drawn since the current hand
   * started. Mirrors the live store; reset on every `hand_start`,
   * incremented on every `draw`. */
  drawsTaken: number;
  /** Number of LIVE-wall tiles drawn since the current hand
   * started (excludes rinshan replacement draws). Reset on every
   * `hand_start`. Used by the `showWalls` overlay to decide which
   * `liveWall[i]` positions are still on the wall. */
  liveDrawsTaken: number;
  /** Live-wall draw schedule for the current hand:
   * `liveDrawSchedule[i]` is the seat that draws `liveWall[i]`.
   * `null` when the hand_start event didn't carry one (live
   * matches, or archives that pre-date the annotation pass). */
  liveDrawSchedule: Seat[] | null;
  /** Two dice rolled at the start of the current hand; `null` when
   * the source log doesn't record dice (older synthetic logs). */
  dice: [number, number] | null;
  doraIndicators: Tile[];
  scores: [number, number, number, number];
  dealer: Seat;
  roundWind: "E" | "S" | "W" | "N";
  roundNumber: number;
  honba: number;
  riichiSticks: number;
  riichiDeclared: [boolean, boolean, boolean, boolean];
  /** Per-seat: index into `discards[seat]` of the riichi declaration
   * tile (null when the seat hasn't declared). Used to render the
   * tilted tile. */
  riichiTileIdx: [number | null, number | null, number | null, number | null];
  /** Last completed hand's result panel payload (cleared on next
   * `hand_start`). Same shape the live store uses, minus the
   * optimistic-discard concerns. */
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
     * seats not in tenpai; absent when the source log doesn't
     * record waits. Drives the `showWaits` overlay in the
     * renderer. */
    waits?: (Tile[] | null)[];
    win?: {
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
    };
  };
  matchEnded: null | {
    finalScores: Array<{ seat: Seat; score: number; place: number }>;
  };
  /**
   * Seat that has a freshly drawn tile sitting at the end of its
   * closed hand (not yet discarded). `null` outside of a draw→
   * discard window. Used by the renderer to decide whether to
   * display the last tile separated from the rest of the hand
   * (the "tsumo gap"). Hand-length alone is ambiguous — after
   * a chi/pon the closed hand is also length 11 mod 3=2 even
   * though no tile was drawn — so we track this explicitly.
   *
   * Set on every `draw` (including rinshan replacement draws).
   * Cleared on `discard`, `call`, `hand_start`, and `match_end`.
   */
  freshlyDrawnSeat: Seat | null;
}

export function initialView(): ReplayView {
  return {
    hands: [[], [], [], []],
    melds: [[], [], [], []],
    discards: [[], [], [], []],
    wallRemaining: 70,
    liveWall: null,
    deadWall: null,
    drawsTaken: 0,
    liveDrawsTaken: 0,
    liveDrawSchedule: null,
    dice: null,
    doraIndicators: [],
    scores: [25000, 25000, 25000, 25000],
    dealer: 0,
    roundWind: "E",
    roundNumber: 1,
    honba: 0,
    riichiSticks: 0,
    riichiDeclared: [false, false, false, false],
    riichiTileIdx: [null, null, null, null],
    lastHandResult: null,
    matchEnded: null,
    freshlyDrawnSeat: null,
  };
}

/**
 * Apply a single (unprojected) event to a view. Pure. Public for the
 * benefit of incremental folds — the route component can cache the
 * view at a previous index and apply one event when the user steps
 * forward, instead of re-folding the entire prefix.
 */
export function applyReplayEvent(
  view: ReplayView,
  event: GameEvent
): ReplayView {
  switch (event.type) {
    case "match_start": {
      return view;
    }
    case "hand_start": {
      // Archived `hand_start` events always carry the omniscient
      // `startingHands` snapshot (Phase 4.5 step 5 — Option B).
      // Both writers — `archiveReplayLog` in `game-server` and the
      // Majsoul / Tenhou / Riichi City platform adapters — fill
      // this in. An absent value is treated as a writer bug; we
      // degrade to empty hands rather than crash so a malformed
      // log still renders the rest of the match.
      const src: Tile[][] = event.startingHands ?? [[], [], [], []];
      const hands: Array<Array<Tile | null>> = src.map((h) => [...h]);
      return {
        ...view,
        hands,
        melds: [[], [], [], []],
        discards: [[], [], [], []],
        doraIndicators: [...event.doraIndicators],
        wallRemaining: 70,
        liveWall: event.liveWall ? [...event.liveWall] : null,
        deadWall: event.deadWall ? [...event.deadWall] : null,
        drawsTaken: 0,
        liveDrawsTaken: 0,
        liveDrawSchedule: event.liveDrawSchedule
          ? [...event.liveDrawSchedule]
          : null,
        dice: event.dice ? [event.dice[0], event.dice[1]] : null,
        dealer: event.dealer,
        roundWind: event.roundWind ?? view.roundWind,
        roundNumber: event.roundNumber ?? view.roundNumber,
        honba: event.honba ?? 0,
        riichiSticks: event.riichiSticks ?? 0,
        scores: (event.scores ?? view.scores) as [
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
      };
    }
    case "draw": {
      const hands = view.hands.map((h) => [...h]);
      // Unprojected draws always carry a tile; fall back to `null`
      // defensively for safety against malformed logs.
      hands[event.seat].push(event.tile ?? null);
      return {
        ...view,
        hands,
        wallRemaining: event.wallRemaining,
        drawsTaken: view.drawsTaken + 1,
        liveDrawsTaken: event.fromDeadWall
          ? view.liveDrawsTaken
          : view.liveDrawsTaken + 1,
        freshlyDrawnSeat: event.seat,
      };
    }
    case "discard": {
      const hands = view.hands.map((h) => [...h]);
      // Unprojected log: prefer the real-tile match. If no match
      // (legacy logs that pre-date enrichment), drop a `null`
      // placeholder so the hand size stays correct.
      const pile = hands[event.seat];
      let idx = pile.lastIndexOf(event.tile);
      if (idx < 0) {
        idx = pile.findIndex((t) => t === null);
      }
      if (idx >= 0) {
        pile.splice(idx, 1);
      }
      const discards = view.discards.map((d) => [...d]);
      discards[event.seat].push(event.tile);
      const riichiDeclared = event.riichi
        ? ((): [boolean, boolean, boolean, boolean] => {
            const arr = [...view.riichiDeclared] as [
              boolean,
              boolean,
              boolean,
              boolean,
            ];
            arr[event.seat] = true;
            return arr;
          })()
        : view.riichiDeclared;
      const riichiTileIdx = event.riichi
        ? ((): [number | null, number | null, number | null, number | null] => {
            const arr = [...view.riichiTileIdx] as [
              number | null,
              number | null,
              number | null,
              number | null,
            ];
            arr[event.seat] = discards[event.seat].length - 1;
            return arr;
          })()
        : view.riichiTileIdx;
      // When a player declares riichi, visually bump the stick
      // counter and deduct 1000 from the declarer's score. The
      // authoritative `scores` / `riichiSticks` are re-set at the
      // next hand boundary; this just keeps the table state
      // visually consistent mid-hand.
      let riichiSticks = view.riichiSticks;
      let scores = view.scores;
      if (event.riichi) {
        riichiSticks = view.riichiSticks + 1;
        const next = [...view.scores] as [number, number, number, number];
        next[event.seat] = next[event.seat] - 1000;
        scores = next;
      }
      return {
        ...view,
        hands,
        discards,
        riichiDeclared,
        riichiTileIdx,
        riichiSticks,
        scores,
        freshlyDrawnSeat: null,
      };
    }
    case "call": {
      const hands = view.hands.map((h) => [...h]);
      const discards = view.discards.map((d) => [...d]);
      const caller = event.seat;
      const meld = event.meld;
      // Remove the claimed tile from the discarder's pile (chi /
      // pon / daiminkan / shouminkan — ankan has `from === null`).
      if (meld.from !== null && meld.claimedTile !== null) {
        const pile = discards[meld.from];
        const idx = pile.lastIndexOf(meld.claimedTile);
        if (idx >= 0) {
          pile.splice(idx, 1);
        }
      }
      // Caller's contributed tiles = meld.tiles minus a single copy
      // of the claimed tile (so pon/kan of triplets like 1m,1m,1m
      // don't filter every match).
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
        let i = hand.lastIndexOf(t);
        if (i < 0) {
          i = hand.findIndex((x) => x === null);
        }
        if (i >= 0) {
          hand.splice(i, 1);
        }
      }
      const melds = view.melds.map((m) => [...m]);
      if (meld.type === "shouminkan") {
        // Upgrade in place if the matching pon exists. Use any tile
        // from the kan to identify the suit/number (all 4 tiles are
        // the same value, modulo red-5). We can't rely on
        // `meld.claimedTile` — some platform adapters (notably
        // Majsoul, which delivers shouminkan via
        // `RecordAnGangAddGang`) emit it as `null`. Comparing against
        // the pon's tiles is robust to that.
        const kanTile = meld.tiles[0];
        const norm = (t: Tile): string => `${t[0] === "0" ? "5" : t[0]}${t[1]}`;
        const kanKey = kanTile ? norm(kanTile) : null;
        const ponIdx = kanKey
          ? melds[caller].findIndex(
              (m) => m.type === "pon" && m.tiles.some((x) => norm(x) === kanKey)
            )
          : -1;
        if (ponIdx >= 0) {
          // Carry over the original pon's `claimedTile` / `from` so
          // the renderer can position the tilted tile in the same
          // slot as the original call (the kan tile is stacked on
          // top of that slot). Some adapters (notably Majsoul's
          // `RecordAnGangAddGang`) ship the shouminkan with
          // `claimedTile: null` / `from: null`; without this merge
          // `drawMeld` falls back to the right-most slot and the
          // kan tile renders detached from the original call.
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
      // A call never produces a freshly drawn tile in the closed
      // hand — the claimed tile lives in the meld. The caller
      // must still discard, but visually the closed hand has no
      // "drawn" tile to separate. (If the call is a kan, the
      // upcoming rinshan `draw` event will set this back.)
      return { ...view, hands, melds, discards, freshlyDrawnSeat: null };
    }
    case "new_dora": {
      return {
        ...view,
        doraIndicators: [...view.doraIndicators, event.indicator],
      };
    }
    case "win": {
      const existing = view.lastHandResult;
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
      return {
        ...view,
        lastHandResult: existing
          ? { ...existing, win }
          : {
              // The `win` event may arrive before its matching
              // `hand_end` (Majsoul/Tenhou/Riichi-City all emit
              // both). Derive the reason from `loser`: a ron win
              // names the discarder, a tsumo win has none.
              reason: win.loser !== null ? "ron" : "tsumo",
              win,
            },
      };
    }
    case "hand_end": {
      const existingWin = view.lastHandResult?.win;
      const eventWaits = event.waits;
      return {
        ...view,
        scores: (event.scores ?? view.scores) as [
          number,
          number,
          number,
          number,
        ],
        riichiSticks: event.riichiSticks ?? view.riichiSticks,
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
          ...(eventWaits
            ? { waits: eventWaits.map((w) => (w ? [...w] : null)) }
            : {}),
          ...(existingWin ? { win: existingWin } : {}),
        },
      };
    }
    case "match_end": {
      return { ...view, matchEnded: { finalScores: event.finalScores } };
    }
    default: {
      return view;
    }
  }
}

/**
 * Fold events `[0..index]` of the log into a single view. `index`
 * is clamped to `[-1, log.events.length - 1]`; `-1` returns the
 * initial empty view (before `match_start`).
 *
 * O(index) per call. Route components that step one event at a time
 * should cache the previous view and call `applyReplayEvent`
 * directly instead.
 */
export function replayReducer(log: ReplayLog, index: number): ReplayView {
  const clamped = Math.max(-1, Math.min(index, log.events.length - 1));
  let view = initialView();
  for (let i = 0; i <= clamped; i++) {
    view = applyReplayEvent(view, log.events[i]);
  }
  return view;
}

/**
 * Inclusive event-index bounds for the log. `min === -1` is the
 * pre-`match_start` initial view; `max === events.length - 1` is
 * after the final event.
 */
export function replayBounds(log: ReplayLog): { min: number; max: number } {
  return { min: -1, max: log.events.length - 1 };
}

/**
 * Indices of every `hand_start` event in the log, in order. Used to
 * power the round-picker UI: "jump to E1 / E2 / S1 / …".
 */
export function roundBoundaries(log: ReplayLog): number[] {
  const out: number[] = [];
  for (let i = 0; i < log.events.length; i++) {
    if (log.events[i].type === "hand_start") {
      out.push(i);
    }
  }
  return out;
}

/**
 * Adapt a `ReplayView` into the `MatchView` shape `TableRenderer`
 * already consumes for live play. Lets the renderer stay completely
 * unaware of replay vs live; the route component owns this bridge.
 *
 * - `mySeat` defaults to seat 0. The renderer uses it only to decide
 *   which hand to lay out at the bottom; replays open from seat 0's
 *   perspective unless the caller rotates. Future: expose a seat
 *   selector in the replay HUD.
 * - `legalActions` is always empty — replays are not interactive.
 * - `pendingDiscard` is always null — no optimistic UI in replays.
 * - `conn` is reported as `"open"` so the renderer doesn't paint a
 *   "connecting…" overlay.
 * - `lastSeq` is the current event index; useful for HUD readouts
 *   that already print it.
 */
export function replayViewToMatchView(
  view: ReplayView,
  opts: {
    index: number;
    mySeat?: Seat;
    matchId?: string | null;
    seatNames?: [string, string, string, string] | null;
    /** Per-seat wait tiles at this step. Pre-computed server-side
     * by `annotateWaits` so the renderer doesn't run shanten on
     * the client. `null` when no precompute is available. */
    currentWaits?: Tile[][] | null;
  }
): MatchView {
  const focus: Seat = opts.mySeat ?? 0;
  const base: MatchView = {
    matchId: opts.matchId ?? null,
    mySeat: 0,
    hands: view.hands,
    melds: view.melds,
    discards: view.discards,
    wallRemaining: view.wallRemaining,
    liveWall: view.liveWall,
    deadWall: view.deadWall,
    drawsTaken: view.drawsTaken,
    liveDrawsTaken: view.liveDrawsTaken,
    liveDrawSchedule: view.liveDrawSchedule,
    dice: view.dice,
    doraIndicators: view.doraIndicators,
    legalActions: [],
    lastSeq: opts.index,
    conn: "replay",
    pendingDiscard: null,
    scores: view.scores,
    seatNames: opts.seatNames ?? null,
    dealer: view.dealer,
    roundWind: view.roundWind,
    roundNumber: view.roundNumber,
    honba: view.honba,
    riichiSticks: view.riichiSticks,
    riichiDeclared: view.riichiDeclared,
    riichiTileIdx: view.riichiTileIdx,
    lastHandResult: view.lastHandResult,
    matchEnded: view.matchEnded,
    currentWaits: opts.currentWaits ?? null,
    freshlyDrawnSeat: view.freshlyDrawnSeat,
  };
  if (focus === 0) {
    return base;
  }
  return rotateMatchView(base, focus);
}

/**
 * Rotate a `MatchView` so the seat at `focus` is rendered at the
 * bottom (relative seat 0). All per-seat arrays are reindexed and
 * every absolute-seat field (dealer, draw schedule, win/loser) is
 * remapped to the new relative-seat space. The renderer is agnostic
 * to absolute seats — it just paints seat index 0 at the bottom and
 * 1/2/3 CCW around the table — so this transformation is sufficient
 * to rotate the entire viewport (hands, discards, walls, melds,
 * riichi sticks, scores, dealer marker, break-point dice landing).
 */
function rotateMatchView(mv: MatchView, focus: Seat): MatchView {
  const rot = (s: Seat): Seat => ((s - focus + 4) % 4) as Seat;
  const perm4 = <T>(arr: readonly T[]): [T, T, T, T] => [
    arr[(0 + focus) % 4],
    arr[(1 + focus) % 4],
    arr[(2 + focus) % 4],
    arr[(3 + focus) % 4],
  ];
  const result = mv.lastHandResult;
  const rotatedResult = result
    ? {
        ...result,
        delta: result.delta ? perm4(result.delta) : result.delta,
        tenpai: result.tenpai ? perm4(result.tenpai) : result.tenpai,
        nagashi: result.nagashi ? perm4(result.nagashi) : result.nagashi,
        scores: result.scores ? perm4(result.scores) : result.scores,
        waits: result.waits ? perm4(result.waits) : result.waits,
        win: result.win
          ? {
              ...result.win,
              seat: rot(result.win.seat),
              loser:
                result.win.loser != null
                  ? rot(result.win.loser)
                  : result.win.loser,
            }
          : result.win,
      }
    : result;
  return {
    ...mv,
    mySeat: 0,
    hands: perm4(mv.hands),
    melds: perm4(mv.melds).map((row) =>
      // Each meld's `from` is the absolute seat that supplied the
      // claimed tile; remap it into the rotated frame so the
      // renderer (which works in relative seats) can position the
      // tilted tile at the correct slot.
      row.map((m) => ({
        ...m,
        from: m.from != null ? rot(m.from) : m.from,
      }))
    ) as [Meld[], Meld[], Meld[], Meld[]],
    discards: perm4(mv.discards),
    liveDrawSchedule: mv.liveDrawSchedule
      ? mv.liveDrawSchedule.map((s) => rot(s))
      : mv.liveDrawSchedule,
    scores: perm4(mv.scores),
    seatNames: mv.seatNames ? perm4(mv.seatNames) : mv.seatNames,
    dealer: rot(mv.dealer),
    riichiDeclared: perm4(mv.riichiDeclared),
    riichiTileIdx: perm4(mv.riichiTileIdx),
    currentWaits: mv.currentWaits ? perm4(mv.currentWaits) : mv.currentWaits,
    lastHandResult: rotatedResult,
    freshlyDrawnSeat:
      mv.freshlyDrawnSeat != null ? rot(mv.freshlyDrawnSeat) : null,
    matchEnded: mv.matchEnded
      ? {
          ...mv.matchEnded,
          finalScores: mv.matchEnded.finalScores.map((fs) => ({
            ...fs,
            seat: rot(fs.seat),
          })),
        }
      : mv.matchEnded,
  };
}
