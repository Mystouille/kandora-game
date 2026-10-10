import {
  activeSeats,
  copySeatValues,
  nextSeat,
  seatValues,
} from "~/game/rules/seats";
import { type SeatValues } from "~/game/protocol/seat";
import {
  applyNukiEvent,
  emptyParticipantState,
  initialLiveWallCount,
  type VariantView,
} from "~/game/client/variantState";
import { rotateMatchView } from "~/game/client/tableProjection";
import { replayVariant } from "./variant";
import { isPlayableTile } from "~/game/rules/tileAvailability";
export {
  rotateHandResult,
  rotateMatchView,
  rotateSeatValues,
} from "~/game/client/tableProjection";
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
  DuplicateWallState,
  GameEvent,
  Meld,
  RoomState,
  Seat,
  Tile,
} from "~/game/protocol/messages";
import type { MatchView } from "~/game/client/store";
import type { ReplayLog } from "./types";
import { discardIndexForSource } from "~/game/client/discardActions";
import {
  cloneDuplicateDrawQueues,
  duplicateWallStateAfterEvent,
  type DuplicateDrawQueues,
} from "~/game/duplicate/duplicateWallState";

export interface ReplayView extends VariantView {
  nukiTiles?: Tile[][];
  flowerTiles: Tile[][];
  pendingNuki?: MatchView["pendingNuki"];
  pendingFlower?: MatchView["pendingFlower"];
  sanmaWall?: MatchView["sanmaWall"];
  turn?: Seat;
  phase?: string;
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
  /** Authoritative source when present; null for legacy/external events. */
  discardSources?: Array<Array<"hand" | "draw" | null>>;
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
  /** Post-deal draw events, including opening and replacement draws. */
  drawsTaken: number;
  /** Ordinary draws. Sanma replacements are excluded by cause,
   * including Duplicate draws sourced from personal live queues.
   * Standard wall rendering uses this to advance its draw end. */
  liveDrawsTaken: number;
  /** Live-wall draw schedule for the current hand:
   * `liveDrawSchedule[i]` is the seat that draws `liveWall[i]`.
   * `null` when the hand_start event didn't carry one (live
   * matches, or archives that pre-date the annotation pass). */
  liveDrawSchedule: Seat[] | null;
  /** Public count-only duplicate wall state. */
  duplicateWallState: DuplicateWallState | null;
  /** Full duplicate queues, present only in completed archives. */
  duplicateDrawQueues: DuplicateDrawQueues | null;
  /** Two dice rolled at the start of the current hand; `null` when
   * the source log doesn't record dice (older synthetic logs). */
  dice: [number, number] | null;
  doraIndicators: Tile[];
  scores: SeatValues<number>;
  seatNames: SeatValues<string> | null;
  dealer: Seat;
  roundWind: "E" | "S" | "W" | "N";
  roundNumber: number;
  honba: number;
  riichiSticks: number;
  riichiDeclared: SeatValues<boolean>;
  /** Public exhaustive-draw declaration state. */
  ryuukyokuDeclarations: SeatValues<boolean | null>;
  /** Concealed hands revealed by Tenpai declarations. */
  ryuukyokuTenpaiHands: SeatValues<Tile[] | null>;
  /** Per-seat: is this seat currently "sinking" in Buu Mahjong
   * (score at or below `ruleSet.sinkThreshold`). Set from
   * `hand_start.sinking` and refreshed by `sinking_update`. Always
   * all-false in non-Buu modes. */
  sinking: SeatValues<boolean>;
  /** Per-seat in-game chip totals (Buu only; non-Buu sessions
   * keep this at `[0, 0, 0, 0]` throughout). */
  chips: SeatValues<number>;
  /** Per-seat dabuken (double-chip token) state (Buu only). */
  dabuken: SeatValues<boolean>;
  /** True iff this match is a Buu Mahjong session. Latched at
   * `match_start` from the wire `ruleSet` id. */
  buuMode: boolean;
  /** Point value of a single riichi stick (`RuleSet.riichiBetValue`).
   * Latched at `match_start`. Drives the optimistic mid-hand
   * score deduction when a seat declares riichi so replays
   * archived under non-standard rule sets (e.g. Buu = 100)
   * render the correct delta. Defaults to 1000 (standard riichi)
   * for back-compat with replays archived before the field was
   * added. */
  riichiBetValue: number;
  /** Active score-cap tier from the rule set, if any. Latched
   * at `match_start` from the wire `scoreCap` field. Drives the
   * win-panel label so a hand whose points have been clamped
   * shows the tier name (e.g. "Mangan") instead of the raw
   * han / yakuman value. `null` for rule sets without a cap. */
  scoreCap: "mangan" | "haneman" | "baiman" | "sanbaiman" | null;
  /** Whether the active rule set permits ura dora. */
  uraDoraEnabled: boolean;
  /** Per-seat: is this seat currently in furiten (any flavor).
   * Mirrors the engine's `isFuritenForRon` predicate and is
   * driven by `furiten` archived events. Drives the "Furiten"
   * indicator on each seat's leftmost tile. Reset on
   * `hand_start`. */
  furiten: SeatValues<boolean>;
  /** Per-seat: index into `discards[seat]` of the riichi declaration
   * tile (null when the seat hasn't declared). Used to render the
   * tilted tile. */
  riichiTileIdx: SeatValues<number | null>;
  /** Last completed hand's result panel payload (cleared on next
   * `hand_start`). Same shape the live store uses, minus the
   * optimistic-discard concerns. */
  lastHandResult: null | {
    reason: "exhaustive_draw" | "ron" | "tsumo" | "abort";
    /** Dealer for the completed hand. Optional for legacy replay data. */
    dealer?: Seat;
    abortKind?: "kyuushuu" | "suufon_renda" | "suucha_riichi" | "sanchahou";
    delta?: number[];
    tenpai?: boolean[];
    nagashi?: boolean[];
    scores?: number[];
    honba?: number;
    riichiSticks?: number;
    declarations?: Array<{ seat: Seat; tenpai: boolean }>;
    /** Per-seat wait tiles at hand end (length 4). `null` for
     * seats not in tenpai; absent when the source log doesn't
     * record waits. Drives the `showWaits` overlay in the
     * renderer. */
    waits?: (Tile[] | null)[];
    /** Per-seat concealed hands revealed at hand end: every tenpai
     * seat at an exhaustive draw, or just the declaring seat at a
     * kyuushuu kyuuhai abort. `null` for seats that don't reveal. */
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
      scoringFamily?: "riichi" | "mcr";
      fan?: Array<{
        id: string;
        name: string;
        count: number;
        points: number;
      }>;
      totalFan?: number;
      nonFlowerFan?: number;
      doraCount?: number;
      akaDoraCount?: number;
      uraDoraCount?: number;
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

export function initialView(variant: VariantView = {}): ReplayView {
  const rulesFamily = variant.rulesFamily ?? "riichi";
  return {
    ...emptyParticipantState(variant.playerCount ?? 4),
    rulesFamily,
    scores: seatValues(variant.playerCount ?? 4, () =>
      rulesFamily === "mcr" ? 0 : 25000
    ),
    sanmaType: variant.sanmaType ?? "online",
    sanmaWall: null,
    turn: 0,
    phase: rulesFamily === "mcr" ? "awaiting_discard" : "awaiting_draw",
    totalDiscards: 0,
    wallRemaining: initialLiveWallCount(variant),
    liveWall: null,
    deadWall: null,
    drawsTaken: 0,
    liveDrawsTaken: 0,
    liveDrawSchedule: null,
    duplicateWallState: null,
    duplicateDrawQueues: null,
    dice: null,
    doraIndicators: [],
    seatNames: null,
    dealer: 0,
    roundWind: "E",
    roundNumber: 1,
    honba: 0,
    riichiSticks: 0,
    buuMode: false,
    riichiBetValue: 1000,
    scoreCap: null,
    uraDoraEnabled: true,
    lastHandResult: null,
    matchEnded: null,
    freshlyDrawnSeat: null,
    freshlyDiscardedSeat: null,
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
      const rulesFamily = event.rulesFamily ?? "riichi";
      const playerCount = event.playerCount ?? view.playerCount ?? 4;
      const sanmaType = event.sanmaType ?? view.sanmaType ?? "online";
      const seatNames =
        event.seats.length === 0
          ? view.seatNames
          : seatValues(
              playerCount,
              (seat) =>
                event.seats.find((entry) => entry.seat === seat)
                  ?.displayName ?? ""
            );
      return {
        ...view,
        ...emptyParticipantState(playerCount),
        rulesFamily,
        sanmaType,
        sanmaWall: null,
        dealer: 0,
        turn: 0,
        phase: rulesFamily === "mcr" ? "awaiting_discard" : "awaiting_draw",
        wallRemaining: initialLiveWallCount({
          rulesFamily,
          playerCount,
          sanmaType,
        }),
        drawsTaken: 0,
        liveDrawsTaken: 0,
        liveWall: null,
        deadWall: null,
        liveDrawSchedule: null,
        freshlyDrawnSeat: null,
        freshlyDiscardedSeat: null,
        buuMode: event.ruleSet === "buu-east",
        riichiBetValue: event.riichiBetValue ?? view.riichiBetValue,
        scoreCap: event.scoreCap ?? null,
        uraDoraEnabled: event.uraDoraEnabled ?? true,
        chips: event.chips
          ? copySeatValues(event.chips)
          : seatValues(playerCount, () => 0),
        dabuken: event.dabuken
          ? copySeatValues(event.dabuken)
          : seatValues(playerCount, () => false),
        lastHandResult: null,
        matchEnded: null,
        duplicateWallState: null,
        duplicateDrawQueues: null,
        seatNames,
      };
    }
    case "hand_start": {
      const rulesFamily = event.rulesFamily ?? view.rulesFamily ?? "riichi";
      const playerCount = event.playerCount ?? view.playerCount ?? 4;
      const sanmaType = event.sanmaType ?? view.sanmaType ?? "online";
      // Archived `hand_start` events always carry the omniscient
      // `startingHands` snapshot (Phase 4.5 step 5 — Option B).
      // Both writers — `archiveReplayLog` in `game-server` and the
      // Majsoul / Tenhou / Riichi City platform adapters — fill
      // this in. An absent value is treated as a writer bug; we
      // degrade to empty hands rather than crash so a malformed
      // log still renders the rest of the match.
      const hands = seatValues(playerCount, (seat) => [
        ...(event.startingHands?.[seat] ?? []),
      ]);
      return {
        ...view,
        ...emptyParticipantState(playerCount),
        rulesFamily,
        sanmaType,
        sanmaWall: event.sanmaWall ? { ...event.sanmaWall } : null,
        nukiTiles: seatValues(playerCount, (seat) => [
          ...(event.nukiTiles?.[seat] ?? []),
        ]),
        flowerTiles: seatValues(4, (seat) => [
          ...(event.flowerTiles?.[seat] ?? []),
        ]),
        pendingFlower: null,
        hands,
        totalDiscards: 0,
        doraIndicators: [...event.doraIndicators],
        wallRemaining:
          rulesFamily === "mcr"
            ? (event.liveWall?.length ??
              91 -
                (event.flowerTiles?.reduce(
                  (total, tiles) => total + tiles.length,
                  0
                ) ?? 0))
            : initialLiveWallCount(
                { rulesFamily, playerCount, sanmaType },
                event.sanmaWall?.mode === "duplicate" ||
                  !!event.duplicateWallState ||
                  !!event.duplicateDrawQueues
              ),
        liveWall: event.liveWall ? [...event.liveWall] : null,
        deadWall: event.deadWall ? [...event.deadWall] : null,
        drawsTaken: 0,
        liveDrawsTaken: 0,
        liveDrawSchedule: event.liveDrawSchedule
          ? [...event.liveDrawSchedule]
          : null,
        duplicateWallState: duplicateWallStateAfterEvent(
          view.duplicateWallState,
          event,
          view.dealer
        ),
        duplicateDrawQueues: event.duplicateDrawQueues
          ? cloneDuplicateDrawQueues(event.duplicateDrawQueues)
          : null,
        dice: event.dice ? [event.dice[0], event.dice[1]] : null,
        dealer: event.dealer,
        turn: event.dealer,
        phase: rulesFamily === "mcr" ? "awaiting_discard" : "awaiting_draw",
        roundWind: event.roundWind ?? view.roundWind,
        roundNumber: event.roundNumber ?? view.roundNumber,
        honba: event.honba ?? 0,
        riichiSticks: event.riichiSticks ?? 0,
        scores: seatValues(
          playerCount,
          (seat) =>
            event.scores?.[seat] ??
            view.scores[seat] ??
            (rulesFamily === "mcr" ? 0 : 25000)
        ),
        seatNames: event.seatNames
          ? copySeatValues(event.seatNames)
          : view.seatNames,
        sinking: (event.sinking
          ? copySeatValues(event.sinking)
          : seatValues(playerCount, () => false)) as SeatValues<boolean>,
        chips: seatValues(
          playerCount,
          (seat) => event.chips?.[seat] ?? view.chips[seat] ?? 0
        ),
        dabuken: seatValues(
          playerCount,
          (seat) => event.dabuken?.[seat] ?? view.dabuken[seat] ?? false
        ),
        lastHandResult: null,
        matchEnded: null,
        freshlyDrawnSeat: rulesFamily === "mcr" ? event.dealer : null,
        freshlyDiscardedSeat: null,
      };
    }
    case "draw": {
      const hands = view.hands.map((h) => [...h]);
      // Unprojected draws always carry a tile; fall back to `null`
      // defensively for safety against malformed logs.
      hands[event.seat].push(event.tile ?? null);
      return {
        ...view,
        sanmaWall: event.sanmaWall ? { ...event.sanmaWall } : view.sanmaWall,
        turn: event.opening ? view.dealer : event.seat,
        phase:
          event.opening ? "awaiting_draw" : "awaiting_discard",
        pendingFlower:
          event.replacementKind === "flower" ? null : view.pendingFlower,
        pendingNuki: event.replacementKind === "nuki" ? null : view.pendingNuki,
        hands,
        wallRemaining: event.wallRemaining,
        drawsTaken: view.drawsTaken + 1,
        liveDrawsTaken:
          event.fromDeadWall || event.replacementKind !== undefined
            ? view.liveDrawsTaken
            : view.liveDrawsTaken + 1,
        freshlyDrawnSeat: event.opening ? view.freshlyDrawnSeat : event.seat,
        freshlyDiscardedSeat: null,
        duplicateWallState: duplicateWallStateAfterEvent(
          view.duplicateWallState,
          event,
          view.dealer
        ),
      };
    }
    case "nuki": {
      return {
        ...view,
        ...applyNukiEvent(view, event),
        turn: event.opening ? view.dealer : event.seat,
        phase:
          event.stage === "declared"
            ? "awaiting_chankan"
            : "awaiting_nuki_replacement",
        sanmaWall: event.sanmaWall ? { ...event.sanmaWall } : view.sanmaWall,
        duplicateWallState: duplicateWallStateAfterEvent(
          view.duplicateWallState,
          event,
          view.dealer
        ),
        freshlyDrawnSeat: event.opening ? view.freshlyDrawnSeat : null,
        freshlyDiscardedSeat: null,
      };
    }
    case "flower": {
      const hands = view.hands.map((hand) => [...hand]);
      let flowerIndex = hands[event.seat].lastIndexOf(event.tile);
      if (flowerIndex < 0) {
        flowerIndex = hands[event.seat].lastIndexOf(null);
      }
      if (flowerIndex >= 0) {
        hands[event.seat].splice(flowerIndex, 1);
      }
      const flowerTiles = view.flowerTiles.map((tiles) => [...tiles]);
      flowerTiles[event.seat].push(event.tile);
      return {
        ...view,
        hands,
        flowerTiles,
        pendingFlower: null,
        freshlyDrawnSeat: null,
      };
    }
    case "discard": {
      const hands = view.hands.map((h) => [...h]);
      // Unprojected log: prefer the real-tile match. If no match
      // (legacy logs that pre-date enrichment), drop a `null`
      // placeholder so the hand size stays correct.
      const pile = hands[event.seat];
      let idx = discardIndexForSource(
        pile,
        event.tile,
        event.discardSource,
        view.freshlyDrawnSeat === event.seat
      );
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
      const discardSources = (
        view.discardSources ?? view.hands.map(() => [])
      ).map((sources) => [...sources]);
      discardSources[event.seat].push(event.discardSource ?? null);
      const discardOrdinals = view.discardOrdinals.map((a) => [...a]);
      discardOrdinals[event.seat].push(view.totalDiscards);
      const totalDiscards = view.totalDiscards + 1;
      const riichiDeclared = event.riichi
        ? ((): SeatValues<boolean> => {
            const arr = copySeatValues(view.riichiDeclared);
            arr[event.seat] = true;
            return arr;
          })()
        : view.riichiDeclared;
      const riichiTileIdx = event.riichi
        ? ((): SeatValues<number | null> => {
            const arr = copySeatValues(view.riichiTileIdx);
            arr[event.seat] = discards[event.seat].length - 1;
            return arr;
          })()
        : view.riichiTileIdx;
      // When a player declares riichi, visually bump the stick
      // counter and deduct the rule set's `riichiBetValue`
      // (latched at `match_start`) from the declarer's score.
      // The authoritative `scores` / `riichiSticks` are re-set
      // at the next hand boundary; this just keeps the table
      // state visually consistent mid-hand. Hardcoding 1000 here
      // misrepresented the score under non-standard bets
      // (e.g. Buu = 100).
      let riichiSticks = view.riichiSticks;
      let scores = view.scores;
      if (event.riichi) {
        riichiSticks = view.riichiSticks + 1;
        const next = copySeatValues(view.scores);
        next[event.seat] = next[event.seat] - view.riichiBetValue;
        scores = next;
      }
      return {
        ...view,
        hands,
        discards,
        discardTsumogiri,
        discardSources,
        discardOrdinals,
        totalDiscards,
        turn: nextSeat(event.seat, view.playerCount ?? 4),
        phase: "awaiting_draw",
        riichiDeclared,
        riichiTileIdx,
        riichiSticks,
        scores,
        freshlyDrawnSeat: null,
        freshlyDiscardedSeat: event.seat,
        duplicateWallState: duplicateWallStateAfterEvent(
          view.duplicateWallState,
          event,
          view.dealer
        ),
      };
    }
    case "ryuukyoku_declaration": {
      const ryuukyokuDeclarations = copySeatValues(view.ryuukyokuDeclarations);
      ryuukyokuDeclarations[event.seat] = event.tenpai;
      const ryuukyokuTenpaiHands = view.ryuukyokuTenpaiHands.map((hand) =>
        hand ? [...hand] : null
      ) as ReplayView["ryuukyokuTenpaiHands"];
      if (!event.tenpai) {
        ryuukyokuTenpaiHands[event.seat] = null;
      } else if (event.hand) {
        ryuukyokuTenpaiHands[event.seat] = [...event.hand];
      } else {
        const hand = view.hands[event.seat].filter(
          (tile): tile is Tile => tile !== null
        );
        ryuukyokuTenpaiHands[event.seat] = hand.length > 0 ? hand : null;
      }
      return {
        ...view,
        ryuukyokuDeclarations,
        ryuukyokuTenpaiHands,
      };
    }
    case "call": {
      const hands = view.hands.map((h) => [...h]);
      const discards = view.discards.map((d) => [...d]);
      const discardTsumogiri = view.discardTsumogiri.map((a) => [...a]);
      const discardSources = (
        view.discardSources ?? view.hands.map(() => [])
      ).map((sources) => [...sources]);
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
          discardSources[meld.from].splice(idx, 1);
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
      const hiddenAnkan = meld.type === "ankan" && contributed.length === 0;
      if (hiddenAnkan) {
        const hand = hands[caller];
        for (let count = 0; count < 4; count++) {
          const hiddenIndex = hand.indexOf(null);
          hand.splice(hiddenIndex >= 0 ? hiddenIndex : hand.length - 1, 1);
        }
      }
      for (const t of hiddenAnkan ? [] : contributed) {
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
        discardSources,
        discardOrdinals,
        turn: event.seat,
        phase:
          meld.type === "pon" || meld.type === "chi"
            ? "awaiting_discard"
            : "awaiting_chankan",
        freshlyDrawnSeat: null,
        freshlyDiscardedSeat: null,
        duplicateWallState: duplicateWallStateAfterEvent(
          view.duplicateWallState,
          event,
          view.dealer
        ),
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
        scoringFamily: event.scoringFamily,
        han: event.han,
        fu: event.fu,
        ten: event.ten,
        yakumanCount: event.yakumanCount,
        yaku: event.yaku,
        fan: event.fan?.map((entry) => ({ ...entry })),
        totalFan: event.totalFan,
        nonFlowerFan: event.nonFlowerFan,
        doraCount: event.doraCount,
        akaDoraCount: event.akaDoraCount,
        uraDoraCount: event.uraDoraCount,
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
              dealer: existing.dealer ?? view.dealer,
              wins: existing.wins ? [...existing.wins, win] : [win],
            }
          : {
              // The `win` event may arrive before its matching
              // `hand_end` (Majsoul/Tenhou/Riichi-City all emit
              // both). Derive the reason from `loser`: a ron win
              // names the discarder, a tsumo win has none.
              reason: win.loser !== null ? "ron" : "tsumo",
              dealer: view.dealer,
              wins: [win],
            },
        phase: "hand_end",
      };
    }
    case "hand_end": {
      const existingWins = view.lastHandResult?.wins;
      const existingBuuChombo = view.lastHandResult?.buuChombo;
      const eventWaits = event.waits;
      const declarationTenpai = event.declarations
        ? event.declarations.reduce<SeatValues<boolean>>(
            (tenpai, declaration) => {
              tenpai[declaration.seat] = declaration.tenpai;
              return tenpai;
            },
            seatValues(view.playerCount ?? 4, () => false)
          )
        : undefined;
      // Replay adapters (Majsoul / Tenhou / Riichi City) don't
      // populate `tenpaiHands` on `hand_end` the way the live
      // server does, but replays always have full hand
      // visibility — derive the field from the current projected
      // hands at exhaustive draw so the result panel + seat
      // reveal can show each tenpai player's wait.
      const derivedTenpaiHands: (Tile[] | null)[] | undefined =
        event.tenpaiHands
          ? event.tenpaiHands.map((h) => (h ? [...h] : null))
          : event.reason === "exhaustive_draw" &&
              (event.tenpai || declarationTenpai)
            ? (event.tenpai ?? declarationTenpai)?.map((isTenpai, s) => {
                if (!isTenpai) {
                  return null;
                }
                const hand = view.hands[s] ?? [];
                const revealed = hand.filter((t): t is Tile => t !== null);
                return revealed.length > 0 ? revealed : null;
              })
            : // Kyuushuu kyuuhai: reveal only the declaring seat's
              // concealed 14-tile hand (the ≥9 terminals/honors that
              // justified the abort). The declarer is the seat that
              // just drew and declared before discarding, so
              // `freshlyDrawnSeat` points straight at it. Replay logs
              // never carry `tenpaiHands` for aborts, so derive it here
              // from the omniscient view.
              event.reason === "abort" &&
                event.abortKind === "kyuushuu" &&
                view.freshlyDrawnSeat !== null
              ? activeSeats(view.playerCount ?? 4).map((s) => {
                  if (s !== view.freshlyDrawnSeat) {
                    return null;
                  }
                  const hand = view.hands[s] ?? [];
                  const revealed = hand.filter((t): t is Tile => t !== null);
                  return revealed.length > 0 ? revealed : null;
                })
              : undefined;
      const ryuukyokuDeclarations = event.declarations
        ? event.declarations.reduce<ReplayView["ryuukyokuDeclarations"]>(
            (declarations, declaration) => {
              declarations[declaration.seat] = declaration.tenpai;
              return declarations;
            },
            copySeatValues(view.ryuukyokuDeclarations)
          )
        : view.ryuukyokuDeclarations;
      const ryuukyokuTenpaiHands =
        event.declarations && derivedTenpaiHands
          ? (derivedTenpaiHands.map((hand) =>
              hand ? [...hand] : null
            ) as ReplayView["ryuukyokuTenpaiHands"])
          : view.ryuukyokuTenpaiHands;
      return {
        ...view,
        ryuukyokuDeclarations,
        ryuukyokuTenpaiHands,
        phase: "hand_end",
        scores: (event.scores ?? view.scores) as SeatValues<number>,
        riichiSticks: event.riichiSticks ?? view.riichiSticks,
        lastHandResult: {
          reason: event.reason,
          dealer: view.dealer,
          ...(event.abortKind ? { abortKind: event.abortKind } : {}),
          ...(event.delta ? { delta: [...event.delta] } : {}),
          ...(event.tenpai ? { tenpai: [...event.tenpai] } : {}),
          ...(event.nagashi ? { nagashi: [...event.nagashi] } : {}),
          ...(event.scores ? { scores: [...event.scores] } : {}),
          ...(event.honba !== undefined ? { honba: event.honba } : {}),
          ...(event.riichiSticks !== undefined
            ? { riichiSticks: event.riichiSticks }
            : {}),
          ...(event.declarations
            ? {
                declarations: event.declarations.map((declaration) => ({
                  ...declaration,
                })),
              }
            : {}),
          ...(eventWaits
            ? { waits: eventWaits.map((w) => (w ? [...w] : null)) }
            : {}),
          ...(derivedTenpaiHands ? { tenpaiHands: derivedTenpaiHands } : {}),
          ...(existingWins ? { wins: existingWins } : {}),
          ...(existingBuuChombo ? { buuChombo: existingBuuChombo } : {}),
        },
        duplicateWallState: duplicateWallStateAfterEvent(
          view.duplicateWallState,
          event,
          view.dealer
        ),
      };
    }
    case "match_end": {
      return {
        ...view,
        phase: "match_end",
        duplicateWallState: duplicateWallStateAfterEvent(
          view.duplicateWallState,
          event,
          view.dealer
        ),
        // Roll the post-game session-level chip / dabuken totals
        // into the top-level view fields so the player-info
        // squares pick up the delta applied this game; mirrors
        // the live store handler.
        ...(event.chips
          ? {
              chips: copySeatValues(event.chips),
            }
          : {}),
        ...(event.dabuken
          ? {
              dabuken: copySeatValues(event.dabuken),
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
      const furiten = copySeatValues(view.furiten);
      furiten[event.seat] = event.active;
      return { ...view, furiten };
    }
    case "sinking_update": {
      return {
        ...view,
        sinking: copySeatValues(event.sinking),
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
        chips: copySeatValues(event.chips),
        lastHandResult: {
          ...(existing ?? { reason: "abort" as const }),
          dealer: existing?.dealer ?? view.dealer,
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
  let view = initialView(replayVariant(log));
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
    seatNames?: SeatValues<string> | null;
    /** Per-seat wait tiles at this step, derived from waits recorded
     * on replay events. `null` when no recorded data is available. */
    currentWaits?: Tile[][] | null;
    /** Live `room_state` from the spectator socket. Carries the
     * per-seat `connected` flag so the renderer can paint a
     * "disconnected" badge on nameplates. */
    roomState?: RoomState | null;
  }
): MatchView {
  const focus: Seat =
    opts.mySeat !== undefined && opts.mySeat < (view.playerCount ?? 4)
      ? opts.mySeat
      : 0;
  const base: MatchView = {
    rulesFamily: view.rulesFamily ?? "riichi",
    playerCount: view.playerCount,
    sanmaType: view.sanmaType,
    nukiTiles: view.nukiTiles,
    flowerTiles: view.flowerTiles,
    pendingNuki: view.pendingNuki,
    pendingFlower: view.pendingFlower,
    sanmaWall: view.sanmaWall,
    turn: view.turn,
    phase: view.phase,
    matchId: opts.matchId ?? null,
    mySeat: 0,
    hands: view.hands,
    melds: view.melds,
    discards: view.discards,
    discardTsumogiri: view.discardTsumogiri,
    discardSources: view.discardSources,
    discardOrdinals: view.discardOrdinals,
    totalDiscards: view.totalDiscards,
    wallRemaining: view.wallRemaining,
    liveWall: view.liveWall,
    deadWall: view.deadWall,
    drawsTaken: view.drawsTaken,
    liveDrawsTaken: view.liveDrawsTaken,
    liveDrawSchedule: view.liveDrawSchedule,
    duplicateWallState: view.duplicateWallState,
    duplicateDrawQueues: view.duplicateDrawQueues,
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
    seatNames:
      view.seatNames ??
      (opts.seatNames
        ? seatValues(
            view.playerCount ?? 4,
            (seat) => opts.seatNames?.[seat] ?? ""
          )
        : null),
    dealer: view.dealer,
    roundWind: view.roundWind,
    roundNumber: view.roundNumber,
    honba: view.honba,
    riichiSticks: view.riichiSticks,
    riichiDeclared: view.riichiDeclared,
    ryuukyokuDeclarations: view.ryuukyokuDeclarations,
    ryuukyokuTenpaiHands: view.ryuukyokuTenpaiHands,
    riichiTileIdx: view.riichiTileIdx,
    sinking: view.sinking,
    chips: view.chips,
    dabuken: view.dabuken,
    buuMode: view.buuMode,
    riichiBetValue: view.riichiBetValue,
    scoreCap: view.scoreCap,
    uraDoraEnabled: view.uraDoraEnabled,
    lastHandResult: view.lastHandResult,
    matchEnded: view.matchEnded,
    currentWaits: opts.currentWaits
      ? seatValues(view.playerCount ?? 4, (seat) =>
          (opts.currentWaits?.[seat] ?? []).filter((tile) =>
            isPlayableTile(tile, { playerCount: view.playerCount ?? 4 })
          )
        )
      : null,
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
  if (focus === 0 && view.playerCount !== 3) {
    return base;
  }
  return rotateMatchView(base, focus);
}
