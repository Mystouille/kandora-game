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
import type {
  GameEvent,
  Meld,
  RoomState,
  Seat,
  Tile,
} from "~/game/protocol/messages";
import type { MatchView } from "~/game/client/store";
import type { ReplayLog } from "./types";

export interface ReplayView {
  /** Hand-by-seat. `null` = unknown tile (opponent starting tiles
   * before first draw). Real `Tile` strings everywhere else. */
  hands: Array<Array<Tile | null>>;
  /** Open / declared melds per seat, in declaration order. */
  melds: Meld[][];
  discards: Tile[][];
  /** Parallel to `discards`: per-tile flag — `true` when the
   * discard was tsumogiri. Drives the brief darken cue in the
   * renderer, faded out by `discardOrdinals` + `totalDiscards`. */
  discardTsumogiri: boolean[][];
  /** Parallel to `discards`: per-tile cross-seat ordinal
   * (0-based) at the moment the discard landed. */
  discardOrdinals: number[][];
  /** Running count of discards in the current hand across all
   * seats. Reset on `hand_start`; incremented on every
   * `discard` event. */
  totalDiscards: number;
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
  /** Per-seat: is this seat currently "sinking" in Buu Mahjong
   * (score at or below `ruleSet.sinkThreshold`). Set from
   * `hand_start.sinking` and refreshed by `sinking_update`. Always
   * all-false in non-Buu modes. */
  sinking: [boolean, boolean, boolean, boolean];
  /** Per-seat in-game chip totals (Buu only; non-Buu sessions
   * keep this at `[0, 0, 0, 0]` throughout). */
  chips: [number, number, number, number];
  /** Per-seat dabuken (double-chip token) state (Buu only). */
  dabuken: [boolean, boolean, boolean, boolean];
  /** True iff this match is a Buu Mahjong session. Latched at
   * `match_start` from the wire `ruleSet` id. */
  buuMode: boolean;
  /** Active score-cap tier from the rule set, if any. Latched
   * at `match_start` from the wire `scoreCap` field. Drives the
   * win-panel label so a hand whose points have been clamped
   * shows the tier name (e.g. "Mangan") instead of the raw
   * han / yakuman value. `null` for rule sets without a cap. */
  scoreCap: "mangan" | "haneman" | "baiman" | "sanbaiman" | null;
  /** Per-seat: is this seat currently in furiten (any flavor).
   * Mirrors the engine's `isFuritenForRon` predicate and is
   * driven by `furiten` archived events. Drives the "Furiten"
   * indicator on each seat's leftmost tile. Reset on
   * `hand_start`. */
  furiten: [boolean, boolean, boolean, boolean];
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
    /** Per-seat concealed hands at exhaustive draw, populated
     * only for tenpai seats; `null` otherwise. */
    tenpaiHands?: (Tile[] | null)[];
    /** One entry per winner (multi-ron emits one `win` per
     * winner before the shared `hand_end`). */
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
    /** Buu Mahjong chombo metadata. Set when a `buu_chombo`
     * event precedes the abort `hand_end`, so the result panel
     * can render "Chombo: <reason>" instead of "Abort: unknown". */
    buuChombo?: {
      seat: Seat;
      reason:
        | "sinking_win_not_floating"
        | "game_ending_win_not_first"
        | "game_ending_chinmai";
      /** Per-seat chip delta from the chombo penalty (sums to zero). */
      chipDelta: number[];
      /** Per-seat in-game chip totals AFTER the penalty. */
      chips: number[];
    };
  };
  matchEnded: null | {
    reason:
      | "round_limit"
      | "busted"
      | "agari_yame"
      | "tenpai_yame"
      | "winner_threshold";
    finalScores: Array<{ seat: Seat; score: number; place: number }>;
    /** Session-level chip totals after this game (Buu only). */
    chips?: number[];
    /** Session-level dabuken state after this game (Buu only). */
    dabuken?: boolean[];
    /** Per-seat chip delta for THIS game only (Buu only). Drives
     * the "+N / −N" column shown next to each player's final
     * score in the renderer's match-end panel. */
    chipsDelta?: number[];
    /** Zero-based index of this game within its session (Buu only). */
    gameIndex?: number;
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

  /**
   * Mirror of `freshlyDrawnSeat` for the discard side: seat whose
   * latest discard tile is still "in flight" — the renderer offsets
   * just that one tile until the next draw / call / hand boundary
   * settles it flush against the pond.
   *
   * Set on every `discard`; cleared on `draw`, `call`,
   * `hand_start`, and `match_end`.
   */
  freshlyDiscardedSeat: Seat | null;
}

export function initialView(): ReplayView {
  return {
    hands: [[], [], [], []],
    melds: [[], [], [], []],
    discards: [[], [], [], []],
    discardTsumogiri: [[], [], [], []],
    discardOrdinals: [[], [], [], []],
    totalDiscards: 0,
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
    sinking: [false, false, false, false],
    chips: [0, 0, 0, 0],
    dabuken: [false, false, false, false],
    buuMode: false,
    scoreCap: null,
    riichiTileIdx: [null, null, null, null],
    lastHandResult: null,
    matchEnded: null,
    freshlyDrawnSeat: null,
    freshlyDiscardedSeat: null,
    furiten: [false, false, false, false],
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
      return {
        ...view,
        buuMode: event.ruleSet === "buu-east",
        scoreCap: event.scoreCap ?? null,
        chips: (event.chips ? [...event.chips] : view.chips) as [
          number,
          number,
          number,
          number,
        ],
        dabuken: (event.dabuken ? [...event.dabuken] : view.dabuken) as [
          boolean,
          boolean,
          boolean,
          boolean,
        ],
        lastHandResult: null,
        matchEnded: null,
      };
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
        discardTsumogiri: [[], [], [], []],
        discardOrdinals: [[], [], [], []],
        totalDiscards: 0,
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
        sinking: (event.sinking
          ? [...event.sinking]
          : [false, false, false, false]) as [
          boolean,
          boolean,
          boolean,
          boolean,
        ],
        chips: (event.chips ? [...event.chips] : view.chips) as [
          number,
          number,
          number,
          number,
        ],
        dabuken: (event.dabuken ? [...event.dabuken] : view.dabuken) as [
          boolean,
          boolean,
          boolean,
          boolean,
        ],
        riichiTileIdx: [null, null, null, null],
        lastHandResult: null,
        matchEnded: null,
        freshlyDrawnSeat: null,
        freshlyDiscardedSeat: null,
        furiten: [false, false, false, false],
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
        freshlyDiscardedSeat: null,
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
      // Parallel arrays for the fresh-tsumogiri darken cue.
      const discardTsumogiri = view.discardTsumogiri.map((a) => [...a]);
      discardTsumogiri[event.seat].push(event.tsumogiri);
      const discardOrdinals = view.discardOrdinals.map((a) => [...a]);
      discardOrdinals[event.seat].push(view.totalDiscards);
      const totalDiscards = view.totalDiscards + 1;
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
        discardTsumogiri,
        discardOrdinals,
        totalDiscards,
        riichiDeclared,
        riichiTileIdx,
        riichiSticks,
        scores,
        freshlyDrawnSeat: null,
        freshlyDiscardedSeat: event.seat,
      };
    }
    case "call": {
      const hands = view.hands.map((h) => [...h]);
      const discards = view.discards.map((d) => [...d]);
      const discardTsumogiri = view.discardTsumogiri.map((a) => [...a]);
      const discardOrdinals = view.discardOrdinals.map((a) => [...a]);
      const caller = event.seat;
      const meld = event.meld;
      // Remove the claimed tile from the discarder's pile (chi /
      // pon / daiminkan / shouminkan — ankan has `from === null`).
      // Keep the parallel tsumogiri / ordinal arrays in sync.
      if (meld.from !== null && meld.claimedTile !== null) {
        const pile = discards[meld.from];
        const idx = pile.lastIndexOf(meld.claimedTile);
        if (idx >= 0) {
          pile.splice(idx, 1);
          discardTsumogiri[meld.from].splice(idx, 1);
          discardOrdinals[meld.from].splice(idx, 1);
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
      return {
        ...view,
        hands,
        melds,
        discards,
        discardTsumogiri,
        discardOrdinals,
        freshlyDrawnSeat: null,
        freshlyDiscardedSeat: null,
      };
    }
    case "new_dora": {
      return {
        ...view,
        doraIndicators: [...view.doraIndicators, event.indicator],
      };
    }
    case "win": {
      const existing = view.lastHandResult;
      // Replay adapters don't all populate `hand` on the win
      // event (Riichi City, for example, omits it). Replays
      // always have full hand visibility, so fall back to the
      // current projected hand and — for ron — append the
      // winning tile so the panel and seat reveal both render
      // the complete 14-tile winning structure.
      const derivedHand: Tile[] | undefined = (() => {
        if (event.hand) {
          return [...event.hand];
        }
        const live = view.hands[event.seat] ?? [];
        const revealed = live.filter((t): t is Tile => t !== null);
        if (revealed.length === 0) {
          return undefined;
        }
        if (
          event.loser != null &&
          event.winTile &&
          !revealed.includes(event.winTile)
        ) {
          return [...revealed, event.winTile];
        }
        return revealed;
      })();
      const derivedMelds =
        event.melds?.map((m) => ({ ...m })) ??
        (view.melds[event.seat]?.map((m) => ({ ...m })) || undefined);
      const win = {
        seat: event.seat,
        loser: event.loser ?? null,
        winTile: event.winTile,
        han: event.han,
        fu: event.fu,
        ten: event.ten,
        yakumanCount: event.yakumanCount,
        yaku: event.yaku,
        hand: derivedHand,
        melds: derivedMelds,
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
          ? {
              ...existing,
              wins: existing.wins ? [...existing.wins, win] : [win],
            }
          : {
              // The `win` event may arrive before its matching
              // `hand_end` (Majsoul/Tenhou/Riichi-City all emit
              // both). Derive the reason from `loser`: a ron win
              // names the discarder, a tsumo win has none.
              reason: win.loser !== null ? "ron" : "tsumo",
              wins: [win],
            },
      };
    }
    case "hand_end": {
      const existingWins = view.lastHandResult?.wins;
      const existingBuuChombo = view.lastHandResult?.buuChombo;
      const eventWaits = event.waits;
      // Replay adapters (Majsoul / Tenhou / Riichi City) don't
      // populate `tenpaiHands` on `hand_end` the way the live
      // server does, but replays always have full hand
      // visibility — derive the field from the current projected
      // hands at exhaustive draw so the result panel + seat
      // reveal can show each tenpai player's wait.
      const derivedTenpaiHands: (Tile[] | null)[] | undefined =
        event.tenpaiHands
          ? event.tenpaiHands.map((h) => (h ? [...h] : null))
          : event.reason === "exhaustive_draw" && event.tenpai
            ? event.tenpai.map((isTenpai, s) => {
                if (!isTenpai) {
                  return null;
                }
                const hand = view.hands[s] ?? [];
                const revealed = hand.filter((t): t is Tile => t !== null);
                return revealed.length > 0 ? revealed : null;
              })
            : undefined;
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
          ...(derivedTenpaiHands ? { tenpaiHands: derivedTenpaiHands } : {}),
          ...(existingWins ? { wins: existingWins } : {}),
          ...(existingBuuChombo ? { buuChombo: existingBuuChombo } : {}),
        },
      };
    }
    case "match_end": {
      return {
        ...view,
        // Roll the post-game session-level chip / dabuken totals
        // into the top-level view fields so the player-info
        // squares pick up the delta applied this game; mirrors
        // the live store handler.
        ...(event.chips
          ? {
              chips: [
                event.chips[0],
                event.chips[1],
                event.chips[2],
                event.chips[3],
              ] as [number, number, number, number],
            }
          : {}),
        ...(event.dabuken
          ? {
              dabuken: [
                event.dabuken[0],
                event.dabuken[1],
                event.dabuken[2],
                event.dabuken[3],
              ] as [boolean, boolean, boolean, boolean],
            }
          : {}),
        matchEnded: {
          reason: event.reason,
          finalScores: event.finalScores,
          ...(event.chips ? { chips: [...event.chips] } : {}),
          ...(event.dabuken ? { dabuken: [...event.dabuken] } : {}),
          ...(event.chipsDelta ? { chipsDelta: [...event.chipsDelta] } : {}),
          ...(event.gameIndex !== undefined
            ? { gameIndex: event.gameIndex }
            : {}),
        },
      };
    }
    case "furiten": {
      const furiten = [...view.furiten] as [boolean, boolean, boolean, boolean];
      furiten[event.seat] = event.active;
      return { ...view, furiten };
    }
    case "sinking_update": {
      return {
        ...view,
        sinking: [
          event.sinking[0],
          event.sinking[1],
          event.sinking[2],
          event.sinking[3],
        ],
      };
    }
    case "buu_chombo": {
      // Stash chombo offender + reason + chip info on
      // `lastHandResult` so the following abort `hand_end`
      // carries it through to the renderer (see store.ts for
      // the parallel live path). Also update the live `chips`
      // for the player-name box (the abort `hand_end` itself
      // carries no chip delta).
      const existing = view.lastHandResult;
      return {
        ...view,
        chips: [...event.chips] as [number, number, number, number],
        lastHandResult: {
          ...(existing ?? { reason: "abort" as const }),
          buuChombo: {
            seat: event.seat,
            reason: event.reason,
            chipDelta: [...event.chipDelta],
            chips: [...event.chips],
          },
        },
      };
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
    /** Live `room_state` from the spectator socket. Carries the
     * per-seat `connected` flag so the renderer can paint a
     * "disconnected" badge on nameplates. */
    roomState?: RoomState | null;
  }
): MatchView {
  const focus: Seat = opts.mySeat ?? 0;
  const base: MatchView = {
    matchId: opts.matchId ?? null,
    mySeat: 0,
    hands: view.hands,
    melds: view.melds,
    discards: view.discards,
    discardTsumogiri: view.discardTsumogiri,
    discardOrdinals: view.discardOrdinals,
    totalDiscards: view.totalDiscards,
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
    actionDeadline: null,
    actionBufferMs: null,
    readyCheck: null,
    scores: view.scores,
    seatNames: opts.seatNames ?? null,
    dealer: view.dealer,
    roundWind: view.roundWind,
    roundNumber: view.roundNumber,
    honba: view.honba,
    riichiSticks: view.riichiSticks,
    riichiDeclared: view.riichiDeclared,
    riichiTileIdx: view.riichiTileIdx,
    sinking: view.sinking,
    chips: view.chips,
    dabuken: view.dabuken,
    buuMode: view.buuMode,
    scoreCap: view.scoreCap,
    lastHandResult: view.lastHandResult,
    matchEnded: view.matchEnded,
    currentWaits: opts.currentWaits ?? null,
    freshlyDrawnSeat: view.freshlyDrawnSeat,
    freshlyDiscardedSeat: view.freshlyDiscardedSeat,
    furiten: view.furiten,
    // Replays never enter a live waiting room. Spectators can
    // opt in via `opts.roomState` so the disconnect badge works
    // in the live spectator view.
    roomState: opts.roomState ?? null,
    // Replays don't drive session-level vote / end UI.
    sessionVote: null,
    sessionEnded: null,
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
export function rotateMatchView(mv: MatchView, focus: Seat): MatchView {
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
        tenpaiHands: result.tenpaiHands
          ? perm4(result.tenpaiHands)
          : result.tenpaiHands,
        wins: result.wins
          ? result.wins.map((w) => ({
              ...w,
              seat: rot(w.seat),
              loser: w.loser != null ? rot(w.loser) : w.loser,
            }))
          : result.wins,
        buuChombo: result.buuChombo
          ? {
              ...result.buuChombo,
              seat: rot(result.buuChombo.seat),
              chipDelta: perm4(result.buuChombo.chipDelta),
              chips: perm4(result.buuChombo.chips),
            }
          : result.buuChombo,
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
    discardTsumogiri: perm4(mv.discardTsumogiri),
    discardOrdinals: perm4(mv.discardOrdinals),
    liveDrawSchedule: mv.liveDrawSchedule
      ? mv.liveDrawSchedule.map((s) => rot(s))
      : mv.liveDrawSchedule,
    scores: perm4(mv.scores),
    seatNames: mv.seatNames ? perm4(mv.seatNames) : mv.seatNames,
    dealer: rot(mv.dealer),
    riichiDeclared: perm4(mv.riichiDeclared),
    riichiTileIdx: perm4(mv.riichiTileIdx),
    sinking: perm4(mv.sinking),
    chips: perm4(mv.chips),
    dabuken: perm4(mv.dabuken),
    furiten: perm4(mv.furiten),
    currentWaits: mv.currentWaits ? perm4(mv.currentWaits) : mv.currentWaits,
    lastHandResult: rotatedResult,
    freshlyDrawnSeat:
      mv.freshlyDrawnSeat != null ? rot(mv.freshlyDrawnSeat) : null,
    freshlyDiscardedSeat:
      mv.freshlyDiscardedSeat != null ? rot(mv.freshlyDiscardedSeat) : null,
    pendingDiscard: mv.pendingDiscard
      ? { ...mv.pendingDiscard, seat: rot(mv.pendingDiscard.seat) }
      : mv.pendingDiscard,
    matchEnded: mv.matchEnded
      ? {
          ...mv.matchEnded,
          finalScores: mv.matchEnded.finalScores.map((fs) => ({
            ...fs,
            seat: rot(fs.seat),
          })),
          ...(mv.matchEnded.chips
            ? { chips: [...perm4(mv.matchEnded.chips)] }
            : {}),
          ...(mv.matchEnded.dabuken
            ? { dabuken: [...perm4(mv.matchEnded.dabuken)] }
            : {}),
          ...(mv.matchEnded.chipsDelta
            ? { chipsDelta: [...perm4(mv.matchEnded.chipsDelta)] }
            : {}),
        }
      : mv.matchEnded,
    // Permute room composition so the disconnect badge in the
    // renderer can read `roomState.seats[seatIdx]` using the
    // same focused-relative indexing as `seatNames`. The
    // occupant's nominal `seat` field stays as the absolute seat
    // value, but the array slot is the rotated index.
    roomState: mv.roomState
      ? {
          ...mv.roomState,
          mySeat: mv.roomState.mySeat != null ? rot(mv.roomState.mySeat) : null,
          seats: perm4(mv.roomState.seats).map((rs, i) => ({
            ...rs,
            seat: i as Seat,
          })),
        }
      : mv.roomState,
  };
}
