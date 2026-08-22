/**
 * Pixi-based table renderer for the in-browser game.
 *
 * Tiles are rendered from the per-seat sprite sheets under
 * `app/game/tenhouSprites/` (ownHand, bottomSmall, topSmall,
 * leftSmall, rightSmall, sideHandL/R). All sheets are loaded in
 * `mount()` before any rendering happens, so per-render code can
 * assume every required sheet is available.
 *
 * Lifecycle:
 *   - Caller (the React route) creates a `TableRenderer` in a `useEffect`,
 *     calls `mount(container)`, subscribes to the Zustand store, and
 *     calls `destroy()` on unmount.
 *
 * The renderer never imports the store directly — it exposes pure
 * `render(view)` so the route owns the subscription lifecycle.
 */
import {
  Application,
  Assets,
  Container,
  Graphics,
  NineSliceSprite,
  Sprite,
  Text,
  Texture,
  TextStyle,
  type ColorSource,
} from "pixi.js";
import type { MatchView } from "../store";
import type { LegalAction, Meld } from "~/game/protocol/messages";
import { sortYakuRecord } from "~/game/protocol/yakuOrder";
import { playGameSound } from "../sound";
import {
  tableLayoutFromConfig,
  validateTableLayoutConfig,
  type TableLayout,
  type TableLayoutConfig,
  type Rect,
} from "./tableLayout";
import type { Seat } from "./tableGeometry";
import { DiscardAnimator } from "./discardAnimator";
import {
  MELD_SLIDE_TILE_WIDTHS,
  MeldAnimator,
  rotateMeldLocalPoint,
} from "./meldAnimator";
import { HandSorter, naturalOrderRawIndices } from "./handSorter";
import { ACTIVE_TILE_DESIGN } from "./tiles/activeTileDesign";
import { ACTIVE_TABLE_LAYOUT } from "./layouts/activeTableLayout";
import type { TileDesign } from "./tiles/tileDesign";
import { TileTextureStore } from "./tiles/tileTextureStore";
import { TileSpriteFactory } from "./tiles/tileSpriteFactory";
import {
  layoutDiscards,
  layoutSideHand,
  layoutTopHand,
  meldTileDims,
  type TilePlacement,
} from "./tileAreaLayout";
import chipIconUrl from "~/game/client/icons/chips.png";
import dabukenIconUrl from "~/game/client/icons/dabuken.png";
import tenhouBgUrl from "~/game/tenhouSprites/tenhouBg.png";
import { splitWinningHandForDisplay } from "./winningHand";
import {
  discardSourceForRawIndex,
  findTileAction,
  type DiscardSource,
} from "../discardActions";

/** Per-seat team enrichment drawn on spectator / replay nameplates. */
export interface SeatEnrichment {
  teamName?: string | null;
  teamLogoUrl?: string | null;
}

interface FocusedHandHoverTarget {
  sprite: Sprite;
  originalTint: number;
}

/**
 * Tile sprite sizing. There are three categories of tile sprites,
 * each living in a different sheet with its own per-cell source
 * dimensions (in image pixels, taken straight from the PNGs). The
 * on-screen size of every tile is derived as `source × scale`, so
 * artwork aspect is preserved by construction.
 *
 *   - SMALL — the default "small" vertical tile (cap pointing toward
 *     screen top/bottom). Used for seat 2 hand back tiles, top &
 *     bottom discards / melds / walls, hidden-tile backs in melds,
 *     and the legacy placeholder. Source sheets: `bottomSmall`,
 *     `topSmall` (10×4 grid).
 *
 *   - SIDE — the small horizontal tile (cap pointing toward screen
 *     left/right). Used for seat 1/3 discards / melds / walls.
 *     Source sheets: `leftSmall`, `rightSmall` (10×4 grid).
 *
 *   - BIG — the large vertical tile used for the bottom (you) hand.
 *     Source sheet: `ownHand` (10×4 grid).
 *
 * Source dims below are the per-cell pixel sizes inside each sheet
 * (sheet pixel size ÷ 10 cols × 4 rows). Screen dims below are
 * what you'd see on the design canvas.
 */
const SMALL_TILE_SRC = { w: 86, h: 130 } as const;
const SMALL_TILE_SCALE = 0.5 * (1 - 0.094);
const SMALL_TILE_W = SMALL_TILE_SRC.w * SMALL_TILE_SCALE;
const SMALL_TILE_H = SMALL_TILE_SRC.h * SMALL_TILE_SCALE;

const SIDE_TILE_SRC = { w: 116, h: 107 } as const;
const SIDE_TILE_SCALE = 0.5 * (1 - 0.094);
const SIDE_TILE_W = SIDE_TILE_SRC.w * SIDE_TILE_SCALE;
const SIDE_TILE_H = SIDE_TILE_SRC.h * SIDE_TILE_SCALE;

const BIG_TILE_SRC = { w: 131, h: 198 } as const;
// Focused-hand tile scale. 198*0.491 ≈ 97.2 design-px tall → ~200px on a
// 1905px board (DESIGN_H 926). Keep in step with TILE_SELF spacing.
const BIG_TILE_SCALE = 0.491;
const BIG_TILE_W = BIG_TILE_SRC.w * BIG_TILE_SCALE;
const BIG_TILE_H = BIG_TILE_SRC.h * BIG_TILE_SCALE;

// Per-tile overlap along the row direction inside a discard pond.
// Used both by `renderDiscards` and (when `showHands` reveals a side
// hand) by the side-hand layout so a flipped-up opponent hand strides
// identically to that seat's discard row.
const DISCARD_ROW_OVERLAP_HORIZ = 14.5;

/** Visual separation in design pixels between the just-drawn 14th
 * tile and the sorted 13-tile run. 0.8% of the 1000 px design
 * width. */
const TSUMO_GAP = 8;

/** Multiplicative tint for a freshly-discarded tsumogiri tile —
 * "very slightly" darker than the natural face. Persists for the
 * tsumogiri discard plus the next {@link TSUMOGIRI_FRESH_WINDOW}
 * - 1 discards across all seats, then drops back to no tint. */
const TSUMOGIRI_FRESH_TINT = 0xc8c8c8;
/** Number of consecutive discards (across all seats, counting the
 * tsumogiri discard itself) over which the darken cue persists.
 * After this many discards have been seen since the tsumogiri
 * landed, the tint is removed. */
const TSUMOGIRI_FRESH_WINDOW = 3;

/** Clockwise rotation applied to each seat's tile-area container
 * (discards / hands / melds). A tile's own sprite counter-rotates by
 * the negative of this, so every tile nets to zero rotation on
 * screen; the shadow offset is rotated back through this so it always
 * falls screen-down-right. */
const SEAT_CONTAINER_ROT = [0, -Math.PI / 2, Math.PI, Math.PI / 2] as const;

/** zIndex for the shadow wraps within each area container: far below
 * every tile wrap so all drop-shadows render behind all tiles. */
const SHADOW_LAYER_Z = -1_000_000;
/** Root z for a flying discard's drop shadow: below every board tile
 * (all >= 0) but above the felt mats (-10), so a pond lifted above the
 * walls while a tile flies can't drag its shadow over a neighbour. */
const DISCARD_FLY_SHADOW_Z = -5;

const BG_COLOR: ColorSource = 0x2a2a2a;
const FELT_COLOR: ColorSource = 0x007f0e;
/** Shared styling for darkened mats behind hands and discard ponds. */
const HAND_PANEL_RADIUS = 4;
const HAND_PANEL_ALPHA = 0.16;
const PLAYER_PANEL_SIZE = 120;
const PLAYER_PANEL_GAP = 26;
const PLAYER_PANEL_LINK_WIDTH = 28;
const PLAYER_PANEL_ALPHA = 0.28;
/** Above the identity panel (-10), below every root board tile layer (0+). */
const PLAYER_PANEL_CONTENT_Z = -9;
const RELATIVE_SCORE_DISPLAY_MS = 4_000;
const HAND_HOVER_TINT = 0xffaaaa;
const RIICHI_UNAVAILABLE_TINT = 0xb0b0b0;
const RESULT_SCORE_BOX_WIDTH = 220;
const RESULT_SCORE_BOX_HEIGHT = 88;
const RESULT_SCORE_BOX_PAD_X = 18;
const RESULT_SCORE_BOX_NAME_GAP = 8;

/** Stylized wind kanji indexed by `(seat - dealer + 4) % 4`:
 *  East, South, West, North. */
const WIND_KANJI = ["東", "南", "西", "北"] as const;
const ROUND_WIND_KANJI: Record<MatchView["roundWind"], string> = {
  E: "東",
  S: "南",
  W: "西",
  N: "北",
};
const KANJI_FONT_FAMILY =
  '"Yuji Syuku", "Yu Mincho", "Hiragino Mincho ProN", serif';

/** Identify the seat whose complete hand is waiting for a discard. */
export function activePlayerIndicatorSeat(
  view: Pick<MatchView, "hands" | "melds" | "lastHandResult" | "matchEnded">
): Seat | null {
  if (view.lastHandResult || view.matchEnded) {
    return null;
  }
  for (let seat = 0; seat < 4; seat++) {
    const structuralHandSize =
      (view.hands[seat]?.length ?? 0) + (view.melds[seat]?.length ?? 0) * 3;
    if (structuralHandSize === 14) {
      return seat as Seat;
    }
  }
  return null;
}

type HandResult = NonNullable<MatchView["lastHandResult"]>;

interface ResultSeatReveal {
  hand: Array<string | null>;
  melds: Meld[] | null;
  separatesLastTile: boolean;
}

export interface SeatHandPresentation {
  animationHand: Array<string | null>;
  animationForceReveal: boolean;
  animationSeparatesLastTile: boolean;
  displayHand: Array<string | null>;
  displayMelds: Meld[];
  displayForceReveal: boolean;
  displaySeparatesLastTile: boolean;
  historicalReveal: boolean;
}

function resultSeatReveal(
  result: HandResult | null,
  seat: Seat
): ResultSeatReveal | null {
  if (!result) {
    return null;
  }
  const win = result.wins?.find((candidate) => candidate.seat === seat);
  if (win?.hand && win.hand.length > 0) {
    const { concealed, agari } = splitWinningHandForDisplay(
      win.hand,
      win.winTile
    );
    const separatesLastTile = result.reason === "tsumo" && agari !== undefined;
    return {
      hand: separatesLastTile ? [...concealed, agari] : concealed,
      melds: win.melds ?? null,
      separatesLastTile,
    };
  }
  if (
    (result.reason === "exhaustive_draw" ||
      (result.reason === "abort" && result.abortKind === "kyuushuu")) &&
    result.tenpaiHands?.[seat]?.length
  ) {
    return {
      hand: [...result.tenpaiHands[seat]],
      melds: null,
      separatesLastTile: false,
    };
  }
  return null;
}

export function resolveSeatHandPresentation(
  view: Pick<
    MatchView,
    "hands" | "melds" | "lastHandResult" | "mySeat" | "freshlyDrawnSeat"
  >,
  historicalResult: HandResult | null,
  seat: Seat
): SeatHandPresentation {
  const liveHand = view.hands[seat] ?? [];
  const liveMelds = view.melds[seat] ?? [];
  const currentReveal = resultSeatReveal(view.lastHandResult, seat);
  const historicalReveal =
    view.lastHandResult === null && seat !== view.mySeat
      ? resultSeatReveal(historicalResult, seat)
      : null;
  const displayReveal = historicalReveal ?? currentReveal;

  return {
    animationHand: currentReveal?.hand ?? liveHand,
    animationForceReveal: currentReveal !== null,
    animationSeparatesLastTile:
      currentReveal?.separatesLastTile ?? view.freshlyDrawnSeat === seat,
    displayHand: displayReveal?.hand ?? liveHand,
    displayMelds: historicalReveal
      ? (historicalReveal.melds ?? [])
      : (currentReveal?.melds ?? liveMelds),
    displayForceReveal: displayReveal !== null,
    displaySeparatesLastTile:
      displayReveal?.separatesLastTile ?? view.freshlyDrawnSeat === seat,
    historicalReveal: historicalReveal !== null,
  };
}

export function formatTableScore(
  score: number,
  focusedScore: number,
  relative: boolean
): string {
  if (!relative) {
    return `${score}`;
  }
  const difference = score - focusedScore;
  return difference > 0 ? `+${difference}` : `${difference}`;
}

export function topmostHandHoverTargetIndex(
  point: { x: number; y: number },
  bounds: ReadonlyArray<{ x: number; y: number; width: number; height: number }>
): number | null {
  for (let index = bounds.length - 1; index >= 0; index--) {
    const rect = bounds[index];
    if (
      point.x >= rect.x &&
      point.x <= rect.x + rect.width &&
      point.y >= rect.y &&
      point.y <= rect.y + rect.height
    ) {
      return index;
    }
  }
  return null;
}

export function riichiSelectionTileTint(
  inRiichiMode: boolean,
  canDeclareRiichi: boolean
): number | null {
  return inRiichiMode && !canDeclareRiichi ? RIICHI_UNAVAILABLE_TINT : null;
}

export function shouldStageWinReveal(
  stagedRevealEnabled: boolean,
  hasHandResultOverride: boolean
): boolean {
  return stagedRevealEnabled && !hasHandResultOverride;
}

export function winResultRevealKey(
  view: Pick<MatchView, "roundWind" | "roundNumber" | "honba" | "dealer">,
  result: NonNullable<MatchView["lastHandResult"]>
): string {
  return `${view.roundWind}:${view.roundNumber}:${view.honba}:${view.dealer}:${JSON.stringify(result)}`;
}

export function buildResultYakuEntries(
  yaku: Record<string, string> | undefined,
  doraCount: number | undefined,
  uraDoraCount: number | undefined,
  reserveUraRow: boolean
): Array<{ name: string; value: string; alwaysHidden: boolean }> {
  const entries = Object.entries(sortYakuRecord(yaku ?? {})).map(
    ([name, value]) => ({
      name,
      value,
      alwaysHidden: false,
    })
  );
  const setCount = (name: string, count: number, keepZero: boolean): void => {
    const index = entries.findIndex((entry) => entry.name === name);
    if (count === 0 && !keepZero) {
      if (index >= 0) {
        entries.splice(index, 1);
      }
      return;
    }
    const entry = {
      name,
      value: `${count}飜`,
      alwaysHidden: count === 0,
    };
    if (index >= 0) {
      entries[index] = entry;
    } else {
      entries.push(entry);
    }
  };

  if (doraCount !== undefined) {
    setCount("Dora", doraCount, false);
  }
  if (uraDoraCount !== undefined || reserveUraRow) {
    setCount("Ura Dora", uraDoraCount ?? 0, true);
  }

  const filtered = entries.filter((entry) => {
    const count = parseInt(entry.value, 10);
    if (Number.isFinite(count) && count === 0) {
      return entry.name === "Ura Dora";
    }
    return true;
  });
  const uraIndex = filtered.findIndex((entry) => entry.name === "Ura Dora");
  if (uraIndex >= 0 && uraIndex !== filtered.length - 1) {
    const [ura] = filtered.splice(uraIndex, 1);
    filtered.push(ura);
  }
  return filtered;
}

/** Axis-aligned bounding box of a non-empty list of `Rect`s. */
function boundingBox(rects: readonly Rect[]): Rect {
  const x0 = Math.min(...rects.map((r) => r.x));
  const y0 = Math.min(...rects.map((r) => r.y));
  const x1 = Math.max(...rects.map((r) => r.x + r.w));
  const y1 = Math.max(...rects.map((r) => r.y + r.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

function scoreCartridgeMetrics(center: Rect): {
  width: number;
  height: number;
  inset: number;
  bottomTop: number;
} {
  const width = Math.round(center.w * 0.5);
  const height = Math.round(center.h * 0.16);
  const inset = Math.round(center.h * 0.08);
  return {
    width,
    height,
    inset,
    bottomTop: center.y + center.h - inset - height,
  };
}

export function resultScoreBoxLayout(
  nameWidth: number,
  dealerWidth: number
): { width: number; height: number; nameScale: number } {
  const dealerGap = dealerWidth > 0 ? RESULT_SCORE_BOX_NAME_GAP : 0;
  const maxNameWidth = Math.max(
    0,
    RESULT_SCORE_BOX_WIDTH -
      RESULT_SCORE_BOX_PAD_X * 2 -
      dealerWidth -
      dealerGap
  );
  return {
    width: RESULT_SCORE_BOX_WIDTH,
    height: RESULT_SCORE_BOX_HEIGHT,
    nameScale:
      nameWidth > maxNameWidth && nameWidth > 0 ? maxNameWidth / nameWidth : 1,
  };
}

const hudStyle = new TextStyle({
  fontFamily: "Inter, system-ui, sans-serif",
  fontSize: 14,
  fill: 0xffffff,
});

const timerStyleNormal = new TextStyle({
  fontFamily: "Inter, system-ui, sans-serif",
  fontSize: 18,
  fontWeight: "700",
  fill: 0xffffff,
  stroke: { color: 0x000000, width: 4, join: "round" },
});

const timerStyleWarn = new TextStyle({
  fontFamily: "Inter, system-ui, sans-serif",
  fontSize: 18,
  fontWeight: "700",
  fill: 0xfacc15,
  stroke: { color: 0x000000, width: 4, join: "round" },
});

const timerStyleDanger = new TextStyle({
  fontFamily: "Inter, system-ui, sans-serif",
  fontSize: 18,
  fontWeight: "800",
  fill: 0xef4444,
  stroke: { color: 0x000000, width: 4, join: "round" },
});

/**
 * Sheet keys for the per-zone tile spritesheets in
 * `app/game/tenhouSprites/`. Each multi-tile sheet is a 10×4 grid;
 * cell size is derived from the loaded texture's natural
 * dimensions. The two `sideHand*` sheets are single-tile images.
 *
 * Cell layout (multi-tile sheets):
 *   row 0 = manzu  (col 0 = 0m / aka 5m, then 1m … 9m)
 *   row 1 = pinzu  (same pattern)
 *   row 2 = souzu  (same pattern)
 *   row 3 = honors (col 0 = back, 1–7 = 1z–7z; col 8–9 unused)
 */
type SheetKey =
  | "ownHand"
  | "bottomSmall"
  | "topSmall"
  | "leftSmall"
  | "rightSmall"
  | "sideHandL"
  | "sideHandR";

export interface TileClick {
  seat: number;
  index: number;
  /** Tile string for the clicked tile (own seat only — opponents are redacted). */
  tile: string;
  discardSource: DiscardSource;
}

export interface ActionClick {
  action: LegalAction;
}

export function canInteractWithFocusedHand(
  view: Pick<MatchView, "conn">
): boolean {
  return view.conn !== "replay";
}

export class TableRenderer {
  private app: Application | null = null;
  private root: Container | null = null;
  private hudText: Text | null = null;
  /** Top-right HUD timer node. Driven by `actionDeadline` +
   * the Pixi ticker so the countdown updates every frame
   * without forcing a full table re-render. Hidden whenever
   * `actionDeadline` is `null` (no pending action). */
  private timerText: Text | null = null;
  /**
   * Cached screen-space anchor for the timer HUD, computed in
   * `render` as `rootPos + (feltRight, feltBottom) * scale`. Used
   * by `tickTimer` so the countdown sits flush against the
   * bottom-right corner of the green felt rather than the canvas
   * letterbox.
   */
  private timerAnchor: { x: number; y: number } | null = null;
  /**
   * Cached bounding box of the green felt region in design-space
   * coords. Stashed during `render` so subsequent helpers (action
   * button strip, etc.) can clip themselves to the play area
   * instead of bleeding into the dark canvas margin.
   */
  private feltBoxDesign: { x: number; y: number; w: number; h: number } | null =
    null;
  /** Cached deadline (Unix ms) read from the last `render(view)`
   * call. The ticker reads this each frame to format the
   * countdown. */
  private actionDeadline: number | null = null;
  /**
   * Cached buffer-pool size (ms) from the last `render(view)`.
   * Read by `tickTimer` to render the trailing "+ Y" component
   * once the base countdown elapses. `null` when the server
   * didn't supply one (slice servers, replays).
   */
  private actionBufferMs: number | null = null;
  /**
   * Last whole-second value of `total_remaining` shown by
   * `tickTimer`. Used to fire `timer-tick` SFX on every
   * second-crossing while `total_remaining <= 5s`, and to skip
   * the tick on the first frame after the timer appears (no
   * audible "5" before the player has had a chance to act).
   */
  private lastTimerSeconds: number | null = null;
  /** Bound ticker callback retained so we can remove it on
   * `destroy()`. */
  private timerTickHandler: (() => void) | null = null;
  private onTileClick: ((click: TileClick) => void) | null = null;
  private onActionClick: ((click: ActionClick) => void) | null = null;
  /** Optional callback fired when the renderer's internal UI state
   * changes (e.g. riichi mode toggle) and a re-render is needed.
   * The host (match route) wires this to `renderer.render(state)`. */
  private onRenderRequest: (() => void) | null = null;
  /** Per-seat team enrichment (name + logo URL) for spectator /
   * replay nameplates. Set via {@link setSeatEnrichment}; empty by
   * default so non-enriched views (in-app games) render unchanged. */
  private seatEnrichment: (SeatEnrichment | null)[] = [null, null, null, null];
  /** Cache of loaded team-logo textures, keyed by URL. */
  private readonly teamLogoTextures = new Map<string, Texture>();
  /** Team-logo URLs whose texture load is in flight (dedupe). */
  private readonly teamLogoPending = new Set<string>();
  /**
   * When true, seat 0 has entered the "select riichi tile" UI mode
   * (toggled by the Riichi button). Only tiles backed by a
   * `riichi:TILE` legal action are clickable; clicking sends the
   * matching action id instead of a discard. Cleared automatically
   * when the seat's legal actions no longer include any riichi
   * options (e.g. after the riichi declaration is confirmed).
   */
  private riichiMode = false;
  /**
   * Currently-expanded call group (chi / pon / kan with more than
   * one tile-combination option). When set, the action button
   * strip draws a secondary row of tile-preview buttons above the
   * group's collapsed button — one button per option, clicking
   * dispatches the underlying `LegalAction`. Reset to `null` in
   * `renderActionButtons` whenever the group's options vanish
   * (call window closed, ack received, etc.).
   */
  private expandedCallGroup: "chi" | "pon" | "kan" | null = null;
  /** When true, paint the colored layout regions on top of the
   * normal table (debug aid while migrating to the Tenhou-style
   * layout). Toggled via {@link setShowLayoutDebug}. */
  private showLayoutDebug = false;
  /** Wall-only zone overlay for visually checking stack bounds. */
  private showWallZonesDebug = false;
  /** Replay-viewer overlay toggles. The renderer is render-pure
   * (no internal animation loop), so toggles take effect on the
   * next `render()` call. Defaults match `defaultReplayOverlayState`
   * in `ReplayOverlayPanel`. */
  private showWaits = false;
  private showHands = false;
  /** Development fixture mode: include the 52 tiles normally removed
   * by the initial deal so all 136 physical wall tiles are visible. */
  private showUndealtWall = false;
  private showWalls = false;
  private showNames = true;
  private showRelativeScores = false;
  private relativeScoresResetTimer: ReturnType<typeof setTimeout> | null = null;
  /** Live-spectate mode. A relay feed carries no live-wall or
   * omniscient dead-wall tiles, so this hides the draw (live) wall
   * and renders only the dead wall at a fixed spot. Set by the live
   * spectator host (`spectate.tsx`); replays and live play leave it
   * false. */
  private liveSpectate = false;
  /** When false, the post-hand win-info panel and the match-end
   * standings panel are skipped during `render()`. Used by the
   * host when it needs to suppress result overlays. */
  private showHandResult = true;
  /** True while a pointer is held inside the visible win-info zone. */
  private handResultPressHidden = false;
  /** Whether the latest view has a press-hideable hand result. Match-end
   * standings are deliberately excluded from this interaction. */
  private winInfoPressEnabled = false;
  /**
   * Mirrors the host route's live-play "Auto win" toggle. When
   * true, the renderer suppresses the on-canvas ron/tsumo
   * action buttons since the host effect will fire the win
   * automatically — surfacing the button would let the player
   * race the auto-action and is visually noisy in riichi where
   * the button would otherwise flash in-and-out every draw.
   */
  private autoWinEnabled = false;
  /** Last non-touch pointer position, used to restore hover after redraws. */
  private focusedHandPointerClient: { x: number; y: number } | null = null;
  /** Current frame's focused-hand sprites in visual paint order. */
  private focusedHandHoverTargets: FocusedHandHoverTarget[] = [];
  /** Target currently carrying the red hover tint. */
  private activeFocusedHandHover: FocusedHandHoverTarget | null = null;
  /**
   * When non-null, the renderer paints the hand-result overlay
   * using this data instead of `view.lastHandResult`. Used by
   * the live match's "eye" button to re-show the previous hand's
   * panel after the auto-advance has cleared it from the store.
   */
  private handResultOverride: NonNullable<MatchView["lastHandResult"]> | null =
    null;
  /**
   * Currently-displayed page in a multi-winner result panel.
   * For a multi-ron (or any result with `wins.length > 1`) the
   * panel renders one winner at a time and the user clicks to
   * advance; the index here cycles 0..N-1. Reset to 0 whenever
   * the underlying result reference changes (new hand_end /
   * different override).
   */
  private currentWinPage = 0;
  /** Stable identity of the result that {@link currentWinPage} applies to. */
  private currentWinPageResultKey: string | null = null;
  /**
   * Wall-clock time at which the current win panel page began
   * playing its staged reveal animation, in `performance.now()`
   * milliseconds. Reset to `null` when no win panel is active or
   * when staged reveal is disabled (replay playback). Bumped to
   * a fresh `performance.now()` whenever the win-result reference
   * or {@link currentWinPage} changes, so each multi-ron page
   * replays the reveal from scratch.
   */
  private winPageRevealStartedAt: number | null = null;
  /**
   * Number of yaku entries on the current win-panel page that
   * have already triggered a `yaku-reveal` SFX play. Used to
   * fire the cue exactly once per yaku as the staged reveal
   * advances, regardless of how many `render()` calls happen
   * inside the same reveal step. Reset together with
   * {@link winPageRevealStartedAt}.
   */
  private winPageYakuRevealSoundsPlayed = 0;
  /**
   * Whether the ura-dora indicators flip has already triggered a
   * `yaku-reveal` SFX play on the current page. Suppressed when
   * an "Ura Dora" yaku is present — that yaku's own reveal
   * already plays the sound, and the indicator flip happens
   * simultaneously, so we'd otherwise double up.
   */
  private winPageUraRevealSoundPlayed = false;
  /**
   * When true, the win-info panel reveals its yaku list and
   * ura-dora indicators progressively (staged reveal). When false
   * (default for replay playback), the full panel is shown
   * immediately on appearance.
   */
  private stagedRevealEnabled = true;
  /** Cached last `view` passed to {@link render}, used to re-render
   * after internal UI state changes (e.g. advancing the
   * multi-winner page index) without waiting for a store update. */
  private lastView: MatchView | null = null;
  /**
   * Orchestrates the two-phase discard slide animation (see
   * {@link DiscardAnimator}). Updated via {@link beginFrame} at
   * the top of each {@link render}, consumed by {@link renderSeat}
   * when painting the hand strip and the discard pond. While
   * {@link DiscardAnimator.hasActive} returns true, the per-frame
   * ticker installed in {@link mount} re-fires
   * {@link onRenderRequest} so the in-flight slide tweens forward.
   */
  private animator = new DiscardAnimator();
  /** Slides appended melds from player-left and shouminkan tiles from above. */
  private meldAnimator = new MeldAnimator();
  /** Bound animator-ticker callback retained so {@link destroy}
   * can detach it cleanly. */
  private animatorTickHandler: (() => void) | null = null;
  /**
   * Drives the focused player's hand sort + drag-to-reorder +
   * smooth-slide animation. Reset at every hand boundary; the
   * renderer treats it as the source of truth for seat 0's tile
   * display order and per-tile x positions whenever the player
   * has manually rearranged anything. See {@link HandSorter}.
   */
  private handSorter = new HandSorter();
  /** Player's "Auto sort" preference from the live-play menu.
   * Re-applied at every hand boundary in {@link render}. */
  private autoSortPreference = true;
  /** Listener fired whenever the focused hand's sort flag flips
   * (drag promotion, explicit toggle, hand_start reset). Lets
   * the host route keep its menu UI in sync. */
  private onAutoSortChange: ((on: boolean) => void) | null = null;
  /** Bound document-level pointer handlers for the focused-hand
   * drag gesture. Tracked here so {@link destroy} can detach
   * them cleanly. */
  private handDragCleanup: (() => void) | null = null;
  /** Cached design-space x of seat 0's hand-container origin
   * (`handRect.x + longAxisOffset`). Stamped by `renderSeat` on
   * every render so the document-level pointermove handler can
   * convert page coordinates into handContainer-local coords
   * without holding a stale Pixi node. */
  private handContainerOriginX = 0;
  /** Click-fallback thunk recorded by the seat-0 pointerdown
   * handler. If pointerup fires before the drag is promoted
   * (i.e. the gesture is a quick click), we invoke this to
   * preserve the legacy click-to-discard / click-to-riichi
   * semantics with the original surrounding closure context. */
  private pendingHandClickCallback: (() => void) | null = null;
  /** Cached previous-frame view, used only by the focused-hand
   * sorter to detect hand boundaries (a `totalDiscards` reset).
   * Kept separate from `lastView` because the discard animator's
   * own `prevView` tracking is internal. */
  private prevHandSorterView: MatchView | null = null;
  /** DOM listener detacher for canvas interactions installed in
   * {@link mount}. Invoked during {@link destroy}. */
  private rightClickCleanup: (() => void) | null = null;
  /** Localized labels for the three center-square status lines.
   * Defaults to English; the React layer calls `setCenterLabels`
   * with translated strings after mount. */
  private centerLabels: { repeat: string; riichi: string; tiles: string } = {
    repeat: "Repeat",
    riichi: "Riichi",
    tiles: "Tiles",
  };
  /** Localized labels for the result-panel titles shown at the end
   * of a hand (exhaustive draw / abortive draw). `abortTitle`
   * contains a `{kind}` placeholder filled with one of the
   * `abortKinds` entries (or `unknown` when the kind is missing).
   * Defaults to English; the React layer calls `setResultLabels`
   * with translated strings after mount. */
  private resultLabels: {
    exhaustiveDraw: string;
    abortTitle: string;
    abortKinds: {
      kyuushuu: string;
      suufonRenda: string;
      suuchaRiichi: string;
      sanchahou: string;
      unknown: string;
    };
    chomboTitle: string;
    chomboReasons: {
      sinkingWinNotFloating: string;
      gameEndingWinNotFirst: string;
      gameEndingChinmai: string;
    };
  } = {
    exhaustiveDraw: "Exhaustive draw",
    abortTitle: "Abort: {kind}",
    abortKinds: {
      kyuushuu: "Nine Terminals",
      suufonRenda: "Four Winds Discarded",
      suuchaRiichi: "Four Players Riichi",
      sanchahou: "Triple Ron",
      unknown: "Unknown",
    },
    chomboTitle: "Chombo: {reason}",
    chomboReasons: {
      sinkingWinNotFloating: "sinking win without tenpai",
      gameEndingWinNotFirst: "game-ending win not in first",
      gameEndingChinmai: "game-ending chinmai",
    },
  };
  /** Callback invoked at the end of every `render()` with the
   * canvas-pixel rect of the currently-visible result panel
   * (win-info inner zone or match-end standings panel), or
   * `null` when no panel is showing. Host overlays can use this
   * to anchor controls to the panel. */
  private resultPanelBoundsListener:
    | ((rect: { x: number; y: number; w: number; h: number } | null) => void)
    | null = null;
  /** Last reported bounds, used for change-detection so we only
   * fire the listener when the rect actually moves. */
  private lastResultPanelBounds: {
    x: number;
    y: number;
    w: number;
    h: number;
  } | null = null;
  /** Canvas-pixel centre of the focused seat's discard pond,
   * republished on every render via {@link setPondCenterListener}.
   * The React layer uses this to anchor the "peek last hand
   * result" eye button to the middle of the human's pond. */
  private pondCenterListener:
    | ((point: { x: number; y: number } | null) => void)
    | null = null;
  private lastPondCenter: { x: number; y: number } | null = null;
  /** Callback invoked at the end of every `render()` with the
   * canvas-pixel rect of the focused seat's (bottom) hand strip,
   * or `null` when no view is mounted. The React layer uses it to
   * lift the review comment bubble above the player's tiles so the
   * two don't overlap. */
  private bottomHandBoundsListener:
    | ((rect: { x: number; y: number; w: number; h: number } | null) => void)
    | null = null;
  private lastBottomHandBounds: {
    x: number;
    y: number;
    w: number;
    h: number;
  } | null = null;
  /** Per-frame wait-tile set computed at the top of `render()` when
   * `showWaits` is on. Used by {@link tintIfWait} to colour every
   * matching tile (discards, walls, hands, melds) red. Normalized
   * form: red fives are stored as `"5m"`/`"5p"`/`"5s"`. */
  private currentWaitTiles: Set<string> = new Set();
  /** Observes the canvas's parent so we can re-fit on window /
   * container resizes. Disconnected on `destroy`. */
  private resizeObserver: ResizeObserver | null = null;
  /** rAF handle used to coalesce burst-y resize notifications into a
   * single render-request per frame. Drag-resizing a window can fire
   * the ResizeObserver dozens of times per second; we only need one
   * render per frame. Cleared in `destroy`. */
  private resizeRafHandle: number | null = null;
  /** rAF handle used to coalesce burst-y internal render requests
   * (pointermove during a hand-drag, animator-tick + pointermove in
   * the same frame, etc.) into a single host render per animation
   * frame. High-rate pointer devices can fire `pointermove` 500+ Hz;
   * without coalescing every event triggers a full table re-render.
   * Cleared in `destroy`. */
  private renderRequestRafHandle: number | null = null;
  /** Active tile design (artwork + metrics). Injectable; defaults to
   * the current production selection. */
  private tileDesign: TileDesign;
  /** Active board layout (zone geometry + layers). Injectable and
   * swappable at runtime via {@link setLayoutConfig}. */
  private layoutConfig: TableLayoutConfig;
  /** Loads atlases and hands out framed textures for {@link tileDesign}. */
  private textureStore: TileTextureStore | null = null;
  /** Materializes tile sprites from the active design. */
  private spriteFactory: TileSpriteFactory | null = null;
  /** Chip icon texture (Buu nameplate). Loaded in `mount()`. */
  private chipIconTex: Texture | null = null;
  /** Dabuken token texture (Buu nameplate). Loaded in `mount()`. */
  private dabukenIconTex: Texture | null = null;
  /** Radial felt-darkening vignette texture. Loaded in `mount()`. */
  private feltMaskTex: Texture | null = null;

  constructor(opts?: {
    tileDesign?: TileDesign;
    layoutConfig?: TableLayoutConfig;
  }) {
    this.tileDesign = opts?.tileDesign ?? ACTIVE_TILE_DESIGN;
    this.layoutConfig = opts?.layoutConfig ?? ACTIVE_TABLE_LAYOUT;
  }

  async mount(container: HTMLElement): Promise<void> {
    const app = new Application();
    await app.init({
      width: this.layoutConfig.viewport.w,
      height: this.layoutConfig.viewport.h,
      background: BG_COLOR,
      antialias: true,
      roundPixels: true,
      resolution: window.devicePixelRatio || 1,
      autoDensity: true,
      resizeTo: container,
    });
    container.appendChild(app.canvas);
    this.app = app;

    // Right-click anywhere on the canvas acts as a generic
    // "pass / tsumogiri" shortcut: if a `pass` legal action is
    // available (call decision), fire it; otherwise if it's the
    // player's turn after a fresh draw, discard the drawn tile
    // (tsumogiri). Always suppress the browser context menu so
    // the gesture feels native to the table.
    const onContextMenu = (e: MouseEvent): void => {
      e.preventDefault();
    };
    const onCanvasMouseDown = (e: MouseEvent): void => {
      if (e.button !== 2) {
        return;
      }
      e.preventDefault();
      this.handleRightClick();
    };
    const onResultPointerDown = (e: PointerEvent): void => {
      if (
        !this.winInfoPressEnabled ||
        !this.lastResultPanelBounds ||
        (e.button !== 0 && e.button !== 2)
      ) {
        return;
      }
      const canvasRect = app.canvas.getBoundingClientRect();
      const point = {
        x:
          ((e.clientX - canvasRect.left) * app.screen.width) / canvasRect.width,
        y:
          ((e.clientY - canvasRect.top) * app.screen.height) /
          canvasRect.height,
      };
      if (!pointInsideRect(point, this.lastResultPanelBounds)) {
        return;
      }
      // Capture and consume the press before Pixi or a replay route's
      // bubbling mousedown handler can interpret it as another action.
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      this.handResultPressHidden = true;
      this.requestRender();
    };
    const restoreHandResult = (): void => {
      if (!this.handResultPressHidden) {
        return;
      }
      this.handResultPressHidden = false;
      this.requestRender();
    };
    app.canvas.addEventListener("contextmenu", onContextMenu);
    app.canvas.addEventListener("mousedown", onCanvasMouseDown);
    app.canvas.addEventListener("pointerdown", onResultPointerDown, true);
    window.addEventListener("pointerup", restoreHandResult);
    window.addEventListener("pointercancel", restoreHandResult);
    this.rightClickCleanup = (): void => {
      app.canvas.removeEventListener("contextmenu", onContextMenu);
      app.canvas.removeEventListener("mousedown", onCanvasMouseDown);
      app.canvas.removeEventListener("pointerdown", onResultPointerDown, true);
      window.removeEventListener("pointerup", restoreHandResult);
      window.removeEventListener("pointercancel", restoreHandResult);
    };

    // Load the active design's atlases through the texture store,
    // then expose the sprite factory both build on. Atlas ids match
    // the legacy sheet keys, so `getTileTexture` and every render
    // pass keep working unchanged.
    this.textureStore = new TileTextureStore(this.tileDesign);
    await this.textureStore.load();
    this.spriteFactory = new TileSpriteFactory(this.textureStore);

    // Pixi rasterizes text into canvas textures, so ensure the Japanese
    // brush face is ready before any seat-wind labels are constructed.
    // Keep mounting if external font delivery fails; the style has local
    // Mincho fallbacks for that case.
    try {
      await document.fonts.load('400 16px "Yuji Syuku"', WIND_KANJI.join(""));
    } catch {
      // Best-effort visual enhancement only.
    }

    // Load the Buu nameplate icons (chip + dabuken). Best-effort:
    // a failure leaves `*IconTex` null and the renderer falls back
    // to procedural Graphics so the table still paints.
    try {
      const [chipTex, dabukenTex, feltMaskTex] = (await Promise.all([
        Assets.load(chipIconUrl),
        Assets.load(dabukenIconUrl),
        Assets.load(tenhouBgUrl),
      ])) as [Texture, Texture, Texture];
      this.chipIconTex = chipTex;
      this.dabukenIconTex = dabukenTex;
      this.feltMaskTex = feltMaskTex;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("[TableRenderer] failed to load nameplate icons", err);
    }

    const root = new Container();
    app.stage.addChild(root);
    this.root = root;

    const hud = new Text({ text: "", style: hudStyle });
    hud.position.set(16, 16);
    app.stage.addChild(hud);
    this.hudText = hud;

    // Bottom-right action-timer HUD ("X + Y"). Anchored just
    // below the player's hand on the right edge of the play area
    // so the buffer pool sits next to the seat that owns it.
    // Driven by a Pixi-ticker callback so the seconds tick down
    // every frame without a full table re-render. The trailing
    // component is the server-supplied per-hand think buffer
    // (see `bufferMs` in the WS protocol); the leading component
    // is the per-action base budget that ticks down to 0 first.
    const timer = new Text({ text: "", style: timerStyleNormal });
    timer.anchor.set(1, 1);
    // Position is refreshed every tick against `app.screen` so the
    // HUD hugs the real bottom-right of the canvas regardless of
    // how the design space is letterboxed.
    timer.position.set(app.screen.width - 6, app.screen.height - 4);
    timer.visible = false;
    app.stage.addChild(timer);
    this.timerText = timer;
    const tickHandler = () => {
      this.tickTimer();
    };
    this.timerTickHandler = tickHandler;
    app.ticker.add(tickHandler);

    // Animation pump: while any discard, meld, or focused-hand
    // slide is active, re-request a render every frame so the tween
    // advances. Cheap no-op otherwise.
    const animTickHandler = () => {
      if (
        this.animator.hasActive() ||
        this.meldAnimator.hasActive() ||
        this.handSorter.hasActiveAnimation()
      ) {
        this.requestRender();
      }
    };
    this.animatorTickHandler = animTickHandler;
    app.ticker.add(animTickHandler);

    // Focused-hand drag gesture: pointerdown is wired on each
    // tile in `renderSeat`; pointermove / pointerup live on
    // `window` so the gesture continues even if the cursor
    // leaves the canvas. Coords are converted from page space
    // into handContainer-local space via the cached canvas rect,
    // root scale + position, and the seat-0 hand origin stamped
    // by `renderSeat`.
    const pointerToHandLocalX = (clientX: number, clientY: number): number => {
      const a = this.app;
      if (!a || !this.root) {
        return 0;
      }
      const rect = a.canvas.getBoundingClientRect();
      const cssX = clientX - rect.left;
      // `app.screen.*` is in CSS pixels with autoDensity, matching
      // `rect.width`; no DPR math needed.
      const screenX = (cssX / Math.max(1, rect.width)) * a.screen.width;
      void clientY;
      const designX = (screenX - this.root.position.x) / this.root.scale.x;
      // Seat 0 (bottom): handContainer has no rotation, so
      // local-x = design-x - handContainer.x.
      return designX - this.handContainerOriginX;
    };
    const onWindowPointerMove = (e: PointerEvent): void => {
      this.focusedHandPointerClient =
        e.pointerType === "touch" ? null : { x: e.clientX, y: e.clientY };
      this.updateFocusedHandHover();
      if (!this.handSorter.hasPointerDown()) {
        return;
      }
      const view = this.lastView;
      if (!view) {
        return;
      }
      const localX = pointerToHandLocalX(e.clientX, e.clientY);
      const rawHand = view.hands[0] ?? [];
      const isFresh = view.freshlyDrawnSeat === 0;
      const natural = naturalOrderRawIndices(rawHand, isFresh, tileSortKey);
      this.handSorter.pointerMove(localX, natural);
      this.requestRender();
    };
    const onWindowPointerUp = (e: PointerEvent): void => {
      if (e.button === 2) {
        return;
      }
      if (!this.handSorter.hasPointerDown()) {
        return;
      }
      const result = this.handSorter.pointerUp();
      if (result.kind === "click") {
        // Reproduce the legacy click-to-discard semantics. We
        // don't have direct access to the riichi-mode logic
        // here, so we route through a stashed click thunk set
        // by the pointerdown handler (which has the
        // surrounding closure context).
        const cb = this.pendingHandClickCallback;
        if (cb) {
          cb();
        }
      }
      this.pendingHandClickCallback = null;
      this.requestRender();
    };
    window.addEventListener("pointermove", onWindowPointerMove);
    window.addEventListener("pointerup", onWindowPointerUp);
    window.addEventListener("pointercancel", onWindowPointerUp);
    const onCanvasPointerLeave = (): void => {
      this.clearFocusedHandHover(true);
    };
    app.canvas.addEventListener("pointerleave", onCanvasPointerLeave);
    this.handDragCleanup = (): void => {
      window.removeEventListener("pointermove", onWindowPointerMove);
      window.removeEventListener("pointerup", onWindowPointerUp);
      window.removeEventListener("pointercancel", onWindowPointerUp);
      app.canvas.removeEventListener("pointerleave", onCanvasPointerLeave);
    };

    // Re-fit on container resizes (window resize, sidebar
    // collapse, etc.). The actual scaling is applied by `render`,
    // so we just re-trigger that via the host's render-request
    // hook when wired.
    if (typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver(() => {
        // Coalesce bursts of resize events (drag-resize fires
        // continuously) into one render per animation frame.
        if (this.resizeRafHandle !== null) {
          return;
        }
        this.resizeRafHandle = requestAnimationFrame(() => {
          this.resizeRafHandle = null;
          // Pixi's built-in `resizeTo` only re-reads the target
          // element's dims on `window` resize events; it does NOT
          // observe the element itself. When the canvas container
          // mounts at 0×0 (e.g. React-Router client navigation from
          // /review → /replays/:id: the route's div is appended
          // and its layout is committed in the same frame as our
          // `useEffect`, so `app.init({ resizeTo: container })`
          // snapshots a zero-size box) Pixi never recovers on its
          // own and we get the "dark canvas until reload" symptom.
          // Calling `app.resize()` here forces Pixi to re-measure
          // the container against its `resizeTo` target so the
          // subsequent `render()` reads correct `app.screen` dims.
          if (this.app) {
            this.app.resize();
          }
          this.requestRender();
        });
      });
      this.resizeObserver.observe(container);
    }
  }

  setOnTileClick(handler: (click: TileClick) => void): void {
    this.onTileClick = handler;
  }

  /** Swap the board layout at runtime (e.g. a responsive preset) and
   * re-render from the latest view. Textures are untouched. Warns on
   * an invalid config rather than throwing so a bad preset can't
   * blank the table in production. */
  setLayoutConfig(config: TableLayoutConfig): void {
    const errors = validateTableLayoutConfig(config);
    if (errors.length > 0) {
      // eslint-disable-next-line no-console
      console.warn(
        `[TableRenderer] invalid layout config "${config.id}":`,
        errors
      );
    }
    this.layoutConfig = config;
    this.requestRender();
  }

  setOnActionClick(handler: (click: ActionClick) => void): void {
    this.onActionClick = handler;
  }

  setOnRenderRequest(handler: () => void): void {
    this.onRenderRequest = handler;
  }

  /**
   * Coalesced render request. Multiple calls within the same
   * animation frame collapse to a single `onRenderRequest`
   * invocation on the next rAF tick. Use this in preference to
   * calling `this.onRenderRequest` directly, especially from
   * high-frequency callers (pointermove, ticker handlers).
   */
  private requestRender(): void {
    if (this.renderRequestRafHandle !== null) {
      return;
    }
    if (!this.onRenderRequest) {
      return;
    }
    this.renderRequestRafHandle = requestAnimationFrame(() => {
      this.renderRequestRafHandle = null;
      if (this.onRenderRequest) {
        this.onRenderRequest();
      }
    });
  }

  private clearFocusedHandHover(clearPointer = false): void {
    if (this.activeFocusedHandHover) {
      this.activeFocusedHandHover.sprite.tint =
        this.activeFocusedHandHover.originalTint;
      this.activeFocusedHandHover = null;
    }
    if (clearPointer) {
      this.focusedHandPointerClient = null;
    }
  }

  private updateFocusedHandHover(): void {
    const app = this.app;
    const pointer = this.focusedHandPointerClient;
    let next: FocusedHandHoverTarget | null = null;
    if (app && pointer && !this.handSorter.hasPointerDown()) {
      const canvasRect = app.canvas.getBoundingClientRect();
      if (canvasRect.width > 0 && canvasRect.height > 0) {
        const point = {
          x:
            ((pointer.x - canvasRect.left) / canvasRect.width) *
            app.screen.width,
          y:
            ((pointer.y - canvasRect.top) / canvasRect.height) *
            app.screen.height,
        };
        const index = topmostHandHoverTargetIndex(
          point,
          this.focusedHandHoverTargets.map((target) =>
            target.sprite.getBounds()
          )
        );
        next = index === null ? null : this.focusedHandHoverTargets[index];
      }
    }
    if (next === this.activeFocusedHandHover) {
      return;
    }
    this.clearFocusedHandHover();
    this.activeFocusedHandHover = next;
    if (next) {
      next.sprite.tint = HAND_HOVER_TINT;
    }
  }

  /**
   * Subscribe to focused-hand sort-flag flips. Fires whenever
   * the sort flag changes — explicitly via {@link setAutoSort},
   * implicitly when the player drags a tile (auto-sort turns
   * off), or on hand_start when the menu preference is
   * re-applied. The host route uses this to keep the live-play
   * menu's "Auto sort" indicator in sync.
   */
  setOnAutoSortChange(cb: ((on: boolean) => void) | null): void {
    this.onAutoSortChange = cb;
    this.handSorter.setOnSortFlagChange(
      cb === null ? null : (on) => this.onAutoSortChange?.(on)
    );
  }

  /**
   * Apply the player's "Auto sort" menu preference. Stored so
   * the next hand_start (which wipes per-hand state) honours
   * the preference, and applied immediately to the current
   * hand: turning on snaps the hand back to natural sort (with
   * smooth slides); turning off freezes the current display
   * order as the player's custom order.
   */
  setAutoSort(on: boolean): void {
    this.autoSortPreference = on;
    const rawHand = this.lastView?.hands[0] ?? [];
    const isFresh = this.lastView?.freshlyDrawnSeat === 0;
    const natural = naturalOrderRawIndices(rawHand, isFresh, tileSortKey);
    this.handSorter.setSortFlag(on, natural);
    this.requestRender();
  }

  /**
   * Toggle table motion animations. When `false`, discard and meld
   * transitions snap directly to their static layouts. In-flight
   * animations are cancelled immediately.
   *
   * Wired up by hosts that want to disable motion (eg the future
   * accessibility "reduce motion" toggle).
   */
  setAnimationsEnabled(flag: boolean): void {
    this.animator.setEnabled(flag);
    this.meldAnimator.setEnabled(flag);
  }

  /**
   * One-shot: skip discard and meld diffing for the immediately
   * upcoming {@link render} call. The replay viewer uses this for
   * mouse-wheel scrubbing so consecutive scroll-steps snap instantly
   * while single-step button / right-click advances still animate.
   *
   * Call this *before* the `render(view)` that should snap.
   */
  snapNextAnimation(): void {
    this.animator.snapNext();
    this.meldAnimator.snapNext();
  }

  /**
   * Right-click shortcut: dispatch a generic
   * "pass / tsumogiri" action. Wired up to the canvas DOM in
   * {@link mount}. Picks the first matching legal action in this
   * order:
   *
   *   1. `pass` — present during a call-decision window
   *      (someone else's discard offers chi/pon/kan/ron).
   *   2. `discard` of the freshly-drawn tile (tsumogiri) — when
   *      it is the human's turn and they just drew. Falls back to
   *      the last tile in the hand, which is the conventional
   *      "drawn" slot in our renderer.
   *
   * No-op when neither is available, so right-clicking outside
   * of an active decision window is harmless.
   */
  private handleRightClick(): void {
    const view = this.lastView;
    if (!view || !this.onActionClick) {
      return;
    }
    const pass = view.legalActions.find((a) => a.type === "pass");
    if (pass) {
      this.onActionClick({ action: pass });
      return;
    }
    if (view.mySeat == null) {
      return;
    }
    const hand = view.hands[view.mySeat];
    if (!hand || hand.length === 0) {
      return;
    }
    // After a fresh draw the drawn tile is the last entry of
    // `hand` (see `sortHand` with `isFreshlyDrawn`). Match a
    // discard legal-action against that tile for tsumogiri.
    const drawn = hand[hand.length - 1];
    if (drawn == null) {
      return;
    }
    const tsumogiri = findTileAction(
      view.legalActions,
      "discard",
      drawn,
      "draw"
    );
    if (tsumogiri) {
      this.onActionClick({ action: tsumogiri });
    }
  }

  /** Toggle the colored-region debug overlay. */
  setShowLayoutDebug(flag: boolean): void {
    this.showLayoutDebug = flag;
  }

  /** Toggle a translucent overlay for only the four wall zones. */
  setShowWallZonesDebug(flag: boolean): void {
    this.showWallZonesDebug = flag;
  }

  /** Render each tenpai seat's wait tiles. Driven by
   * `view.lastHandResult.waits` (populated by the replay reducer
   * from the archived `hand_end` event); has no effect in live
   * play because the wire snapshot doesn't carry waits, and
   * stays empty when the source replay log predates the
   * `waits` field.
   *
   * Additionally, while on, every tile currently waited on by any
   * tenpai seat — wherever it appears (live wall, dead wall,
   * concealed hands, discards, melds) — is tinted red. */
  setShowWaits(flag: boolean): void {
    this.showWaits = flag;
  }

  /** Tint the given tile sprite red iff its tile is in this frame's
   * wait set. Returns whether a tint was applied so callers can
   * suppress weaker tints (green future-draw, grey dead-wall) at
   * the same sprite site. Safe to call with `null` (face-down)
   * tiles; those never match a wait. */
  private tintIfWait(
    sprite: { tint: number },
    tile: string | null | undefined
  ): boolean {
    if (!tile || this.currentWaitTiles.size === 0) {
      return false;
    }
    // Normalize red fives (`0X` → `5X`) so they match the wait
    // set we built from `view.currentWaits` (which stores tiles
    // in canonical form, never `"0X"`).
    const norm = tile[0] === "0" ? `5${tile[1]}` : tile;
    if (this.currentWaitTiles.has(norm)) {
      sprite.tint = 0xff5555;
      return true;
    }
    return false;
  }

  /**
   * Build the drop-shadow sprite for a tile, or null when the active
   * design declares no shadow (or textures aren't loaded). The shadow
   * keeps its art's natural aspect, is sized to the tile height, and
   * is stuck to the tile's RIGHT edge — then nudged by the design
   * offset. All placement is SCREEN-space, rotated back through
   * `screenRotation` (the total wrap-local → screen rotation) so it
   * lands the same way for every seat. Because every tile is net-zero
   * rotation on screen, the footprint w/h are the on-screen dims, so
   * the silhouette follows the aspect (portrait → small, landscape →
   * side) unless `big` is set (the focused hand). `cx`/`cy` are the
   * tile's CENTRE in the wrap-local frame; callers place the returned
   * sprite behind the tile.
   */
  private makeTileShadow(
    footprint: {
      width: number;
      height: number;
      rotation: number;
      cx: number;
      cy: number;
    },
    screenRotation: number,
    opts?: { big?: boolean }
  ): Sprite | null {
    const factory = this.spriteFactory;
    const store = this.textureStore;
    const shadow = this.tileDesign.effects.shadow;
    if (!factory || !store || !shadow) {
      return null;
    }
    const atlasId = opts?.big
      ? shadow.big
      : footprint.width > footprint.height
        ? shadow.side
        : shadow.small;
    // Match the settled column/basic shadow exactly: fixed `depth`
    // thickness (not the texture's natural aspect) so the flying
    // tile's shadow doesn't read thicker than where it lands.
    const h = footprint.height;
    const w = shadow.depth;
    const s = factory.create({
      atlasId,
      tile: null,
      width: w,
      height: h,
      rotation: footprint.rotation,
      anchor: 0.5,
    });
    if (shadow.alpha !== undefined) {
      s.alpha = shadow.alpha;
    }
    // Stick the shadow's left edge to the tile's right edge, then
    // nudge by the design offset — in screen space, rotated back
    // through the container/wrap rotation.
    const screenDx = footprint.width / 2 + w / 2 + shadow.offsetX;
    const screenDy = shadow.offsetY;
    const cos = Math.cos(screenRotation);
    const sin = Math.sin(screenRotation);
    s.position.set(
      footprint.cx + screenDx * cos + screenDy * sin,
      footprint.cy - screenDx * sin + screenDy * cos
    );
    return s;
  }

  /**
   * Add a tile's drop shadow to its area container in a wrap that sits
   * below every tile ({@link SHADOW_LAYER_Z}), so a shadow never
   * renders on top of a neighbouring tile. `wrapX/wrapY/wrapRotation`
   * mirror the tile wrap's transform. The area container must have
   * `sortableChildren` enabled.
   */
  private placeTileShadow(
    area: Container,
    shadow: Sprite,
    wrapX: number,
    wrapY: number,
    wrapRotation: number
  ): void {
    const sw = new Container();
    sw.addChild(shadow);
    sw.position.set(wrapX, wrapY);
    sw.rotation = wrapRotation;
    sw.zIndex = SHADOW_LAYER_Z;
    area.addChild(sw);
  }

  /**
   * Continuous drop shadow down a COLUMN of tiles, on the column's
   * right edge and below every tile ({@link SHADOW_LAYER_Z}). The
   * design's `long` strip is 3-sliced: fixed soft caps at both ends
   * (regions 1-3 and 7-9) with the solid middle repeated to fill the
   * column, so one band spans it without per-tile shadows overlapping
   * and neither end is clipped. `x`
   * is the column's right edge (the strip's dark side sits here,
   * against the tiles), `y` the column top, `length` down +y.
   */
  private placeLineShadow(
    area: Container,
    x: number,
    y: number,
    length: number
  ): void {
    const store = this.textureStore;
    const shadow = this.tileDesign.effects.shadow;
    if (!store || !shadow || length <= 0) {
      return;
    }
    const tex = store.getTexture(shadow.long, null);
    // Pure 9-slice: fixed native caps (the shadow's soft ends) with the
    // middle repeated. `shadow.cap` is sized to fit both caps in the
    // shortest real column; the min() only guards a degenerate one
    // from overlapping, it isn't a per-length shrink.
    const cap = Math.min(tex.height * shadow.cap, length / 2);
    const ns = new NineSliceSprite({
      texture: tex,
      leftWidth: 0,
      topHeight: cap,
      rightWidth: 0,
      bottomHeight: cap,
    });
    ns.width = shadow.depth; // texture u → +x depth (dark edge → feather right)
    ns.height = length; // texture v → +y column length (middle repeated)
    ns.position.set(x + shadow.offsetX, y + shadow.offsetY);
    ns.zIndex = SHADOW_LAYER_Z;
    if (shadow.alpha !== undefined) {
      ns.alpha = shadow.alpha;
    }
    area.addChild(ns);
  }

  /**
   * A screen-aligned child layer (counter-rotated by the area's
   * rotation so its axes match the screen), below every tile. Line
   * shadows placed here fall screen-right whatever the seat rotation.
   */
  private screenShadowLayer(container: Container, rotation: number): Container {
    const layer = new Container();
    layer.rotation = -rotation;
    layer.zIndex = SHADOW_LAYER_Z;
    container.addChild(layer);
    return layer;
  }

  /**
   * Single-tile drop shadow on a tile's screen-right edge (the basic
   * per-orientation atlas), for screen-columns of one tile where the
   * long strip's end caps would overflow. `xRight,ay` is the tile's
   * right-edge midpoint in the screen-aligned layer.
   */
  private placeBasicShadow(
    layer: Container,
    xRight: number,
    ay: number,
    h: number,
    atlas: string
  ): void {
    const store = this.textureStore;
    const shadow = this.tileDesign.effects.shadow;
    if (!store || !shadow) {
      return;
    }
    const s = new Sprite(store.getTexture(atlas, null));
    s.anchor.set(0, 0.5);
    s.width = shadow.depth;
    s.height = h;
    s.position.set(xRight + shadow.offsetX, ay + shadow.offsetY);
    s.zIndex = SHADOW_LAYER_Z;
    if (shadow.alpha !== undefined) {
      s.alpha = shadow.alpha;
    }
    layer.addChild(s);
  }

  /**
   * Drop shadow for a single UPRIGHT (standing) tile — the focused
   * hand and the face-down top hand. The sprite is a soft blob, so it
   * keeps its natural aspect (fit to the tile height, uniform scale)
   * and sits flush against the tile's BOTTOM-RIGHT corner rather than
   * being stretched into a thin band. These hands never stack tiles,
   * so no gap-filling is needed. `xRight,yBottom` is the tile's
   * bottom-right corner in the screen-aligned layer.
   */
  private placeUprightShadow(
    layer: Container,
    xRight: number,
    yBottom: number,
    tileH: number,
    atlas: string
  ): void {
    const store = this.textureStore;
    const shadow = this.tileDesign.effects.shadow;
    if (!store || !shadow) {
      return;
    }
    const tex = store.getTexture(atlas, null);
    const s = new Sprite(tex);
    s.anchor.set(0, 1);
    const fit = tex.height > 0 ? tileH / tex.height : 1;
    s.scale.set(fit * (shadow.uprightScale ?? 1));
    s.position.set(xRight + shadow.offsetX, yBottom + shadow.offsetY);
    s.zIndex = SHADOW_LAYER_Z;
    if (shadow.alpha !== undefined) {
      s.alpha = shadow.alpha;
    }
    layer.addChild(s);
  }

  /**
   * Group screen-aligned tile boxes into screen-vertical columns and
   * draw one shadow per column on its screen-right edge: a 3-sliced
   * strip for runs of 2+ tiles, or a single basic shadow for a lone
   * tile. `boxes` carry each tile's screen-aligned centre (`ax,ay`)
   * and on-screen footprint (`w,h`). Columns bucket by centre x, or by
   * the screen-right edge when `bucketByRightEdge` is set (discards, so
   * a flush-aligned sideways riichi tile merges into its row's strip).
   */
  private placeColumnShadows(
    layer: Container,
    boxes: ReadonlyArray<{ ax: number; ay: number; w: number; h: number }>,
    bucketByRightEdge = false
  ): void {
    const shadow = this.tileDesign.effects.shadow;
    if (!shadow) {
      return;
    }
    const cols = new Map<
      number,
      Array<{ ax: number; ay: number; w: number; h: number }>
    >();
    for (const b of boxes) {
      const key = Math.round(bucketByRightEdge ? b.ax + b.w / 2 : b.ax);
      const list = cols.get(key);
      if (list) {
        list.push(b);
      } else {
        cols.set(key, [b]);
      }
    }
    for (const list of cols.values()) {
      // Sort top→bottom, then split into contiguous runs so a real gap
      // in the column (e.g. the half-tile dead-wall/live-wall split)
      // breaks the strip instead of being bridged by one continuous
      // shadow. A gap is a centre-to-centre jump well above the
      // column's normal tile pitch.
      list.sort((a, b) => a.ay - b.ay);
      const emitRun = (
        run: Array<{ ax: number; ay: number; w: number; h: number }>
      ): void => {
        if (run.length === 0) {
          return;
        }
        if (run.length === 1) {
          const b = run[0];
          this.placeBasicShadow(
            layer,
            b.ax + b.w / 2,
            b.ay,
            b.h,
            b.w > b.h ? shadow.side : shadow.small
          );
          return;
        }
        let right = -Infinity;
        let top = Infinity;
        let bottom = -Infinity;
        for (const b of run) {
          right = Math.max(right, b.ax + b.w / 2);
          top = Math.min(top, b.ay - b.h / 2);
          bottom = Math.max(bottom, b.ay + b.h / 2);
        }
        this.placeLineShadow(layer, right, top, bottom - top);
      };
      // Normal pitch = median consecutive spacing, robust to a single
      // large gap and to the freshly-discarded tile's +10/+10 nudge.
      const gaps: number[] = [];
      for (let i = 1; i < list.length; i++) {
        gaps.push(list[i].ay - list[i - 1].ay);
      }
      const sortedGaps = [...gaps].sort((a, b) => a - b);
      const pitch =
        sortedGaps.length > 0
          ? sortedGaps[Math.floor(sortedGaps.length / 2)]
          : 0;
      let run: Array<{ ax: number; ay: number; w: number; h: number }> = [];
      for (let i = 0; i < list.length; i++) {
        if (
          i > 0 &&
          pitch > 0 &&
          list[i].ay - list[i - 1].ay > pitch * 1.4 + 1
        ) {
          emitRun(run);
          run = [];
        }
        run.push(list[i]);
      }
      emitRun(run);
    }
  }

  /** Render opponent hands face-up. In live play opponents are
   * always redacted (`null` tiles), so this only changes anything
   * for replays. */
  setShowHands(flag: boolean): void {
    this.showHands = flag;
  }

  /** Reveal the wall tile faces. Driven by `view.liveWall` (the
   * omniscient live wall snapshotted at `hand_start` and threaded
   * through the replay reducer); has no effect in live play
   * because the wire `hand_start` event strips the wall, and
   * stays a no-op when the source replay log predates the
   * `liveWall` field. Dead-wall tiles other than the revealed
   * dora indicators remain face-down. */
  setShowWalls(flag: boolean): void {
    this.showWalls = flag;
  }

  /** Include the initial 52 dealt tiles in the wall visualization. */
  setShowUndealtWall(flag: boolean): void {
    this.showUndealtWall = flag;
  }

  /** Mark this renderer as a live spectator view: hides the draw
   * (live) wall and shows only the dead wall (4 kan-replacement
   * tiles, the dora indicator, and up to 4 kan-dora indicators)
   * fixed at the left of the bottom wall, since a relay never
   * broadcasts live/dead wall tiles. */
  setLiveSpectate(flag: boolean): void {
    if (this.liveSpectate === flag) {
      return;
    }
    this.liveSpectate = flag;
    this.requestRender();
  }

  /**
   * Enable the live-spectator "sequenced" discard/draw timeline and
   * (optionally) route the retimed discard/draw SFX. A Tenhou relay
   * delivers the next draw ~0 ms after the previous discard, so the
   * animator spaces them onto a serial clock: discard slides + hovers
   * for ~1s, then the draw slides in as the discard settles. When
   * `sounds` are supplied the cues fire at the slide landings, so the
   * caller must suppress its own event-driven discard/draw SFX.
   */
  setDrawSequencing(
    enabled: boolean,
    sounds?: {
      onDiscardLand: (seat: number, isRiichiDeclaration: boolean) => void;
      onDrawLand: (seat: number) => void;
    }
  ): void {
    this.animator.setSequenced(enabled);
    this.animator.setSoundHooks(sounds ?? {});
    this.requestRender();
  }

  /** Render seat display names alongside the score chips. */
  setShowNames(flag: boolean): void {
    this.showNames = flag;
  }

  /** Hide / show the post-hand win-info panel and the match-end
   * standings panel. Defaults to true. */
  setShowHandResult(flag: boolean): void {
    this.showHandResult = flag;
  }

  /**
   * Mirror the host route's live-play "Auto win" flag. When
   * enabled, ron/tsumo buttons are suppressed in
   * {@link renderActionButtons} since the host effect
   * auto-fires the win.
   */
  setAutoWinEnabled(flag: boolean): void {
    if (this.autoWinEnabled === flag) {
      return;
    }
    this.autoWinEnabled = flag;
    this.requestRender();
  }

  /**
   * Toggle the staged win-info reveal animation (yaku appearing
   * one at a time, ura-dora indicators revealed last). Disable
   * during replay playback so seekers see the full panel
   * immediately rather than waiting through a beat-locked
   * reveal that competes with the playhead. Defaults to true.
   */
  setStagedRevealEnabled(flag: boolean): void {
    if (this.stagedRevealEnabled === flag) {
      return;
    }
    this.stagedRevealEnabled = flag;
    // Clearing the start timestamp forces the next render to
    // either pick a fresh `now()` (enabled) or fall through to
    // the "fully revealed" branch (disabled).
    this.winPageRevealStartedAt = null;
    this.requestRender();
  }

  /**
   * Override the hand-result overlay's source data. Pass `null`
   */
  setHandResultOverride(
    r: NonNullable<MatchView["lastHandResult"]> | null
  ): void {
    this.handResultOverride = r;
  }

  /** Update the localized labels used by the center-square status
   * lines (honba / riichi sticks / live wall). Call from the
   * React layer after locale changes. */
  setCenterLabels(labels: {
    repeat: string;
    riichi: string;
    tiles: string;
  }): void {
    this.centerLabels = labels;
  }

  /** Update the localized labels used by the end-of-hand result
   * panel titles (exhaustive draw / abortive draw). Call from the
   * React layer after locale changes. */
  setResultLabels(labels: {
    exhaustiveDraw: string;
    abortTitle: string;
    abortKinds: {
      kyuushuu: string;
      suufonRenda: string;
      suuchaRiichi: string;
      sanchahou: string;
      unknown: string;
    };
    chomboTitle: string;
    chomboReasons: {
      sinkingWinNotFloating: string;
      gameEndingWinNotFirst: string;
      gameEndingChinmai: string;
    };
  }): void {
    this.resultLabels = labels;
  }

  /** Subscribe to result-panel-bounds updates. The callback fires
   * after every `render()` with the canvas-pixel rect of the
   * currently-visible result panel, or `null` when nothing is
   * showing. Pass `null` to clear. */
  setResultPanelBoundsListener(
    cb:
      | ((rect: { x: number; y: number; w: number; h: number } | null) => void)
      | null
  ): void {
    this.resultPanelBoundsListener = cb;
  }

  /** Subscribe to focused-seat pond-centre updates. The callback
   * fires after every `render()` with the canvas-pixel centre of
   * the human's discard pond, or `null` when no view is mounted.
   * Pass `null` to clear. */
  setPondCenterListener(
    cb: ((point: { x: number; y: number } | null) => void) | null
  ): void {
    this.pondCenterListener = cb;
  }

  /** Set per-seat team enrichment (name + logo) for spectator /
   * replay nameplates. Pass a 4-element array (index = seat); any
   * slot may be null. Triggers a re-render; logos load lazily. */
  setSeatEnrichment(list: (SeatEnrichment | null)[]): void {
    this.seatEnrichment = [
      list[0] ?? null,
      list[1] ?? null,
      list[2] ?? null,
      list[3] ?? null,
    ];
    this.requestRender();
  }

  /** Returns the cached logo texture for `url`, kicking off a lazy
   * load (and a re-render on completion) the first time. Returns
   * null until the texture is available. */
  private ensureTeamLogo(url: string): Texture | null {
    const cached = this.teamLogoTextures.get(url);
    if (cached) {
      return cached;
    }
    if (!this.teamLogoPending.has(url)) {
      this.teamLogoPending.add(url);
      void Assets.load(url)
        .then((tex) => {
          this.teamLogoTextures.set(url, tex as Texture);
          this.teamLogoPending.delete(url);
          this.requestRender();
        })
        .catch(() => {
          this.teamLogoPending.delete(url);
        });
    }
    return null;
  }

  /** Subscribe to focused-seat hand-strip bounds updates. The
   * callback fires after every `render()` with the canvas-pixel
   * rect of the bottom hand, or `null` when no view is mounted.
   * Pass `null` to clear. */
  setBottomHandBoundsListener(
    cb:
      | ((rect: { x: number; y: number; w: number; h: number } | null) => void)
      | null
  ): void {
    this.bottomHandBoundsListener = cb;
  }

  destroy(): void {
    this.clearFocusedHandHover(true);
    this.focusedHandHoverTargets = [];
    if (this.relativeScoresResetTimer !== null) {
      clearTimeout(this.relativeScoresResetTimer);
      this.relativeScoresResetTimer = null;
    }
    if (this.resizeRafHandle !== null) {
      cancelAnimationFrame(this.resizeRafHandle);
      this.resizeRafHandle = null;
    }
    if (this.renderRequestRafHandle !== null) {
      cancelAnimationFrame(this.renderRequestRafHandle);
      this.renderRequestRafHandle = null;
    }
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
    if (this.rightClickCleanup) {
      this.rightClickCleanup();
      this.rightClickCleanup = null;
    }
    // Free the framed sub-textures the store created; base atlas
    // sources stay in the Pixi asset cache (see the note below).
    this.textureStore?.destroy();
    this.textureStore = null;
    this.spriteFactory = null;
    if (this.app) {
      if (this.timerTickHandler) {
        this.app.ticker.remove(this.timerTickHandler);
        this.timerTickHandler = null;
      }
      if (this.animatorTickHandler) {
        this.app.ticker.remove(this.animatorTickHandler);
        this.animatorTickHandler = null;
      }
      this.animator.reset();
      this.meldAnimator.reset();
      this.handSorter.reset();
      if (this.handDragCleanup) {
        this.handDragCleanup();
        this.handDragCleanup = null;
      }
      this.pendingHandClickCallback = null;
      // IMPORTANT: do NOT pass `texture: true` here. Pixi's
      // `Assets` cache hands back the same `Texture` instances on
      // every `Assets.load(...)` call, so destroying the base
      // textures on unmount poisons the cache: the very next
      // renderer that mounts (e.g. after a React strict-mode
      // double-invoke, or after the user navigates from /review →
      // /replays/:id) reuses already-destroyed `Texture`s and
      // paints invisible / black sprites — the "dark canvas on
      // first paint" symptom we kept chasing. `children: true`
      // still unmounts the display tree; textures stay alive in
      // the global asset cache where they belong.
      this.app.destroy(true, { children: true });
      this.app = null;
    }
    this.root = null;
    this.hudText = null;
    this.timerText = null;
    this.actionDeadline = null;
  }

  /** Re-render the entire table for the given view. Cheap enough at Phase 0.5 scale. */
  render(view: MatchView): void {
    if (!this.app || !this.root || !this.hudText) {
      return;
    }
    this.lastView = view;
    // Diff against the previous frame *before* anything else uses
    // `this.lastView`: the animator may schedule a new phase-A
    // discard slide (which renderSeat consumes below) or transition
    // a pending phase-A into phase B.
    this.animator.beginFrame(view);
    this.meldAnimator.beginFrame(view);
    // Focused-hand sort state: wipe on every hand boundary, then
    // reconcile customOrder + prune slide-tracks against the
    // current raw hand so any draw / discard / call since the last
    // frame is reflected.
    const handBoundary = HandSorter.isHandBoundary(
      this.prevHandSorterView,
      view
    );
    if (handBoundary) {
      this.handSorter.reset(this.autoSortPreference);
    }
    const rawHandSeat0 = view.hands[0] ?? [];
    this.handSorter.reconcile(rawHandSeat0);
    this.handSorter.pruneTracks(rawHandSeat0);
    this.prevHandSorterView = view;
    // Defensive: sync the canvas size to the `resizeTo` container.
    // Pixi v8's built-in `resizeTo` only auto-syncs on `window`
    // resize events, so if the container was zero-sized when
    // `app.init` ran (and that's exactly what happens on the first
    // render of a client-side navigation to /replays/:id, where
    // the route's div is committed in the same frame as our
    // mount effect) `app.screen` stays 0×0 until something
    // explicitly calls `resize()`. Doing it at the top of every
    // `render` keeps the scale math below honest for free; the
    // call is a no-op when dimensions are already current.
    this.app.resize();
    // Refresh the per-frame wait set from the server-precomputed
    // `view.currentWaits` (annotated by `~/game/replay/annotateWaits`
    // during the replay loader). Live play leaves `currentWaits`
    // as `null`, so the set stays empty and `tintIfWait` is a
    // cheap no-op. When `showWaits` is off we also leave the set
    // empty regardless of the precompute.
    //
    // Only the focused player's (`view.mySeat`) waits drive the
    // tint — the overlay is per-seat and follows the seat selector
    // in the replay viewer.
    if (
      this.showWaits &&
      view.currentWaits &&
      view.mySeat !== null &&
      view.mySeat !== undefined
    ) {
      const next = new Set<string>();
      const seatWaits = view.currentWaits[view.mySeat];
      if (seatWaits) {
        for (const t of seatWaits) {
          next.add(t);
        }
      }
      this.currentWaitTiles = next;
    } else {
      if (this.currentWaitTiles.size > 0) {
        this.currentWaitTiles = new Set();
      }
    }
    // Auto-exit riichi-select mode the moment the server stops
    // offering riichi options for this turn (declaration confirmed,
    // turn passed, hand ended, etc.).
    if (
      this.riichiMode &&
      !view.legalActions.some((a) => a.type === "riichi")
    ) {
      this.riichiMode = false;
    }
    // Scale the design-space root to fit inside the current canvas
    // while preserving aspect ratio, centred within whichever axis
    // has slack. `resizeTo: container` keeps the canvas sized to its
    // parent, so this makes every asset scale with the window.
    const screenW = this.app.screen.width;
    const screenH = this.app.screen.height;

    // Board geometry comes from the active layout config; the
    // renderer scales this design-space table to fit the canvas.
    const layout = tableLayoutFromConfig(this.layoutConfig);
    const scale = Math.min(screenW / layout.table.w, screenH / layout.table.h);
    this.root.scale.set(scale);
    this.root.position.set(
      (screenW - layout.table.w * scale) / 2,
      (screenH - layout.table.h * scale) / 2
    );
    const root = this.root;
    this.clearFocusedHandHover();
    this.focusedHandHoverTargets = [];
    // Tear down the previous frame's display tree. `removeChildren()`
    // alone only detaches — it leaves the per-child GPU buffers
    // (Graphics geometry, render-group caches) live until GC.
    // During a hand drag we rebuild the entire tree ~60+ times per
    // second; without explicit destruction those buffers pile up
    // and the renderer (and any subsequent discard animation)
    // chokes. Sprites share cached `Texture` instances from
    // `getTileTexture`, so `texture: false` keeps the asset cache
    // intact.
    const oldChildren = root.removeChildren();
    for (const child of oldChildren) {
      child.destroy({ children: true, texture: false });
    }

    // Felt: paint the central tile-bearing region (bounding box of
    // the four wall bands plus the four player hands) in classic
    // mahjong green so the play area still reads as "felt", while
    // the canvas background around the player-info chips stays
    // neutral dark gray.
    const feltBox = boundingBox([...layout.wall, ...layout.hands]);
    this.feltBoxDesign = feltBox;
    const felt = new Graphics()
      .rect(feltBox.x, feltBox.y, feltBox.w, feltBox.h)
      .fill({ color: FELT_COLOR });
    felt.zIndex = -30;
    root.addChild(felt);
    // Radial vignette darkening the felt toward its edges. Sits above
    // the felt fill but below the hand panels and every tile, so the
    // multiply only shades the green play area.
    if (this.feltMaskTex) {
      const feltMask = new Sprite(this.feltMaskTex);
      feltMask.position.set(feltBox.x, feltBox.y);
      feltMask.width = feltBox.w;
      feltMask.height = feltBox.h;
      feltMask.blendMode = "multiply";
      feltMask.zIndex = -20;
      root.addChild(feltMask);
    }
    // Static darkened mats framing each seat's hand + meld band and
    // the maximum 6×3 footprint of each discard pond.
    this.renderHandPanels(layout);
    this.renderDiscardPanels(layout);
    // Stash the felt's bottom-right in screen coords so the timer
    // HUD (which lives on `app.stage`, not `root`) can hug it.
    this.timerAnchor = {
      x: root.position.x + (feltBox.x + feltBox.w) * scale,
      y: root.position.y + (feltBox.y + feltBox.h) * scale,
    };

    // Centre of the table, used by overlays anchored to the middle
    // (scores, round info, result panels).
    const cx = layout.center.x + layout.center.w / 2;
    const cy = layout.center.y + layout.center.h / 2;

    if (this.showLayoutDebug) {
      this.renderLayoutDebug(layout);
    }
    if (this.showWallZonesDebug) {
      this.renderWallZonesDebug(layout);
    }

    // Seat 0 (bottom — `you`), 1 (right), 2 (top), 3 (left).
    // Painter's order: top first (furthest from viewer), then the
    // side seats, then the bottom seat last so the human's own
    // discards / melds / hand always sit on top of any neighbour
    // pond that extends into the same screen area (e.g. a long
    // right-seat discard row spilling toward the centre would
    // otherwise occlude the human's row).
    const seatPaintOrder: ReadonlyArray<number> = [2, 1, 3, 0];
    for (const seat of seatPaintOrder) {
      this.renderSeat(view, seat, cx, cy, layout);
    }

    this.renderCenterScoreToggle(layout.center);
    // Per-seat score chips + dealer marker.
    this.renderScores(view, layout.center);
    // Per-seat identity content next to each discard pond. It sits above
    // the identity panel background but below every board tile layer.
    this.renderPlayerNames(view, layout);
    // Round / honba / sticks / wall-remaining centre block.
    this.renderRoundInfo(view, layout.center);
    // Wall stacks + dora indicators around the centre.
    this.renderWalls(view, layout);

    // HUD — only meaningful on live matches; suppressed for replays
    // (no WS, no seq, no meaningful conn status). Count every draw,
    // including rinshan replacements, because each one reduces the
    // number of drawable wall tiles.
    const conn = view.conn;
    const wall = Math.max(0, 70 - view.drawsTaken);
    const seq = view.lastSeq;
    if (conn === "replay") {
      this.hudText.text = "";
      this.actionDeadline = null;
      this.actionBufferMs = null;
    } else {
      this.hudText.text = `conn: ${conn}   wall: ${wall}   seq: ${seq}`;
      this.actionDeadline = view.actionDeadline;
      this.actionBufferMs = view.actionBufferMs;
    }
    // Render one timer frame immediately so the value reflects the
    // latest `view` even if the Pixi ticker hasn't fired since the
    // last `render()`.
    this.tickTimer();

    // Call / action buttons (chi/pon/kan/ron/pass). Discard-style
    // legals stay tile-driven; only "decision" actions surface here.
    this.renderActionButtons(view, cx);

    // Hand-result panel — shown after a hand ends and stays up
    // until the next `hand_start` clears `lastHandResult`. Both
    // panels honour the host toggle. A hand result is also hidden
    // while the pointer is held inside its visible bounds.
    let designRect: { x: number; y: number; w: number; h: number } | null =
      null;
    const effectiveResult = this.handResultOverride ?? view.lastHandResult;
    if (!effectiveResult || view.matchEnded) {
      this.currentWinPageResultKey = null;
      this.currentWinPage = 0;
      this.winPageRevealStartedAt = null;
    }
    this.winInfoPressEnabled = Boolean(effectiveResult && !view.matchEnded);
    if (this.showHandResult && !this.handResultPressHidden) {
      if (effectiveResult && !view.matchEnded) {
        designRect = this.renderHandResult(
          view,
          effectiveResult,
          cx,
          cy,
          layout
        );
      }
      if (view.matchEnded) {
        designRect = this.renderMatchEnd(view, cx, cy);
      }
    }

    // Publish the result-panel bounds (in canvas pixels) for host
    // controls anchored to the panel. The fit transform applied to
    // `this.root` earlier in this method is mirrored here. We dedupe against
    // the last-reported value to avoid spamming React with
    // identical updates on every render.
    let nextBounds: { x: number; y: number; w: number; h: number } | null =
      null;
    if (designRect) {
      const sx = this.root.scale.x;
      const sy = this.root.scale.y;
      nextBounds = {
        x: designRect.x * sx + this.root.position.x,
        y: designRect.y * sy + this.root.position.y,
        w: designRect.w * sx,
        h: designRect.h * sy,
      };
    }
    const prev = this.lastResultPanelBounds;
    const changed =
      (prev === null) !== (nextBounds === null) ||
      (prev !== null &&
        nextBounds !== null &&
        (prev.x !== nextBounds.x ||
          prev.y !== nextBounds.y ||
          prev.w !== nextBounds.w ||
          prev.h !== nextBounds.h));
    if (changed) {
      this.lastResultPanelBounds = nextBounds;
      if (this.resultPanelBoundsListener) {
        this.resultPanelBoundsListener(nextBounds);
      }
    }

    // Publish the focused seat's discard-pond centre so the
    // React layer can anchor the post-hand "peek" eye button to
    // the middle of the human's pond. Same fit-transform mirror
    // + dedupe as the result-panel listener above.
    const seat = view.mySeat ?? 0;
    const pond = layout.discards[seat];
    const sx2 = this.root.scale.x;
    const sy2 = this.root.scale.y;
    const nextPond = {
      x: (pond.x + pond.w / 2) * sx2 + this.root.position.x,
      y: (pond.y + pond.h / 2) * sy2 + this.root.position.y,
    };
    const prevPond = this.lastPondCenter;
    if (
      prevPond === null ||
      prevPond.x !== nextPond.x ||
      prevPond.y !== nextPond.y
    ) {
      this.lastPondCenter = nextPond;
      if (this.pondCenterListener) {
        this.pondCenterListener(nextPond);
      }
    }

    // Publish the focused seat's hand-strip bounds (canvas px) so
    // the React layer can lift overlays (e.g. the review comment
    // bubble) above the player's tiles instead of overlapping them.
    // Same fit-transform mirror + dedupe as the listeners above.
    const bottomHand = layout.hands[seat];
    const nextHandBounds = {
      x: bottomHand.x * sx2 + this.root.position.x,
      y: bottomHand.y * sy2 + this.root.position.y,
      w: bottomHand.w * sx2,
      h: bottomHand.h * sy2,
    };
    const prevHand = this.lastBottomHandBounds;
    if (
      prevHand === null ||
      prevHand.x !== nextHandBounds.x ||
      prevHand.y !== nextHandBounds.y ||
      prevHand.w !== nextHandBounds.w ||
      prevHand.h !== nextHandBounds.h
    ) {
      this.lastBottomHandBounds = nextHandBounds;
      if (this.bottomHandBoundsListener) {
        this.bottomHandBoundsListener(nextHandBounds);
      }
    }
    this.updateFocusedHandHover();
  }

  // -------------------------------------------------------------------------
  // Score / round / result overlays
  // -------------------------------------------------------------------------

  private renderCenterScoreToggle(center: Rect): void {
    if (!this.root) {
      return;
    }
    const hitArea = new Graphics()
      .rect(center.x, center.y, center.w, center.h)
      .fill({ color: 0x000000, alpha: 0.001 });
    hitArea.eventMode = "static";
    hitArea.cursor = "pointer";
    hitArea.on("pointerdown", (event) => {
      if (event.button !== 0) {
        return;
      }
      event.stopPropagation();
      if (event.nativeEvent instanceof Event) {
        event.nativeEvent.preventDefault();
        event.nativeEvent.stopPropagation();
      }
      if (this.relativeScoresResetTimer !== null) {
        clearTimeout(this.relativeScoresResetTimer);
        this.relativeScoresResetTimer = null;
      }
      this.showRelativeScores = !this.showRelativeScores;
      if (this.showRelativeScores) {
        this.relativeScoresResetTimer = setTimeout(() => {
          this.relativeScoresResetTimer = null;
          this.showRelativeScores = false;
          this.requestRender();
        }, RELATIVE_SCORE_DISPLAY_MS);
      }
      this.requestRender();
    });
    this.root.addChild(hitArea);
  }

  private renderScores(view: MatchView, center: Rect): void {
    if (!this.root) {
      return;
    }
    const cx = center.x + center.w / 2;
    const cy = center.y + center.h / 2;
    // Inset from the centre rect edges. Each chip is rotated to
    // face its seat: seat 0 (bottom) reads upright, seat 1 (right)
    // reads from the right, etc. Chip dimensions are scaled off the
    // centre rect so they shrink/grow with the table.
    const {
      width: chipW,
      height: chipH,
      inset,
    } = scoreCartridgeMetrics(center);
    const indicatorSeat = activePlayerIndicatorSeat(view);
    type ChipSpec = { x: number; y: number; rotation: number };
    const specs: ChipSpec[] = [
      { x: cx, y: center.y + center.h - inset - chipH / 2, rotation: 0 },
      {
        x: center.x + center.w - inset - chipH / 2,
        y: cy,
        rotation: -Math.PI / 2,
      },
      { x: cx, y: center.y + inset + chipH / 2, rotation: Math.PI },
      { x: center.x + inset + chipH / 2, y: cy, rotation: Math.PI / 2 },
    ];
    for (let seat = 0; seat < 4; seat++) {
      const spec = specs[seat];
      const chip = new Container();
      const bg = new Graphics()
        .roundRect(-chipW / 2, -chipH / 2, chipW, chipH, 6)
        .fill({ color: 0x000000, alpha: 0.7 });
      const txt = new Text({
        text: formatTableScore(
          view.scores[seat],
          view.scores[0],
          this.showRelativeScores && seat !== 0
        ),
        style: new TextStyle({
          fontFamily: "Inter, system-ui, sans-serif",
          fontSize: Math.max(12, Math.round(chipH * 0.6)),
          fontWeight: "700",
          // Sinking seats (Buu mode, score <= sinkThreshold) get
          // a red score; everyone else stays white.
          fill: view.sinking[seat] ? 0xff6b6b : 0xffffff,
        }),
      });
      const horizontalPadding = Math.round(chipH * 0.35);
      txt.anchor.set(1, 0.5);
      txt.position.set(chipW / 2 - horizontalPadding, 0);
      // Seat wind kanji, anchored to the left edge of the chip.
      // The active player's wind is red; otherwise East is white
      // and the remaining winds are muted grey.
      const wind = WIND_KANJI[(seat - view.dealer + 4) % 4];
      const isEast = wind === "東";
      const isActiveSeat = indicatorSeat === seat;
      const windTxt = new Text({
        text: wind,
        style: new TextStyle({
          fontFamily: KANJI_FONT_FAMILY,
          fontSize: Math.max(16, chipH),
          fontWeight: "400",
          fill: isActiveSeat ? 0xff4d4f : isEast ? 0xffffff : 0x9ca3af,
        }),
      });
      windTxt.anchor.set(0, 0.5);
      windTxt.position.set(-chipW / 2 + horizontalPadding, 0);
      chip.addChild(bg, windTxt, txt);
      // Seat display names are rendered separately by
      // `renderPlayerNames` next to each discard pond.
      // Wait tiles below the chip (toggle: showWaits). Sourced
      // from `lastHandResult.waits[seat]` — only present between
      // `hand_end` and the next `hand_start`. Rendered in
      // chip-local coords so the per-seat rotation orients the
      // text to face the seated player. Restricted to the focused
      // player so the overlay matches the per-seat tint.
      if (
        this.showWaits &&
        view.lastHandResult?.waits &&
        view.mySeat === seat
      ) {
        const seatWaits = view.lastHandResult.waits[seat];
        if (seatWaits && seatWaits.length > 0) {
          const waitTxt = new Text({
            text: `待: ${seatWaits.join(" ")}`,
            style: new TextStyle({
              fontFamily: "Inter, system-ui, sans-serif",
              fontSize: Math.max(10, Math.round(chipH * 0.5)),
              fontWeight: "600",
              fill: 0x86efac,
              stroke: { color: 0x000000, width: 3 },
            }),
          });
          waitTxt.anchor.set(0.5, 0.0);
          waitTxt.position.set(0, chipH / 2 + 4);
          chip.addChild(waitTxt);
        }
      }
      chip.rotation = spec.rotation;
      chip.position.set(spec.x, spec.y);
      this.root.addChild(chip);
    }
  }

  private renderRoundInfo(view: MatchView, center: Rect): void {
    if (!this.root) {
      return;
    }
    const cx = center.x + center.w / 2;
    const cy = center.y + center.h / 2;
    const label = `${ROUND_WIND_KANJI[view.roundWind]} - ${view.roundNumber}`;
    const fontSize = Math.max(22, Math.round(center.h * 0.13 * 1.6));
    const heading = new Text({
      text: label,
      style: new TextStyle({
        fontFamily: KANJI_FONT_FAMILY,
        fontSize,
        fontWeight: "400",
        fill: 0xffffff,
      }),
    });
    heading.anchor.set(0.5, 0.5);
    // Three small status lines below the heading: honba counters,
    // riichi sticks, and wall remaining. Stacked vertically.
    const lineSize = Math.max(10, Math.round(center.h * 0.085));
    const lineGap = Math.round(lineSize * 0.25);
    // The drawable wall starts at 70 after the deal. Rinshan draws
    // count too: each replacement moves one live-wall tail tile into
    // the dead wall, reducing the number of future draws by one.
    const wallRemaining = Math.max(0, 70 - view.drawsTaken);
    // Buu Mahjong has no repeat counter, so omit the honba line
    // entirely in that mode rather than rendering a stale "Repeat: 0".
    const lineSpecs: Array<{ label: string; value: string; color: number }> = [
      ...(view.buuMode === true
        ? []
        : [
            {
              label: this.centerLabels.repeat,
              value: String(view.honba),
              color: 0xfde68a,
            },
          ]),
      {
        label: this.centerLabels.riichi,
        value: String(view.riichiSticks),
        color: 0xfca5a5,
      },
      {
        label: this.centerLabels.tiles,
        value: String(wallRemaining),
        color: 0xd1d5db,
      },
    ];
    // Preserve the established heading placement independently from the
    // status rows, with a further 2 px drop to clear the top cartridge.
    const linesBlockH =
      lineSpecs.length * lineSize + (lineSpecs.length - 1) * lineGap;
    const headingGap = Math.round(lineSize * 0.6);
    const totalH = fontSize + headingGap + linesBlockH;
    const topY = cy - totalH / 2 + 3;
    heading.position.set(cx, topY + fontSize / 2 + 2);
    this.root.addChild(heading);

    // Keep the status rows as a separate visual block immediately above
    // the bottom score cartridge. The block's bottom edge is the anchor;
    // its colon axis is offset slightly right for visual balance.
    const statusBlock = new Container();
    const { bottomTop } = scoreCartridgeMetrics(center);
    statusBlock.position.set(cx + 10, bottomTop - linesBlockH);
    let lineY = lineSize / 2;
    for (const spec of lineSpecs) {
      const style = new TextStyle({
        fontFamily: "Inter, system-ui, sans-serif",
        fontSize: lineSize,
        fontWeight: "600",
        fill: spec.color,
      });
      const labelText = new Text({ text: spec.label, style });
      const colonText = new Text({ text: ":", style });
      const valueText = new Text({ text: spec.value, style });
      const valueGap = Math.round(lineSize * 0.3);
      labelText.anchor.set(1, 0.5);
      colonText.anchor.set(0.5, 0.5);
      valueText.anchor.set(0, 0.5);
      labelText.position.set(-colonText.width / 2, lineY);
      colonText.position.set(0, lineY);
      valueText.position.set(colonText.width / 2 + valueGap, lineY);
      statusBlock.addChild(labelText, colonText, valueText);
      lineY += lineSize + lineGap;
    }
    this.root.addChild(statusBlock);
  }

  /**
   * Render each seat's display name in a darkened frame next to
   * their discard pond, on the right side from that seat's
   * viewing perspective. The label rotation matches the seat so
   * the text reads upright to the seated player.
   */
  private renderPlayerNames(view: MatchView, layout: TableLayout): void {
    if (!this.root || !this.showNames || !view.seatNames) {
      return;
    }
    const fontSize = 14;
    const padY = 4;
    const buuMode = view.buuMode === true;
    // Build all per-seat sub-objects first so we can pick a single
    // uniform box size for every seat (user requirement).
    type Built = {
      seat: 0 | 1 | 2 | 3;
      nameText: Text;
      chipText: Text | null;
      teamLogoTex: Texture | null;
      isDisconnected: boolean;
      hasDabuken: boolean;
    };
    const built: Built[] = [];
    let maxChipTextW = 0;
    let maxNameH = 0;
    for (let seat = 0; seat < 4; seat++) {
      const name = view.seatNames[seat];
      if (!name) {
        continue;
      }
      const occ = view.roomState?.seats[seat]?.occupant;
      const isDisconnected =
        occ !== undefined &&
        occ !== null &&
        occ.kind === "human" &&
        occ.connected === false;
      const nameText = new Text({
        text: name,
        style: new TextStyle({
          fontFamily: "Inter, system-ui, sans-serif",
          fontSize,
          fontWeight: "700",
          fill: 0xffffff,
          stroke: { color: 0x000000, width: 4, join: "round" },
        }),
      });
      nameText.anchor.set(0.5, 0.5);
      const maxNameWidth = PLAYER_PANEL_SIZE - 16;
      if (nameText.width > maxNameWidth) {
        nameText.scale.set(maxNameWidth / nameText.width);
      }
      maxNameH = Math.max(maxNameH, Math.ceil(nameText.height));
      let chipText: Text | null = null;
      if (buuMode) {
        chipText = new Text({
          text: String(view.chips[seat] ?? 0),
          style: new TextStyle({
            fontFamily: "Inter, system-ui, sans-serif",
            fontSize: 13,
            fontWeight: "700",
            fill: 0xfde68a,
          }),
        });
        chipText.anchor.set(0.5, 0.5);
        maxChipTextW = Math.max(maxChipTextW, Math.ceil(chipText.width));
      }
      let teamLogoTex: Texture | null = null;
      const enrich = this.seatEnrichment[seat];
      if (enrich?.teamLogoUrl) {
        teamLogoTex = this.ensureTeamLogo(enrich.teamLogoUrl);
      }
      built.push({
        seat: seat as 0 | 1 | 2 | 3,
        nameText,
        chipText,
        teamLogoTex,
        isDisconnected,
        hasDabuken: buuMode && view.dabuken[seat] === true,
      });
    }
    if (built.length === 0) {
      return;
    }
    // Row metrics.
    const nameRowH = maxNameH + padY * 2;
    const chipIconR = 14; // chip icon radius (px)
    const chipIconGap = 4; // gap between chip icon and count
    const chipRowH = buuMode ? Math.max(maxNameH, chipIconR * 2) + 4 : 0;
    const dabukenR = 26; // dabuken token radius (px) — 2× the chip icon
    const dabukenRowH = buuMode ? dabukenR * 2 + 4 : 0;
    // Width: max of name, chip-line content, and dabuken token.
    const chipLineW = buuMode ? chipIconR * 2 + chipIconGap + maxChipTextW : 0;
    const h = nameRowH + chipRowH + dabukenRowH;
    // Row centre y positions inside the box (anchor at (0,0) =
    // box centre; +y down).
    const nameCY = -h / 2 + nameRowH / 2;
    const chipCY = -h / 2 + nameRowH + chipRowH / 2;
    const dabukenCY = -h / 2 + nameRowH + chipRowH + dabukenRowH / 2;
    for (const b of built) {
      const { seat, nameText, chipText, isDisconnected, hasDabuken } = b;
      const rect = layout.discards[seat];
      const identityCenter = this.playerPanelCenter(
        this.discardPanelRect(rect, seat),
        seat
      );
      const container = new Container();
      // Enriched (team) nameplate: team logo as the box background with the
      // player name on top, anchored to the player's hand (player-right end,
      // reading upright for that seat).
      if (b.teamLogoTex) {
        // (a) Team-logo nameplate next to the player's discard, with the team
        // name on a pill just below it (both read upright for the viewer).
        const S = PLAYER_PANEL_SIZE;
        const logoMask = new Graphics()
          .roundRect(-S / 2, -S / 2, S, S, 8)
          .fill(0xffffff);
        const logo = new Sprite(b.teamLogoTex);
        logo.anchor.set(0.5, 0.5);
        const logoScale = Math.min(
          S / b.teamLogoTex.width,
          S / b.teamLogoTex.height
        );
        logo.width = b.teamLogoTex.width * logoScale;
        logo.height = b.teamLogoTex.height * logoScale;
        logo.mask = logoMask;
        container.addChild(logoMask, logo);

        nameText.position.set(0, S / 2 - nameText.height / 2 - 8);
        container.addChild(nameText);

        // Keep the team name inside the logo area as a compact top label.
        const teamName = this.seatEnrichment[seat]?.teamName;
        if (teamName) {
          const tnText = new Text({
            text: teamName,
            style: new TextStyle({
              fontFamily: "Inter, system-ui, sans-serif",
              fontSize: 14,
              fontWeight: "600",
              fill: 0xffffff,
            }),
          });
          tnText.anchor.set(0.5, 0.5);
          const tnw = Math.ceil(tnText.width) + 10;
          const tnh = Math.ceil(tnText.height) + 4;
          const tnBg = new Graphics()
            .roundRect(-tnw / 2, -tnh / 2, tnw, tnh, 4)
            .fill({ color: 0x000000, alpha: 0.6 })
            .stroke({ color: 0xffffff, width: 1, alpha: 0.3 });
          const tnBox = new Container();
          tnBox.addChild(tnBg, tnText);
          tnBox.position.set(0, -S / 2 + tnh / 2 + 4);
          container.addChild(tnBox);
        }

        container.rotation = SEAT_CONTAINER_ROT[seat];
        container.position.set(identityCenter.x, identityCenter.y);
        container.zIndex = PLAYER_PANEL_CONTENT_Z;
        this.root.addChild(container);
        continue;
      }
      nameText.position.set(0, buuMode ? nameCY : 0);
      container.addChild(nameText);
      if (buuMode && chipText) {
        // Chip icon: use the imported PNG when available; fall
        // back to a procedural two-tone disc when the texture
        // hasn't loaded (or failed to load).
        const iconCX = -chipLineW / 2 + chipIconR;
        let icon: Container;
        if (this.chipIconTex) {
          const sprite = new Sprite(this.chipIconTex);
          sprite.anchor.set(0.5, 0.5);
          sprite.width = chipIconR * 2;
          sprite.height = chipIconR * 2;
          icon = sprite;
        } else {
          icon = new Graphics()
            .circle(0, 0, chipIconR)
            .fill({ color: 0xfacc15 })
            .stroke({ color: 0xffffff, width: 1, alpha: 0.9 })
            .circle(0, 0, chipIconR - 3)
            .stroke({ color: 0xffffff, width: 1, alpha: 0.6 });
        }
        icon.position.set(iconCX, chipCY);
        container.addChild(icon);
        chipText.position.set(
          iconCX + chipIconR + chipIconGap + Math.ceil(chipText.width) / 2,
          chipCY
        );
        container.addChild(chipText);
      }
      if (hasDabuken) {
        // Dabuken: use the imported PNG when available; fall back
        // to a procedural red disc with "x2" overlay otherwise.
        let token: Container;
        if (this.dabukenIconTex) {
          const sprite = new Sprite(this.dabukenIconTex);
          sprite.anchor.set(0.5, 0.5);
          sprite.width = dabukenR * 2;
          sprite.height = dabukenR * 2;
          token = sprite;
        } else {
          const g = new Graphics()
            .circle(0, 0, dabukenR)
            .fill({ color: 0xdc2626 })
            .stroke({ color: 0xffffff, width: 1.5, alpha: 0.95 })
            .circle(0, 0, dabukenR - 4)
            .stroke({ color: 0xffffff, width: 1, alpha: 0.7 });
          const x2 = new Text({
            text: "x2",
            style: new TextStyle({
              fontFamily: "Inter, system-ui, sans-serif",
              fontSize: 12,
              fontWeight: "800",
              fill: 0xffffff,
            }),
          });
          x2.anchor.set(0.5, 0.5);
          const c = new Container();
          c.addChild(g, x2);
          token = c;
        }
        token.position.set(0, dabukenCY);
        container.addChild(token);
      }
      // Disconnect badge: only rendered for live game / spectator
      // views (`roomState` populated). Replay viewer leaves
      // `roomState === null`, so badges never paint in archived
      // playback. A small red pill below the box reads "DC".
      if (isDisconnected) {
        const badgeTxt = new Text({
          text: "DC",
          style: new TextStyle({
            fontFamily: "Inter, system-ui, sans-serif",
            fontSize: 10,
            fontWeight: "700",
            fill: 0xffffff,
            letterSpacing: 0.5,
          }),
        });
        badgeTxt.anchor.set(0.5, 0.5);
        const bw = Math.ceil(badgeTxt.width) + 8;
        const bh = Math.ceil(badgeTxt.height) + 2;
        const badgeBg = new Graphics()
          .roundRect(-bw / 2, -bh / 2, bw, bh, 4)
          .fill({ color: 0xb91c1c, alpha: 0.95 })
          .stroke({ color: 0xffffff, width: 1, alpha: 0.6 });
        const badge = new Container();
        badge.addChild(badgeBg, badgeTxt);
        badge.position.set(0, h / 2 + bh / 2 + 2);
        container.addChild(badge);
      }
      container.rotation = SEAT_CONTAINER_ROT[seat];
      container.position.set(identityCenter.x, identityCenter.y);
      container.zIndex = PLAYER_PANEL_CONTENT_Z;
      this.root.addChild(container);
    }
  }

  /**
   * Render the four wall bands. Each band shows up to 17 face-down
   * tiles laid along its long axis (Tenhou-style top-down view —
   * the second tile of each stack is hidden underneath in 2D).
   * Dora indicators render face-up on the right-hand end of the
   * top wall (seat 2), which is the conventional dead-wall area.
   *
   * Step 5: face-down rendering only. The `showWalls` overlay
   * (Step 7) will reveal the wall tile values.
   */
  private renderWalls(view: MatchView, layout: TableLayout): void {
    if (!this.root) {
      return;
    }
    // Live spectate: a relay feed carries no live/dead wall tiles, so
    // draw only the dead wall (dora + kan tiles) at a fixed position.
    if (this.liveSpectate) {
      this.renderDeadWallOnly(view, layout);
      return;
    }
    // 16-px vertical (screen-y) offset of the upper stack tile
    // relative to the lower stack tile. Applied uniformly to every
    // wall (consequence: top/bottom walls show two visible rows of
    // tiles separated by 16 px in screen-y; left/right walls show
    // each upper-stack tile peeking out 16 px above its lower-stack
    // partner).
    const ROW_OFFSET_Y = 16;
    // Long-axis overlap between consecutive side-wall tiles.
    const SIDE_TILE_OVERLAP = this.tileDesign.spacing.wallSide;
    // Cross-axis overlap between the two visible rows of a stack
    // when the `showWalls` overlay flattens the wall.
    const WALL_REVEAL_ROW_OVERLAP = 16;
    // Wall tile footprints + per-seat sheets come from the design.
    const wallUpright = this.tileDesign.metrics.wallUpright;
    const SIDE_WALL_SCREEN_W = this.tileDesign.metrics.wallSide.screenW;
    const SIDE_WALL_ASPECT = this.tileDesign.metrics.wallSide.aspect;

    // ---------------------------------------------------------------
    // Wall topology
    // ---------------------------------------------------------------
    //
    // 4 walls × 17 stacks × 2 tiles = 136 tiles. Each seat's wall is
    // indexed locally by `k = 0..16`. The local-axis orientation of
    // the wall bands in this renderer (set by `renderWalls`'s per-
    // seat positioning code) is:
    //   seat 0 (bottom): k=0 at bottom-LEFT corner,  k=16 at bottom-RIGHT
    //   seat 1 (right) : k=0 at bottom-RIGHT corner, k=16 at top-RIGHT
    //   seat 2 (top)   : k=0 at top-RIGHT corner,    k=16 at top-LEFT
    //   seat 3 (left)  : k=0 at top-LEFT corner,     k=16 at bottom-LEFT
    // Within each seat, +k therefore points in the seat's player-
    // RIGHT direction (and adjacent corners line up between seats).
    //
    // `gpos = 0..67` is a circular index advancing CW around the
    // perimeter, with seat s occupying gpos s*17..s*17+16. The
    // continuity matches: seat 0 k=16 (bottom-RIGHT) ↔ seat 1 k=0
    // (bottom-RIGHT), seat 1 k=16 ↔ seat 2 k=0, etc.
    const gposOf = (s: number, k: number): number => s * 17 + k;

    // Break point: dice sum → count seats CCW from dealer
    // (1=dealer) → land on `breakSeat`. Seats 0,1,2,3 are arranged
    // CCW around the table, so CCW = increasing seat index.
    const dice = view.dice ?? [3, 4];
    const sumRaw = (dice[0] ?? 1) + (dice[1] ?? 1);
    const sum = Math.max(2, Math.min(12, sumRaw));
    const breakSeat = (view.dealer + sum - 1) % 4;
    // Within breakSeat, count `sum` stacks from the player-RIGHT
    // end. With +k = player-RIGHT in our local index, the player-
    // right end is k=16; the Nth stack from that end is at
    // k = 16 - (sum - 1) = 17 - sum. Break sits on the player-LEFT
    // edge of that stack.
    const stackIdxFromRight = 17 - sum;
    const breakStackGpos = gposOf(breakSeat, stackIdxFromRight);

    // Assign a role to every gpos.
    //   - dead[i] (i=0..6): i=0 is the break-side stack (= the
    //     stack the dice counted to), i=6 is the rinshan end
    //     farthest from the break.
    //   - live[j] (j=0..60): j=0 is the first stack to drain
    //     (immediately CCW of the break, i.e. one step past the
    //     break in player-LEFT direction); j=60 is the last
    //     (adjacent to the rinshan end of the dead wall).
    type GposRole =
      | { kind: "dead"; idxFromBreak: number }
      | { kind: "live"; drawStackIdx: number };
    const roles = new Map<number, GposRole>();
    for (let i = 0; i < 7; i++) {
      // Dead wall extends in +gpos direction from the break stack
      // (player-LEFT of the break point inside breakSeat, then
      // wrapping into the next CW seat's wall).
      const g = (((breakStackGpos + i) % 68) + 68) % 68;
      roles.set(g, { kind: "dead", idxFromBreak: i });
    }
    for (let j = 0; j < 61; j++) {
      // Live wall extends from the break in the -gpos direction
      // (the opposite end from the dead wall). j=0 is the first
      // stack to drain — adjacent to the break point / dora end of
      // the dead wall; j=60 is the last remaining stack — adjacent
      // to the rinshan end of the dead wall.
      const g = (((breakStackGpos - 1 - j) % 68) + 68) % 68;
      roles.set(g, { kind: "live", drawStackIdx: j });
    }

    // At hand_start the 4×13 = 52 initial-deal tiles have already
    // been taken off the live wall. The store's `liveDrawsTaken`
    // counts post-deal live-wall draws only (excludes rinshan), so
    // we pre-offset here. Falls back to `drawsTaken` for live
    // snapshots that don't distinguish rinshan draws.
    const INITIAL_DEAL_TILES = this.showUndealtWall ? 0 : 52;
    const liveDrawsConsumed = view.liveDrawsTaken ?? view.drawsTaken;
    const drawsTaken = liveDrawsConsumed + INITIAL_DEAL_TILES;
    // Number of kans declared this hand = total draws minus
    // live-wall draws (the difference is the rinshan replacement
    // draws). Each kan removes one rinshan tile from the dead
    // wall and shifts one tile from the rinshan end of the live
    // wall into the dead wall to preserve its 14-tile count.
    const kanCount = this.showUndealtWall
      ? 0
      : Math.max(0, Math.min(4, view.drawsTaken - liveDrawsConsumed));

    for (let seat = 0; seat < 4; seat++) {
      const band = layout.wall[seat];
      const isHoriz = seat % 2 === 0;
      const screenTileW = isHoriz ? wallUpright.w : SIDE_WALL_SCREEN_W;
      const screenTileH = isHoriz
        ? wallUpright.h
        : SIDE_WALL_SCREEN_W * SIDE_WALL_ASPECT;
      const tileLongDim = isHoriz ? screenTileW : screenTileH;
      const baseStride = isHoriz
        ? screenTileW
        : screenTileH - SIDE_TILE_OVERLAP;
      // Uniform gap at any dead↔live boundary within a single band.
      const gapSize = 6;

      // Compute the long-axis offset (from the player-right anchor,
      // measured toward player-left) of each stack k=0..16. Insert
      // `gapSize` before any stack whose role differs from the
      // previous stack's.
      const longOffsets: number[] = new Array(17);
      let cursor = 0;
      let prevKind: "live" | "dead" | null = null;
      for (let k = 0; k < 17; k++) {
        const g = gposOf(seat, k);
        const role = roles.get(g);
        if (!role) {
          longOffsets[k] = cursor;
          cursor += baseStride;
          prevKind = null;
          continue;
        }
        if (prevKind !== null && prevKind !== role.kind) {
          cursor += gapSize;
        }
        longOffsets[k] = cursor;
        cursor += baseStride;
        prevKind = role.kind;
      }

      const tileCrossDim = isHoriz ? screenTileH : screenTileW;
      const bandCross = isHoriz ? band.h : band.w;
      const crossAtEnd = seat === 2 || seat === 3;
      const crossInset = crossAtEnd ? bandCross - tileCrossDim : 0;

      const wallContainer = new Container();
      wallContainer.sortableChildren = true;
      const backSheet = this.tileDesign.sheets.wallBack[
        seat as Seat
      ] as SheetKey;
      const faceSheet = this.tileDesign.sheets.wallFace[
        seat as Seat
      ] as SheetKey;
      const wallShadowBoxes: Array<{
        ax: number;
        ay: number;
        w: number;
        h: number;
      }> = [];

      for (let k = 0; k < 17; k++) {
        const g = gposOf(seat, k);
        const role = roles.get(g);
        if (!role) {
          continue;
        }
        const longOffset = longOffsets[k];
        for (let row = 0; row < 2; row++) {
          // Skip already-drawn live tiles. Within a stack, the
          // upper tile (row 1) drains first, then the lower
          // (row 0).
          if (role.kind === "live") {
            const tileDrawIdx = role.drawStackIdx * 2 + (row === 1 ? 0 : 1);
            if (tileDrawIdx < drawsTaken) {
              continue;
            }
          }
          // Skip dead-wall positions consumed by rinshan draws.
          // Each kan removes one rinshan tile from the break-side
          // end of the dead wall, top tile first:
          //   kan 1 → idxFromBreak=0, row 1 (upper of break stack)
          //   kan 2 → idxFromBreak=0, row 0
          //   kan 3 → idxFromBreak=1, row 1
          //   kan 4 → idxFromBreak=1, row 0
          if (role.kind === "dead" && role.idxFromBreak <= 1 && kanCount > 0) {
            const rinshanOrder = role.idxFromBreak * 2 + (row === 1 ? 0 : 1);
            if (rinshanOrder < kanCount) {
              continue;
            }
          }
          // Mark the last `kanCount` live-wall tiles as "pulled
          // into the dead wall" — drawn greyed-out but still in
          // place so the dead wall visually keeps its 14 tiles.
          // Live tiles drain in `tileDrawIdx` order; the haitei
          // (last drawable) sits at tileDrawIdx 121, so the
          // pulled tiles occupy indices 122 - kanCount .. 121.
          let livePulledToDead = false;
          if (role.kind === "live" && kanCount > 0) {
            const tileDrawIdx = role.drawStackIdx * 2 + (row === 1 ? 0 : 1);
            if (tileDrawIdx >= 122 - kanCount) {
              livePulledToDead = true;
            }
          }
          // Dora / kan-dora face-up reveals on the dead wall's
          // upper tile. Indicator rank counts 1-based from break:
          //   rank 3 → standard dora indicator
          //   rank 4..7 → kan-dora indicators (revealed by kans)
          // The renderer trusts `view.doraIndicators` ordering:
          // index 0 is the standard dora, 1..4 are kan-doras.
          let faceUpTile: string | null = null;
          // Set when the dead-wall tile is revealed by the
          // `showWalls` overlay (i.e. NOT a live dora-indicator
          // reveal). Drives a subtle grey tint to visually
          // de-emphasize cheat-reveal positions vs. the
          // dora-indicators that would naturally be visible.
          let greyOutDeadWall = false;
          if (role.kind === "dead" && row === 1) {
            const rank = role.idxFromBreak + 1;
            if (rank === 3) {
              faceUpTile = view.doraIndicators[0] ?? null;
            } else if (rank >= 4 && rank <= 7) {
              const di = rank - 3;
              faceUpTile = view.doraIndicators[di] ?? null;
            }
          }
          // `showWalls` overlay: when the source carries the
          // omniscient dead-wall snapshot, reveal all 14 dead-wall
          // tiles. Mapping `deadWall[idxFromBreak * 2 + row]`
          // matches Tenhou's yama-index convention: row 1 (upper)
          // tiles get odd indices (yama[5]=dora,
          // yama[7]=kan-dora-1, ...); row 0 (lower) tiles get
          // even indices (yama[4]=ura-dora, yama[0..3]=rinshan).
          if (
            this.showWalls &&
            view.deadWall &&
            role.kind === "dead" &&
            faceUpTile === null
          ) {
            const deadIdx = role.idxFromBreak * 2 + row;
            if (deadIdx >= 0 && deadIdx < view.deadWall.length) {
              faceUpTile = view.deadWall[deadIdx];
              greyOutDeadWall = true;
            }
          }
          // `showWalls` overlay: when the source carries the
          // omniscient live wall, reveal every still-on-the-wall
          // live tile face. `tileDrawIdx` is overall-game-relative
          // (includes the initial 52-tile deal), so the index into
          // `view.liveWall` is `tileDrawIdx - 52` (the deal tiles
          // were never in `liveWall` to begin with). Dead-wall
          // tiles remain face-down except for the dora indicators
          // already handled above — revealing rinshan / ura
          // positions would need extra threading we haven't done.
          let highlightFutureDraw = false;
          if (
            this.showWalls &&
            view.liveWall &&
            role.kind === "live" &&
            faceUpTile === null
          ) {
            const tileDrawIdx = role.drawStackIdx * 2 + (row === 1 ? 0 : 1);
            const liveIdx = tileDrawIdx - INITIAL_DEAL_TILES;
            if (liveIdx >= 0 && liveIdx < view.liveWall.length) {
              faceUpTile = view.liveWall[liveIdx];
              // Highlight in green every wall tile the focused
              // seat will draw later in this kyoku. Schedule is
              // computed by `annotateWallSchedule` from the
              // recorded event history — not a forecast.
              if (
                view.mySeat !== null &&
                view.liveDrawSchedule &&
                view.liveDrawSchedule[liveIdx] === view.mySeat
              ) {
                highlightFutureDraw = true;
              }
            }
          }

          // Position. The player-right anchor of seat S:
          //   seat 0 (bottom): screen-right (band.x + band.w)
          //   seat 1 (right) : screen-bottom (band.y + band.h)
          //   seat 2 (top)   : screen-left (band.x)
          //   seat 3 (left)  : screen-top (band.y)
          // Long axis (toward player-left, increasing k) goes:
          //   seat 0: -x   seat 1: -y   seat 2: +x   seat 3: +y
          //
          // Two layouts are supported here:
          //
          //   (1) Default Tenhou-style perspective (showWalls off):
          //       row 1 (upper stack) and row 0 (lower stack) are
          //       offset by ±ROW_OFFSET_Y/2 on the cross axis on
          //       horizontal walls, and side walls additionally
          //       shift row 1 along the long axis by ROW_OFFSET_Y
          //       to create the "peek" effect.
          //
          //   (2) Flat reveal layout (showWalls on): both rows are
          //       fully visible and stacked along the cross axis.
          //       The "top row" (row 1 = upper stack tile) sits
          //       flush at the band's inner edge — i.e. the side
          //       facing the table center — and the "bottom row"
          //       (row 0 = lower stack tile) sits just outward of
          //       it, overlapping by WALL_REVEAL_ROW_OVERLAP. Side
          //       walls drop the per-row long-axis offset so the
          //       two rows sit at the same long-axis position.
          //       Z-order is per-wall (see below).
          let x = 0;
          let y = 0;
          if (this.showWalls) {
            // outerOffset = 0 for the inner ("top") row, and
            // (tileCrossDim - overlap) for the outer ("bottom")
            // row — pushing it away from table center.
            //
            // Horizontal walls (seats 0, 2) overlap their two rows
            // by `WALL_REVEAL_ROW_OVERLAP`; vertical (side) walls
            // (seats 1, 3) butt the rows edge-to-edge with no
            // overlap, per the layout spec.
            const rowOverlap = isHoriz ? WALL_REVEAL_ROW_OVERLAP : 0;
            const outerOffset = row === 0 ? tileCrossDim - rowOverlap : 0;
            // Side walls (seats 1, 3) get nudged 8 px toward the
            // top of the screen so their rendered rows line up
            // visually with the bottom/top wall rows. Horizontal
            // walls keep their long-axis anchor unchanged.
            const sideLift = !isHoriz ? -8 : 0;
            if (seat === 0) {
              x = band.x + longOffset;
              y = band.y + outerOffset;
            } else if (seat === 1) {
              x = band.x + outerOffset;
              y = band.y + band.h - tileLongDim - longOffset + sideLift;
            } else if (seat === 2) {
              x = band.x + band.w - tileLongDim - longOffset;
              y = band.y + bandCross - tileCrossDim - outerOffset;
            } else {
              // seat 3
              x = band.x + bandCross - tileCrossDim - outerOffset;
              y = band.y + longOffset + sideLift;
            }
          } else if (seat === 0) {
            // +k goes player-RIGHT = +x (east) across the bottom
            // wall. k=0 anchors at the band's left edge so the
            // run flows from bottom-LEFT corner to bottom-RIGHT
            // corner as k advances.
            x = band.x + longOffset;
            y =
              band.y +
              16 +
              crossInset +
              (row === 0 ? ROW_OFFSET_Y / 2 : -ROW_OFFSET_Y / 2);
          } else if (seat === 1) {
            x = band.x + crossInset + 8;
            y =
              band.y +
              band.h -
              tileLongDim -
              longOffset -
              (row === 1 ? ROW_OFFSET_Y : 0);
          } else if (seat === 2) {
            // +k goes player-RIGHT = -x (west) across the top
            // wall. k=0 anchors at the band's right edge so the
            // run flows from top-RIGHT corner to top-LEFT corner
            // as k advances.
            x = band.x + band.w - tileLongDim - longOffset;
            y =
              band.y +
              crossInset +
              (row === 0 ? ROW_OFFSET_Y / 2 : -ROW_OFFSET_Y / 2);
          } else {
            // seat 3
            x = band.x + crossInset;
            y = band.y + longOffset - (row === 1 ? ROW_OFFSET_Y : 0);
          }

          // Pick the seat-appropriate sheet: face-up tiles need
          // pre-rotated artwork so the revealed tile reads from
          // the seat's viewing direction; back tiles use the
          // seat's back-tile sheet (which for seats 2 / 3 is the
          // bottom / right sheet because their own per-seat sheet
          // doesn't include a back-tile cell).
          const sheetToUse = faceUpTile !== null ? faceSheet : backSheet;
          const tex = this.getTileTexture(sheetToUse, faceUpTile);
          const sprite = new Sprite(tex);
          sprite.anchor.set(0.5, 0.5);
          sprite.width = screenTileW;
          sprite.height = screenTileH;
          sprite.position.set(screenTileW / 2, screenTileH / 2);
          // Green tint for live-wall tiles the focused seat will
          // draw later this kyoku (see schedule lookup above).
          // Multiplicative — keeps tile artwork legible while
          // washing it in green.
          // Wait-tile red tint takes priority over the future-draw
          // green and dead-wall grey washes (this is the whole
          // point of the `showWaits` overlay).
          if (this.tintIfWait(sprite, faceUpTile)) {
            // already tinted
          } else if (highlightFutureDraw) {
            sprite.tint = 0x88ff88;
          } else if (greyOutDeadWall || livePulledToDead) {
            // Slight grey wash on dead-wall reveals so the
            // dora-indicators (revealed naturally during play)
            // remain the visually prominent dead-wall tiles.
            // Also applied to live-wall tiles that have been
            // pulled into the dead wall by kans.
            sprite.tint = 0xb0b0b0;
          }
          const child = new Container();
          child.addChild(sprite);
          child.position.set(x, y);
          // Z-order:
          //   - Within a stack, the upper-peeking tile (row 1) sits
          //     on top of its partner (row 0).
          //   - Across stacks in the same row, the tile lower on
          //     screen sits on top of its neighbour (Tenhou-style
          //     perspective). For side walls (seats 1/3) this means
          //     we can't rely on insertion order alone, because the
          //     loop walks k in player-right→player-left order
          //     which is bottom→top on screen for seat 1.
          //
          // In showWalls mode the row-z is reversed for every wall
          // except seat 2 (top): the user wants the "bottom row"
          // (row 0) overlapping OVER the "top row" (row 1) for the
          // bottom and side walls, and UNDER it for the top wall.
          let crossZ = 0;
          if (seat === 1) {
            crossZ = 16 - k;
          } else if (seat === 3) {
            crossZ = k;
          }
          const rowZ = this.showWalls && seat !== 2 ? 1 - row : row;
          child.zIndex = rowZ * 100 + crossZ;
          wallContainer.addChild(child);
          // Lower wall tiles (row 0) cast a shadow below every tile;
          // the upper peeking tile (row 1) does not.
          if (row === 0) {
            wallShadowBoxes.push({
              ax: x + screenTileW / 2,
              ay: y + screenTileH / 2,
              w: screenTileW,
              h: screenTileH,
            });
          }
        }
      }
      // Screen-right column shadow per wall column, below the tiles
      // (the wall container is unrotated → already screen-aligned).
      this.placeColumnShadows(
        this.screenShadowLayer(wallContainer, 0),
        wallShadowBoxes
      );

      wallContainer.zIndex = seat === 0 ? 2 : seat === 2 ? 0 : 1;
      this.root.sortableChildren = true;
      this.root.addChild(wallContainer);
    }
  }

  /**
   * Live-spectate dead wall. A relay never broadcasts the live wall
   * or the omniscient dead-wall snapshot, and can't detect kans from
   * draw counts, so we render a fixed 7-stack dead-wall block at the
   * LEFT of the bottom-wall band — independent of the dice break and
   * the focused seat. Face-up reveals (dora + kan-dora indicators)
   * come from the live-broadcast `doraIndicators`; everything else
   * stays face-down.
   */
  private renderDeadWallOnly(view: MatchView, layout: TableLayout): void {
    if (!this.root) {
      return;
    }
    const ROW_OFFSET_Y = 16;
    const band = layout.wall[0];
    const wallUpright = this.tileDesign.metrics.wallUpright;
    const screenTileW = wallUpright.w;
    const screenTileH = wallUpright.h;
    const stride = screenTileW;
    const backSheet = this.tileDesign.sheets.wallBack[0] as SheetKey;
    const faceSheet = this.tileDesign.sheets.wallFace[0] as SheetKey;

    const container = new Container();
    container.sortableChildren = true;
    const wallShadowBoxes: Array<{
      ax: number;
      ay: number;
      w: number;
      h: number;
    }> = [];
    // 7 stacks × 2 rows, idxFromBreak 0..6 laid out left→right:
    //   stacks 0,1        = the 4 kan-replacement (rinshan) tiles
    //   stack 2 upper     = dora indicator, lower = ura-dora
    //   stacks 3..6 upper = kan-dora indicators (shown once revealed)
    for (let s = 0; s < 7; s++) {
      for (let row = 0; row < 2; row++) {
        let faceUpTile: string | null = null;
        if (row === 1) {
          const rank = s + 1;
          if (rank === 3) {
            faceUpTile = view.doraIndicators[0] ?? null;
          } else if (rank >= 4 && rank <= 7) {
            faceUpTile = view.doraIndicators[rank - 3] ?? null;
          }
        }
        const tex = this.getTileTexture(
          faceUpTile !== null ? faceSheet : backSheet,
          faceUpTile
        );
        const sprite = new Sprite(tex);
        sprite.anchor.set(0.5, 0.5);
        sprite.width = screenTileW;
        sprite.height = screenTileH;
        sprite.position.set(screenTileW / 2, screenTileH / 2);
        const child = new Container();
        child.addChild(sprite);
        const childX = band.x + s * stride;
        const childY =
          band.y + (row === 0 ? ROW_OFFSET_Y / 2 : -ROW_OFFSET_Y / 2);
        child.position.set(childX, childY);
        // Upper stack tile (row 1) peeks over its lower partner.
        child.zIndex = row;
        container.addChild(child);
        if (row === 0) {
          wallShadowBoxes.push({
            ax: childX + screenTileW / 2,
            ay: childY + screenTileH / 2,
            w: screenTileW,
            h: screenTileH,
          });
        }
      }
    }
    this.placeColumnShadows(
      this.screenShadowLayer(container, 0),
      wallShadowBoxes
    );
    // Wall layer on the sortable root (below discards=5 / hands=10).
    container.zIndex = 2;
    this.root.addChild(container);
  }

  private renderHandResult(
    view: MatchView,
    r: NonNullable<MatchView["lastHandResult"]>,
    cx: number,
    cy: number,
    layout: TableLayout
  ): { x: number; y: number; w: number; h: number } | null {
    if (!this.root) {
      return null;
    }
    const resultKey = winResultRevealKey(view, r);
    if (this.currentWinPageResultKey !== resultKey) {
      this.currentWinPageResultKey = resultKey;
      this.currentWinPage = 0;
      this.winPageRevealStartedAt = null;
    }
    // For wins, the upstream stream emits one or more `win`
    // events followed by `hand_end`. Both produce a
    // `lastHandResult`, which would surface the panel prematurely
    // (and without per-seat deltas). Suppress the intermediate
    // state: a win's panel only renders once `hand_end` has
    // filled in the deltas.
    if (r.wins && r.wins.length > 0 && !r.delta) {
      return null;
    }

    // Inner rect bounded by the 4 hand bands. The result overlay
    // (backdrop + center panel + score boxes) is constrained to
    // this rectangle so the hand strips remain visible.
    const inner: Rect = {
      x: layout.hands[3].x + layout.hands[3].w,
      y: layout.hands[2].y + layout.hands[2].h,
      w: layout.hands[1].x - (layout.hands[3].x + layout.hands[3].w),
      h: layout.hands[0].y - (layout.hands[2].y + layout.hands[2].h),
    };

    // Wrap the entire result overlay in a single high-zIndex
    // container so it draws above the walls and hand strips
    // (which set their own zIndex on the root's sortable children).
    const overlay = new Container();
    overlay.zIndex = 1000;
    this.root.sortableChildren = true;
    this.root.addChild(overlay);

    // Semi-transparent backdrop so the result panel stands out
    // over the table — restricted to the inner area between the
    // four hand bands.
    const backdrop = new Graphics()
      .rect(inner.x, inner.y, inner.w, inner.h)
      .fill({ color: 0x000000, alpha: 0.6 });
    overlay.addChild(backdrop);

    // Center info: title, yaku list, han/fu total, and points
    // line (for wins); reason text otherwise.
    this.renderResultCenterInfo(
      r,
      cx,
      cy,
      overlay,
      view.seatNames,
      view.scoreCap
    );

    // Honba / riichi sticks pill, tucked into the top-left of the
    // result overlay.
    this.renderResultStickInfo(r, inner, overlay);

    // Four player boxes positioned at the seats, showing each
    // player's pre-delta score and the signed delta from this
    // hand.
    this.renderResultScoreBoxes(view, r, inner, overlay);

    return { x: inner.x, y: inner.y, w: inner.w, h: inner.h };
  }

  /**
   * Center stack of info for the result overlay. For wins this is
   *   - yaku list (one row per yaku: name on the left, "N han" on
   *     the right)
   *   - "N han M fu" or yakuman line (large)
   *   - points line: tsumo split / "X all" / "Npts" (large)
   * For exhaustive draws / aborts: a single label line.
   */
  private renderResultCenterInfo(
    r: NonNullable<MatchView["lastHandResult"]>,
    cx: number,
    cy: number,
    parent: Container,
    seatNames: MatchView["seatNames"],
    scoreCap: MatchView["scoreCap"]
  ): void {
    if (!this.root) {
      return;
    }
    const container = new Container();

    // Build the lines we want to render. Each entry is either a
    // single label (centered), a yaku name + value pair, a tile
    // row, the winner's hand strip, a compact two-cell score
    // row (han/fu + total pts, side-by-side so they read like a
    // header strip), or a divider between winners.
    type Row =
      | { kind: "yaku"; name: string; value: string; hidden?: boolean }
      | {
          kind: "yaku2";
          left: { name: string; value: string };
          right: { name: string; value: string } | null;
          leftHidden?: boolean;
          rightHidden?: boolean;
        }
      | { kind: "title"; text: string; size: number }
      | { kind: "label"; text: string; size: number; color?: number }
      | {
          kind: "scoreRow";
          han: string;
          pts: string | null;
          ptsColor?: number;
        }
      | { kind: "tiles"; tiles: (string | null)[] }
      | {
          kind: "hand";
          concealed: string[];
          winTile?: string;
          melds?: Meld[];
        }
      | { kind: "divider" };

    const rows: Row[] = [];

    if (r.wins && r.wins.length > 0 && !r.buuChombo) {
      const total = r.wins.length;
      // Clamp in case `wins` shrank (shouldn't happen in
      // practice, but cheap defense).
      if (this.currentWinPage >= total) {
        this.currentWinPage = 0;
        this.winPageRevealStartedAt = null;
      }
      // For a multi-winner result we paginate: render one
      // winner per panel; the user clicks the panel (handled
      // below, after layout) to advance. For a single winner
      // this is a no-op — page 0 of 1.
      const pageIdx = this.currentWinPage;
      const winsToRender = total > 1 ? [r.wins[pageIdx]] : r.wins;
      const stageReveal = shouldStageWinReveal(
        this.stagedRevealEnabled,
        this.handResultOverride !== null
      );
      // Staged reveal: each panel page (re)starts a per-yaku
      // reveal sequence. We record the wall-clock moment the
      // page first appeared and use elapsed time to decide how
      // many yaku entries are visible and whether the ura-dora
      // indicators have been flipped. When staged reveal is
      // disabled (replay playback or a historical eye-button
      // override) the elapsed time is set to `Infinity` so
      // everything renders fully revealed and silently.
      if (stageReveal) {
        if (this.winPageRevealStartedAt === null) {
          this.winPageRevealStartedAt = performance.now();
          // Fresh page: clear the SFX play tracking so each
          // subsequent yaku / ura reveal triggers exactly one
          // `yaku-reveal` cue.
          this.winPageYakuRevealSoundsPlayed = 0;
          this.winPageUraRevealSoundPlayed = false;
        }
      } else {
        this.winPageRevealStartedAt = null;
      }
      const revealElapsedMs = stageReveal
        ? performance.now() - (this.winPageRevealStartedAt ?? 0)
        : Number.POSITIVE_INFINITY;
      // Per-yaku reveal interval. Mirrored on the server in
      // `WIN_YAKU_REVEAL_INTERVAL_MS` so the post-hand OK-timer
      // doesn't start mid-reveal. Keep the two values in sync.
      const YAKU_REVEAL_INTERVAL_MS = 750;
      // Extra delay after the last yaku reveal before the
      // ura-dora indicators flip face-up (only used when the
      // hand had no "Ura Dora" yaku to peg the flip to). Also
      // mirrored on the server.
      const URA_REVEAL_AFTER_LAST_YAKU_MS = 1000;
      if (total > 1) {
        rows.push({
          kind: "label",
          text: `${pageIdx + 1} / ${total}`,
          size: 18,
          color: 0xcbd5e1,
        });
      }
      // Tracking for the post-loop ura-dora row visibility and
      // for the render-pump that keeps frames flowing while the
      // staged reveal is still mid-sequence.
      let pageHasUraYaku = false;
      let pageRevealedYakuCount = 0;
      let pageVisibleYakuTotal = 0;
      winsToRender.forEach((win, idx) => {
        if (idx > 0) {
          rows.push({ kind: "divider" });
        }
        // Title line: "Tsumo" / "Ron". For multi-ron each entry
        // is a ron; the panel renders one block per winner so
        // the title repeats with the winning hand below.
        if (r.reason === "tsumo") {
          rows.push({ kind: "title", text: "Tsumo", size: 36 });
        } else if (r.reason === "ron") {
          rows.push({ kind: "title", text: "Ron", size: 36 });
        }
        const yakuNames = Object.keys(win.yaku ?? {});
        const hasRiichiYaku = yakuNames.some(
          (name) =>
            name === "Riichi" ||
            name === "Double Riichi" ||
            name === "Daburu Riichi" ||
            name === "立直" ||
            name === "ダブル立直" ||
            name === "両立直"
        );
        const reserveUraRow =
          (win.uraDoraIndicators?.length ?? 0) > 0 ||
          (win.uraDoraCount !== undefined && hasRiichiYaku);
        const visibleYakuAll = buildResultYakuEntries(
          win.yaku,
          win.doraCount,
          win.uraDoraCount,
          reserveUraRow
        );
        const revealableYakuCount = visibleYakuAll.filter(
          (entry) => !entry.alwaysHidden
        ).length;
        const hasUraYaku = visibleYakuAll.some(
          (entry) => entry.name === "Ura Dora" && !entry.alwaysHidden
        );
        // Slice to the staged reveal frontier. Yaku k appears at
        // t = (k + 1) * YAKU_REVEAL_INTERVAL_MS, i.e. nothing is
        // visible until the first interval elapses.
        const revealedCount = stageReveal
          ? Math.max(
              0,
              Math.min(
                revealableYakuCount,
                Math.floor(revealElapsedMs / YAKU_REVEAL_INTERVAL_MS)
              )
            )
          : revealableYakuCount;
        // Fire one `yaku-reveal` SFX per newly revealed yaku.
        // Idempotent across repeated `render()` calls within the
        // same reveal step thanks to `winPageYakuRevealSoundsPlayed`.
        if (stageReveal && revealedCount > this.winPageYakuRevealSoundsPlayed) {
          const toPlay = revealedCount - this.winPageYakuRevealSoundsPlayed;
          for (let i = 0; i < toPlay; i++) {
            playGameSound("yaku-reveal");
          }
          this.winPageYakuRevealSoundsPlayed = revealedCount;
        }
        // Stash per-page totals for the ura-row gate + render
        // pump below. With pagination there is only one entry in
        // `winsToRender`, so an unconditional assign here is fine.
        pageVisibleYakuTotal = revealableYakuCount;
        pageRevealedYakuCount = revealedCount;
        pageHasUraYaku = hasUraYaku;
        // 1-column layout for short lists; 2-column for 5+
        // entries so very-yaku-rich hands (e.g. yakuman piles)
        // don't push the panel absurdly tall. We base the
        // column choice on the FULL list length so the layout
        // doesn't reflow mid-reveal as new yaku appear.
        //
        // We also push rows for the entire `visibleYakuAll`
        // list every frame (flagging not-yet-revealed entries
        // as `hidden`) so the panel reserves its final size
        // from the first frame — the staged reveal animates
        // text visibility, not panel geometry.
        if (visibleYakuAll.length <= 4) {
          visibleYakuAll.forEach((y, i) => {
            rows.push({
              kind: "yaku",
              name: y.name,
              value: y.value,
              hidden: y.alwaysHidden || i >= revealedCount,
            });
          });
        } else {
          const half = Math.ceil(visibleYakuAll.length / 2);
          for (let i = 0; i < half; i++) {
            const left = visibleYakuAll[i] ?? null;
            const rightIdx = i + half;
            const right = visibleYakuAll[rightIdx] ?? null;
            if (left === null && right === null) {
              continue;
            }
            rows.push({
              kind: "yaku2",
              left: left ?? { name: "", value: "" },
              right,
              leftHidden:
                left !== null && (left.alwaysHidden || i >= revealedCount),
              rightHidden:
                right !== null &&
                (right.alwaysHidden || rightIdx >= revealedCount),
            });
          }
        }
        // Han/fu summary or yakuman line, merged with the points
        // line into a single two-cell `scoreRow`. Keeping them on
        // one row makes that row narrow enough to sit at the same
        // vertical level as the side score boxes (we anchor on it
        // below), so the wide rows (yaku, hand, dora) can extend
        // above and below without overlapping the side boxes.
        const han = win.han ?? 0;
        const fu = win.fu ?? 0;
        const ym = win.yakumanCount ?? 0;
        // When the rule set caps the score at a tier (e.g. Buu
        // Mahjong: `scoreCap = "mangan"`), the server has already
        // clamped `win.ten` down to that tier. The raw han count
        // (and any yakuman flag) would otherwise misrepresent
        // the actual payout — a Buu hand worth 8 han or a single
        // yakuman both pay out as mangan, so we surface the cap
        // tier name instead of "8 han" / "Yakuman".
        const capMinHan = {
          mangan: 5,
          haneman: 6,
          baiman: 8,
          sanbaiman: 11,
        } as const;
        const capLabel = {
          mangan: "Mangan",
          haneman: "Haneman",
          baiman: "Baiman",
          sanbaiman: "Sanbaiman",
        } as const;
        const isCapped =
          scoreCap !== null && (ym > 0 || han >= capMinHan[scoreCap]);
        const hanLabel = isCapped
          ? capLabel[scoreCap]
          : ym > 0
            ? ym > 1
              ? `${ym}× Yakuman`
              : "Yakuman"
            : // From 5 han up the fu no longer affects the basic-
              // points calculation (mangan / haneman / ...), so
              // suppress it.
              han >= 5
              ? `${han} han`
              : `${han} han ${fu} fu`;
        // Points line. We take the value straight from the log
        // (`win.ten`) rather than re-computing from han/fu — the
        // server is the source of truth for scoring, which keeps
        // the display ruleset-agnostic.
        const ptsLabel = typeof win.ten === "number" ? `${win.ten}pts` : null;
        rows.push({
          kind: "scoreRow",
          han: hanLabel,
          pts: ptsLabel,
          ptsColor: 0xfde68a,
        });
        // Winning hand strip. The server records the concealed
        // hand at win time; we display it as a single row with
        // the agari tile separated by a small gap so reviewers
        // can see what the winner achieved (especially useful
        // for non-focused players).
        if (win.hand && win.hand.length > 0) {
          const { concealed: rawConcealed, agari } = splitWinningHandForDisplay(
            win.hand,
            win.winTile
          );
          // Sort the concealed portion so live wins render the
          // same canonically-ordered hand as replays. The winTile
          // is appended separately so it always sits on the
          // right of the strip, after a small gap.
          const concealed = sortHand(rawConcealed, false) as string[];
          // Re-anchor each meld's `from` relative to seat 0 so the
          // panel's upright `drawMeld(meld, 0)` lays the tilted
          // called tile at the correct edge regardless of the
          // winner's actual seat (server stores `from` as an
          // absolute seat).
          const melds: Meld[] | undefined = win.melds
            ?.filter((m) => m.tiles.length > 0)
            .map((m) => ({
              ...m,
              from:
                m.from === null
                  ? null
                  : (((m.from - win.seat + 4) % 4) as 0 | 1 | 2 | 3),
            }));
          rows.push({ kind: "hand", concealed, winTile: agari, melds });
        }
      });
      // Dora indicator row: always 5 slots, face-up for slots
      // the dealer has revealed so far (1 by default, +1 per
      // kan), the rest face-down. Shared across all winners in
      // a multi-ron (the indicators are determined by the
      // wall, not by who wins).
      const sharedDora =
        r.wins.find((w) => w.doraIndicators && w.doraIndicators.length > 0)
          ?.doraIndicators ?? [];
      const doraRow: (string | null)[] = Array.from({ length: 5 }, (_, i) =>
        i < sharedDora.length ? (sharedDora[i] ?? null) : null
      );
      rows.push({ kind: "tiles", tiles: doraRow });
      // Ura dora indicator row: only revealed when at least
      // one winner had declared riichi. Server gates this by
      // populating `uraDoraIndicators` only in that case.
      const sharedUra =
        r.wins.find(
          (w) => w.uraDoraIndicators && w.uraDoraIndicators.length > 0
        )?.uraDoraIndicators ?? [];
      if (sharedUra.length > 0) {
        // Staged reveal: keep the indicators face-down until
        // either the "Ura Dora" yaku (which we sort to last
        // above) is revealed, or — when the hand didn't score
        // any ura yaku — a one-second beat after the final yaku
        // appears. With staged reveal disabled the indicators
        // are always face-up (full panel).
        const lastYakuRevealAtMs =
          pageVisibleYakuTotal * YAKU_REVEAL_INTERVAL_MS;
        const uraRevealAtMs = pageHasUraYaku
          ? lastYakuRevealAtMs
          : lastYakuRevealAtMs + URA_REVEAL_AFTER_LAST_YAKU_MS;
        const uraRevealed =
          !stageReveal ||
          (pageRevealedYakuCount >= pageVisibleYakuTotal &&
            revealElapsedMs >= uraRevealAtMs);
        const uraRow: (string | null)[] = uraRevealed
          ? Array.from({ length: 5 }, (_, i) =>
              i < sharedUra.length ? (sharedUra[i] ?? null) : null
            )
          : Array.from({ length: 5 }, () => null);
        rows.push({ kind: "tiles", tiles: uraRow });
        // Fire a single `yaku-reveal` cue when the indicators
        // flip face-up — but only when there's no "Ura Dora"
        // yaku, since that yaku's own reveal already played a
        // cue and the flip is synced to it (per spec).
        if (stageReveal && uraRevealed && !this.winPageUraRevealSoundPlayed) {
          if (!pageHasUraYaku) {
            playGameSound("yaku-reveal");
          }
          this.winPageUraRevealSoundPlayed = true;
        }
        // Keep frames flowing while the reveal sequence has
        // outstanding steps. Without this the next paint would
        // only happen on the next store update (which may not
        // arrive for several seconds during quiet phases), and
        // the yaku list would never appear to animate.
        if (stageReveal && !uraRevealed) {
          this.requestRender();
        }
      } else if (stageReveal && pageRevealedYakuCount < pageVisibleYakuTotal) {
        // No ura indicators (no riichi) but yaku list is still
        // mid-reveal — keep painting.
        this.requestRender();
      }
    } else if (r.buuChombo) {
      // Buu Mahjong chombo: the engine emits a `buu_chombo`
      // event right before this abort `hand_end`, and the
      // store/replay layer threads it through onto
      // `lastHandResult.buuChombo` so we can render a clear
      // reason instead of "Abort: unknown". This branch also
      // runs while the result is still in its transient
      // `reason: "ron" | "tsumo"` shape (chombo-by-winning
      // flow — the win event arrives first, the chombo
      // event swaps the panel over before the eventual abort
      // `hand_end` finalises `reason` to `"abort"`).
      const reasonLabel =
        r.buuChombo.reason === "sinking_win_not_floating"
          ? this.resultLabels.chomboReasons.sinkingWinNotFloating
          : r.buuChombo.reason === "game_ending_win_not_first"
            ? this.resultLabels.chomboReasons.gameEndingWinNotFirst
            : this.resultLabels.chomboReasons.gameEndingChinmai;
      rows.push({
        kind: "title",
        text: this.resultLabels.chomboTitle.replace("{reason}", reasonLabel),
        size: 28,
      });
      // Per-seat chip totals + this-chombo delta. Seats are
      // already in renderer-relative order (seat 0 = focus at
      // bottom) because `rotateMatchView` permuted the
      // `buuChombo.chips` / `chipDelta` arrays.
      const chipDelta = r.buuChombo.chipDelta;
      const chips = r.buuChombo.chips;
      for (let s = 0; s < 4; s++) {
        const name = seatNames?.[s] || `Player ${s + 1}`;
        const total = chips[s];
        const delta = chipDelta[s];
        const sign = delta > 0 ? "+" : "";
        const color = delta < 0 ? 0xff6b6b : delta > 0 ? 0x86efac : 0xcbd5e1;
        rows.push({
          kind: "label",
          text: `${name}: ${total} (${sign}${delta})`,
          size: 20,
          color,
        });
      }
    } else if (r.reason === "exhaustive_draw") {
      rows.push({
        kind: "title",
        text: this.resultLabels.exhaustiveDraw,
        size: 32,
      });
      // Tenpai hands are revealed at the seat positions (see
      // `renderSeat` — it picks up `r.tenpaiHands[seat]` and
      // replaces the seat's hand strip with it), so reviewers
      // see each tenpai hand where the player's tiles usually
      // sit. We intentionally omit them from this center panel
      // to avoid duplicating the information.
    } else if (r.reason === "abort") {
      const kindLabel =
        r.abortKind === "kyuushuu"
          ? this.resultLabels.abortKinds.kyuushuu
          : r.abortKind === "suufon_renda"
            ? this.resultLabels.abortKinds.suufonRenda
            : r.abortKind === "suucha_riichi"
              ? this.resultLabels.abortKinds.suuchaRiichi
              : r.abortKind === "sanchahou"
                ? this.resultLabels.abortKinds.sanchahou
                : this.resultLabels.abortKinds.unknown;
      rows.push({
        kind: "title",
        text: this.resultLabels.abortTitle.replace("{kind}", kindLabel),
        size: 28,
      });
    }

    // Measure / layout. Yaku rows share a fixed two-column width
    // (name left-aligned, value right-aligned). Other rows are
    // centered.
    const yakuFont = 22;
    const colGap = 36;
    const lineSpacing = 6;
    const yakuRowH = yakuFont + 4;
    const labelGapBefore = 14;

    // Pre-build all text nodes so we can measure widest column.
    type Built =
      | {
          kind: "yaku";
          name: Text;
          value: Text;
          h: number;
        }
      | {
          kind: "yaku2";
          leftName: Text;
          leftValue: Text;
          rightName: Text | null;
          rightValue: Text | null;
          h: number;
        }
      | { kind: "single"; text: Text; h: number }
      | {
          kind: "scoreRow";
          hanText: Text;
          ptsText: Text | null;
          w: number;
          h: number;
        }
      | { kind: "tiles"; container: Container; w: number; h: number }
      | { kind: "hand"; container: Container; w: number; h: number }
      | { kind: "divider"; h: number };
    const built: Built[] = [];
    let maxYakuName = 0;
    let maxYakuValue = 0;
    let maxSingle = 0;
    let maxTilesW = 0;
    const scoreRowInnerGap = 24;
    for (const row of rows) {
      if (row.kind === "yaku") {
        const name = new Text({
          text: row.name,
          style: new TextStyle({
            fontFamily: "Inter, system-ui, sans-serif",
            fontSize: yakuFont,
            fontWeight: "500",
            fill: 0xffffff,
          }),
        });
        const value = new Text({
          text: row.value,
          style: new TextStyle({
            fontFamily: "Inter, system-ui, sans-serif",
            fontSize: yakuFont,
            fontWeight: "600",
            fill: 0xffffff,
          }),
        });
        maxYakuName = Math.max(maxYakuName, name.width);
        maxYakuValue = Math.max(maxYakuValue, value.width);
        // Hide not-yet-revealed yaku — text width was already
        // measured into the column-width maxes above so the
        // panel reserves its final size from frame one.
        if (row.hidden) {
          name.visible = false;
          value.visible = false;
        }
        built.push({ kind: "yaku", name, value, h: yakuRowH });
      } else if (row.kind === "yaku2") {
        // Two-column yaku row: left and right pairs share the
        // same per-column name/value widths (tracked via
        // `maxYakuName`/`maxYakuValue` across both columns) so
        // every yaku line in the panel aligns.
        const makeText = (text: string, weight: "500" | "600"): Text =>
          new Text({
            text,
            style: new TextStyle({
              fontFamily: "Inter, system-ui, sans-serif",
              fontSize: yakuFont,
              fontWeight: weight,
              fill: 0xffffff,
            }),
          });
        const leftName = makeText(row.left.name, "500");
        const leftValue = makeText(row.left.value, "600");
        const rightName = row.right ? makeText(row.right.name, "500") : null;
        const rightValue = row.right ? makeText(row.right.value, "600") : null;
        maxYakuName = Math.max(
          maxYakuName,
          leftName.width,
          rightName?.width ?? 0
        );
        maxYakuValue = Math.max(
          maxYakuValue,
          leftValue.width,
          rightValue?.width ?? 0
        );
        // Same per-text visibility trick as the 1-column branch:
        // measure widths from the real yaku text but hide the
        // entries that haven't reached their reveal step yet.
        if (row.leftHidden) {
          leftName.visible = false;
          leftValue.visible = false;
        }
        if (row.rightHidden && rightName && rightValue) {
          rightName.visible = false;
          rightValue.visible = false;
        }
        built.push({
          kind: "yaku2",
          leftName,
          leftValue,
          rightName,
          rightValue,
          h: yakuRowH,
        });
      } else if (row.kind === "tiles") {
        // Build a horizontal strip of seat-0 (upright) tiles.
        // `null` slots render as face-down backs (used for
        // unrevealed dora indicator slots).
        const tileContainer = new Container();
        const mt = meldTileDims(this.tileDesign, 0);
        let dx = 0;
        for (const tile of row.tiles) {
          const { node: sprite } = this.drawMeldTile(tile, 0);
          sprite.position.set(dx, 0);
          tileContainer.addChild(sprite);
          dx += mt.w;
        }
        const w = row.tiles.length * mt.w;
        const h = mt.h;
        maxTilesW = Math.max(maxTilesW, w);
        built.push({ kind: "tiles", container: tileContainer, w, h });
      } else if (row.kind === "hand") {
        // Winner's hand strip: concealed tiles, then a small
        // gap, then the agari tile (if known and present in the
        // concealed list), then declared melds (each meld
        // rendered via `drawMeld` so the tilted called tile
        // matches the seat-relative orientation it had at the
        // table).
        const handContainer = new Container();
        const mt = meldTileDims(this.tileDesign, 0);
        const agariGap = 14;
        const meldGap = 18;
        let dx = 0;
        for (const tile of row.concealed) {
          const { node: sprite } = this.drawMeldTile(tile, 0);
          sprite.position.set(dx, 0);
          handContainer.addChild(sprite);
          dx += mt.w;
        }
        if (row.winTile) {
          dx += agariGap;
          const { node: sprite } = this.drawMeldTile(row.winTile, 0);
          sprite.position.set(dx, 0);
          handContainer.addChild(sprite);
          dx += mt.w;
        }
        if (row.melds && row.melds.length > 0) {
          for (const meld of row.melds) {
            dx += meldGap;
            const { node, width } = this.drawMeld(meld, 0);
            node.position.set(dx, 0);
            handContainer.addChild(node);
            dx += width;
          }
        }
        const w = dx;
        const h = mt.h;
        maxTilesW = Math.max(maxTilesW, w);
        built.push({ kind: "hand", container: handContainer, w, h });
      } else if (row.kind === "divider") {
        built.push({ kind: "divider", h: 12 });
      } else if (row.kind === "scoreRow") {
        // Two-cell row: han/fu on the left, total pts on the
        // right, with a fixed inter-cell gap. Drawn larger than
        // body text since it's the visual focal point.
        const hanText = new Text({
          text: row.han,
          style: new TextStyle({
            fontFamily: "Inter, system-ui, sans-serif",
            fontSize: 30,
            fontWeight: "700",
            fill: 0xffffff,
          }),
        });
        const ptsText = row.pts
          ? new Text({
              text: row.pts,
              style: new TextStyle({
                fontFamily: "Inter, system-ui, sans-serif",
                fontSize: 30,
                fontWeight: "700",
                fill: row.ptsColor ?? 0xfde68a,
              }),
            })
          : null;
        const w = ptsText
          ? hanText.width + scoreRowInnerGap + ptsText.width
          : hanText.width;
        const h = Math.max(hanText.height, ptsText?.height ?? 0) + 8;
        maxSingle = Math.max(maxSingle, w);
        built.push({ kind: "scoreRow", hanText, ptsText, w, h });
      } else {
        const t = new Text({
          text: row.text,
          style: new TextStyle({
            fontFamily: "Inter, system-ui, sans-serif",
            fontSize: row.size,
            fontWeight: row.kind === "title" ? "700" : "600",
            fill: (row.kind === "label" ? row.color : undefined) ?? 0xffffff,
          }),
        });
        maxSingle = Math.max(maxSingle, t.width);
        built.push({ kind: "single", text: t, h: row.size + 8 });
      }
    }

    const yakuColW = maxYakuName + colGap + maxYakuValue;
    // Gap between the two yaku columns when the panel switches
    // to the 2-column layout (>4 yaku). Wider than `colGap` so
    // the visual split between the columns reads clearly.
    const yakuColumnGap = 48;
    const has2ColYaku = built.some((b) => b.kind === "yaku2");
    const yakuBlockW = has2ColYaku ? yakuColW * 2 + yakuColumnGap : yakuColW;
    const contentW = Math.max(yakuBlockW, maxSingle, maxTilesW);
    // Total height = sum of row heights + spacing.
    let totalH = 0;
    let prevKind:
      | "yaku"
      | "yaku2"
      | "single"
      | "scoreRow"
      | "tiles"
      | "hand"
      | "divider"
      | null = null;
    for (const b of built) {
      if (prevKind !== null) {
        totalH +=
          b.kind !== prevKind || (b.kind !== "yaku" && b.kind !== "yaku2")
            ? labelGapBefore
            : lineSpacing;
      }
      totalH += b.h;
      prevKind = b.kind;
    }

    const padX = 36;
    const padY = 24;
    const panelW = contentW + padX * 2;
    const panelH = totalH + padY * 2;
    const bg = new Graphics()
      .roundRect(0, 0, panelW, panelH, 16)
      .fill({ color: 0x000000, alpha: 0.85 })
      .stroke({ color: 0xffffff, width: 1, alpha: 0.25 });
    container.addChild(bg);

    let y = padY;
    prevKind = null;
    // Y center (within the panel) of the `scoreRow` if present.
    // Used to anchor the entire panel so that this row sits at
    // the same vertical level as the side score boxes (which the
    // result overlay places at `cy = inner-center-y`). For
    // non-win results (exhaustive draw / abort) there is no
    // `scoreRow` and we fall back to centering the panel.
    let scoreRowCenterY: number | null = null;
    for (const b of built) {
      if (prevKind !== null) {
        y +=
          b.kind !== prevKind || (b.kind !== "yaku" && b.kind !== "yaku2")
            ? labelGapBefore
            : lineSpacing;
      }
      if (b.kind === "yaku") {
        const colLeft = (panelW - yakuColW) / 2;
        b.name.position.set(colLeft, y);
        b.value.position.set(colLeft + yakuColW - b.value.width, y);
        container.addChild(b.name, b.value);
      } else if (b.kind === "yaku2") {
        // Two equal-width columns centered as a block.
        const blockLeft = (panelW - yakuBlockW) / 2;
        const rightColLeft = blockLeft + yakuColW + yakuColumnGap;
        b.leftName.position.set(blockLeft, y);
        b.leftValue.position.set(blockLeft + yakuColW - b.leftValue.width, y);
        container.addChild(b.leftName, b.leftValue);
        if (b.rightName && b.rightValue) {
          b.rightName.position.set(rightColLeft, y);
          b.rightValue.position.set(
            rightColLeft + yakuColW - b.rightValue.width,
            y
          );
          container.addChild(b.rightName, b.rightValue);
        }
      } else if (b.kind === "tiles" || b.kind === "hand") {
        b.container.position.set((panelW - b.w) / 2, y);
        container.addChild(b.container);
      } else if (b.kind === "scoreRow") {
        const rowLeft = (panelW - b.w) / 2;
        b.hanText.position.set(rowLeft, y);
        container.addChild(b.hanText);
        if (b.ptsText) {
          b.ptsText.position.set(
            rowLeft + b.hanText.width + scoreRowInnerGap,
            y
          );
          container.addChild(b.ptsText);
        }
        scoreRowCenterY = y + b.h / 2;
      } else if (b.kind === "divider") {
        const line = new Graphics()
          .moveTo(padX, y + b.h / 2)
          .lineTo(panelW - padX, y + b.h / 2)
          .stroke({ color: 0xffffff, width: 1, alpha: 0.25 });
        container.addChild(line);
      } else {
        b.text.position.set((panelW - b.text.width) / 2, y);
        container.addChild(b.text);
      }
      y += b.h;
      prevKind = b.kind;
    }
    // Anchor the panel: if a `scoreRow` was rendered, shift the
    // panel so that row's center sits at `cy` (the inner center
    // y, which is also the side score boxes' center). Otherwise
    // (exhaustive draw / abort: just a single title row) center
    // the panel on `cy` so the title aligns with the side score
    // boxes as well.
    const panelY =
      scoreRowCenterY !== null ? cy - scoreRowCenterY : cy - panelH / 2;
    container.position.set(cx - panelW / 2, panelY);
    parent.addChild(container);

    // For multi-winner results, make the panel clickable so the
    // user can cycle through one winner per page. Backdrop +
    // bg already cover the panel area; we attach the handler to
    // the bg (panel-shaped) so clicks outside the panel still
    // fall through to anything underneath. Auto-cycles back to
    // page 0 after the last winner.
    if (r.wins && r.wins.length > 1) {
      bg.eventMode = "static";
      bg.cursor = "pointer";
      bg.on("pointerdown", (event) => {
        // Right-clicks are reserved for the global pass /
        // tsumogiri shortcut wired in `mount()`.
        if (event.button === 2) {
          return;
        }
        const total = r.wins?.length ?? 0;
        if (total <= 1) {
          return;
        }
        this.currentWinPage = (this.currentWinPage + 1) % total;
        // Restart the staged reveal sequence for the new page,
        // matching the spec ("each page replays the reveal").
        this.winPageRevealStartedAt = null;
        if (this.lastView) {
          this.render(this.lastView);
        }
      });
    }
  }

  /**
   * Small honba / riichi-sticks pill in the upper-left of the
   * result overlay.
   */
  private renderResultStickInfo(
    r: NonNullable<MatchView["lastHandResult"]>,
    inner: Rect,
    parent: Container
  ): void {
    if (!this.root) {
      return;
    }
    const honba = r.honba ?? 0;
    const sticks = r.riichiSticks ?? 0;
    if (honba === 0 && sticks === 0) {
      return;
    }
    const lines: string[] = [];
    if (honba > 0) {
      lines.push(`${honba} honba`);
    }
    if (sticks > 0) {
      lines.push(`${sticks} riichi stick${sticks === 1 ? "" : "s"}`);
    }
    const fontSize = 18;
    const container = new Container();
    const texts = lines.map(
      (l) =>
        new Text({
          text: l,
          style: new TextStyle({
            fontFamily: "Inter, system-ui, sans-serif",
            fontSize,
            fontWeight: "500",
            fill: 0xffffff,
          }),
        })
    );
    const padX = 12;
    const padY = 8;
    const lineGap = 4;
    const w = Math.max(...texts.map((t) => t.width)) + padX * 2;
    const h = texts.length * fontSize + (texts.length - 1) * lineGap + padY * 2;
    const bg = new Graphics()
      .roundRect(0, 0, w, h, 8)
      .fill({ color: 0x000000, alpha: 0.7 })
      .stroke({ color: 0xffffff, width: 1, alpha: 0.2 });
    container.addChild(bg);
    texts.forEach((t, i) => {
      t.position.set(padX, padY + i * (fontSize + lineGap));
      container.addChild(t);
    });
    container.position.set(inner.x + 12, inner.y + 12);
    parent.addChild(container);
  }

  /**
   * Per-seat score boxes positioned around the table, showing the
   * pre-delta score and a signed delta. Shown for any result that
   * carries `delta`.
   */
  private renderResultScoreBoxes(
    view: MatchView,
    r: NonNullable<MatchView["lastHandResult"]>,
    inner: Rect,
    parent: Container
  ): void {
    if (!this.root || !r.delta) {
      return;
    }
    // Anchor boxes flush against the four inner edges (the inner
    // edge of each hand band), centered along that edge.
    const margin = 16;
    const cxInner = inner.x + inner.w / 2;
    const cyInner = inner.y + inner.h / 2;
    const positions: Array<{
      x: number;
      y: number;
      anchor: "n" | "e" | "s" | "w";
    }> = [
      // seat 0 (bottom): flush against inner bottom edge
      { x: cxInner, y: inner.y + inner.h - margin, anchor: "s" },
      // seat 1 (right): flush against inner right edge
      { x: inner.x + inner.w - margin, y: cyInner, anchor: "e" },
      // seat 2 (top): flush against inner top edge
      { x: cxInner, y: inner.y + margin, anchor: "n" },
      // seat 3 (left): flush against inner left edge
      { x: inner.x + margin, y: cyInner, anchor: "w" },
    ];
    for (let seat = 0; seat < 4; seat++) {
      const pos = positions[seat];
      const name = view.seatNames?.[seat] || `Player ${seat + 1}`;
      const isDealer = view.dealer === seat;
      const delta = r.delta[seat] ?? 0;
      const before = (view.scores[seat] ?? 0) - delta;
      this.drawScoreBox(name, isDealer, before, delta, pos, parent);
    }
  }

  private drawScoreBox(
    name: string,
    isDealer: boolean,
    before: number,
    delta: number,
    pos: { x: number; y: number; anchor: "n" | "e" | "s" | "w" },
    parent: Container
  ): void {
    if (!this.root) {
      return;
    }
    const container = new Container();
    const nameStyle = new TextStyle({
      fontFamily: "Inter, system-ui, sans-serif",
      fontSize: 20,
      fontWeight: "700",
      fill: 0xffffff,
    });
    const nameText = new Text({
      text: name,
      style: nameStyle,
    });
    const dealerText = isDealer
      ? new Text({ text: "(dealer)", style: nameStyle })
      : null;
    const scoreText = new Text({
      text: `${before}`,
      style: new TextStyle({
        fontFamily: "Inter, system-ui, sans-serif",
        fontSize: 22,
        fontWeight: "600",
        fill: 0xffffff,
      }),
    });
    const showDelta = delta !== 0;
    const deltaColor = delta > 0 ? 0x4ade80 : 0xf87171;
    const deltaText = showDelta
      ? new Text({
          text: delta > 0 ? `+${delta}` : `${delta}`,
          style: new TextStyle({
            fontFamily: "Inter, system-ui, sans-serif",
            fontSize: 22,
            fontWeight: "700",
            fill: deltaColor,
          }),
        })
      : null;
    const padY = 14;
    const innerGap = 10;
    const rowContentW = deltaText
      ? scoreText.width + innerGap + deltaText.width
      : scoreText.width;
    const rowContentH = Math.max(scoreText.height, deltaText?.height ?? 0);
    const boxLayout = resultScoreBoxLayout(
      nameText.width,
      dealerText?.width ?? 0
    );
    const innerW = boxLayout.width;
    const innerH = boxLayout.height;
    nameText.scale.set(boxLayout.nameScale);
    const bg = new Graphics()
      .roundRect(0, 0, innerW, innerH, 10)
      .fill({ color: 0x000000, alpha: 0.85 })
      .stroke({ color: 0xffffff, width: 1, alpha: 0.3 });
    container.addChild(bg);
    const fittedNameWidth = nameText.width;
    const dealerGap = dealerText ? RESULT_SCORE_BOX_NAME_GAP : 0;
    const nameRowWidth = fittedNameWidth + dealerGap + (dealerText?.width ?? 0);
    const nameRowHeight = 24;
    const nameRowX = (innerW - nameRowWidth) / 2;
    nameText.position.set(
      nameRowX,
      padY + (nameRowHeight - nameText.height) / 2
    );
    container.addChild(nameText);
    if (dealerText) {
      dealerText.position.set(
        nameRowX + fittedNameWidth + dealerGap,
        padY + (nameRowHeight - dealerText.height) / 2
      );
      container.addChild(dealerText);
    }
    const rowY = innerH - padY - rowContentH;
    const rowX = (innerW - rowContentW) / 2;
    scoreText.position.set(rowX, rowY);
    container.addChild(scoreText);
    if (deltaText) {
      deltaText.position.set(rowX + scoreText.width + innerGap, rowY);
      container.addChild(deltaText);
    }

    // Anchor placement: pos.{x,y} is the side-midpoint; shift the
    // box inward so it sits flush against that side.
    let x = pos.x - innerW / 2;
    let y = pos.y - innerH / 2;
    if (pos.anchor === "s") {
      y = pos.y - innerH;
    } else if (pos.anchor === "n") {
      y = pos.y;
    } else if (pos.anchor === "w") {
      x = pos.x;
    } else if (pos.anchor === "e") {
      x = pos.x - innerW;
    }
    container.position.set(x, y);
    parent.addChild(container);
  }

  private renderMatchEnd(
    view: MatchView,
    cx: number,
    cy: number
  ): { x: number; y: number; w: number; h: number } | null {
    if (!this.root || !view.matchEnded) {
      return null;
    }
    const ordered = [...view.matchEnded.finalScores].sort(
      (a, b) => a.place - b.place
    );
    const seatNames = view.seatNames;
    const showChipDelta =
      view.buuMode === true &&
      Array.isArray(view.matchEnded.chipsDelta) &&
      view.matchEnded.chipsDelta.length === 4;
    const chipDelta = showChipDelta
      ? (view.matchEnded.chipsDelta as number[])
      : null;
    const rows = ordered.map((f) => ({
      place: f.place,
      name: seatNames?.[f.seat] ?? `Seat ${f.seat}`,
      score: f.score,
      chipDelta: chipDelta ? chipDelta[f.seat] : 0,
    }));

    const padX = 28;
    const padY = 20;
    const titleSize = 22;
    const rowSize = 16;
    const titleGap = 18; // space between title and divider
    const dividerGap = 14; // space between divider and first row
    const rowHeight = 24;

    const titleStyle = new TextStyle({
      fontFamily: "Inter, system-ui, sans-serif",
      fontSize: titleSize,
      fontWeight: "700",
      fill: 0xffffff,
    });
    const rowStyle = new TextStyle({
      fontFamily: "Inter, system-ui, sans-serif",
      fontSize: rowSize,
      fontWeight: "600",
      fill: 0xffffff,
    });

    const titleText = new Text({ text: "Match ended", style: titleStyle });

    // Build per-row text triples so we can right-align scores at a
    // common x within the panel.
    // Format a signed chip delta as "+N" / "−N" / "0". Uses
    // a real minus sign (U+2212) so the figure visually
    // matches the chip icon's plus/zero variants.
    const formatChipDelta = (n: number): string => {
      if (n > 0) {
        return `+${n}`;
      }
      if (n < 0) {
        return `\u2212${Math.abs(n)}`;
      }
      return "0";
    };

    const rowTexts = rows.map((r) => ({
      place: new Text({ text: `${r.place}.`, style: rowStyle }),
      name: new Text({ text: r.name, style: rowStyle }),
      score: new Text({ text: `${r.score}`, style: rowStyle }),
      chipDeltaText: showChipDelta
        ? new Text({
            text: formatChipDelta(r.chipDelta),
            style: new TextStyle({
              fontFamily: "Inter, system-ui, sans-serif",
              fontSize: rowSize,
              fontWeight: "700",
              fill:
                r.chipDelta > 0
                  ? 0x86efac
                  : r.chipDelta < 0
                    ? 0xfca5a5
                    : 0xe5e7eb,
            }),
          })
        : null,
    }));

    const placeColW = Math.max(...rowTexts.map((r) => r.place.width));
    const nameColW = Math.max(...rowTexts.map((r) => r.name.width));
    const scoreColW = Math.max(...rowTexts.map((r) => r.score.width));
    const placeGap = 8; // space between place number and name
    const scoreGap = 28; // space between name column and scores
    // Chip-delta column (Buu only): chip icon + signed number.
    const chipIconR = 9;
    const chipIconGap = 5;
    const chipDeltaGap = 24; // space between score and chip-delta cols
    const chipDeltaTextW = showChipDelta
      ? Math.max(
          ...rowTexts.map((r) =>
            r.chipDeltaText ? Math.ceil(r.chipDeltaText.width) : 0
          )
        )
      : 0;
    const chipDeltaColW = showChipDelta
      ? chipIconR * 2 + chipIconGap + chipDeltaTextW
      : 0;
    const contentW =
      placeColW +
      placeGap +
      nameColW +
      scoreGap +
      scoreColW +
      (showChipDelta ? chipDeltaGap + chipDeltaColW : 0);

    const innerW = Math.max(280, titleText.width, contentW);
    const w = innerW + padX * 2;
    const h =
      padY +
      titleText.height +
      titleGap +
      1 + // divider
      dividerGap +
      rowTexts.length * rowHeight +
      padY;

    const panel = new Container();
    const bg = new Graphics()
      .roundRect(0, 0, w, h, 12)
      .fill({ color: 0x000000, alpha: 0.85 });
    panel.addChild(bg);

    // Title — centred horizontally.
    titleText.position.set((w - titleText.width) / 2, padY);
    panel.addChild(titleText);

    // Divider line below the title.
    const dividerY = padY + titleText.height + titleGap;
    const divider = new Graphics()
      .moveTo(padX, dividerY)
      .lineTo(w - padX, dividerY)
      .stroke({ color: 0xffffff, width: 1, alpha: 0.35 });
    panel.addChild(divider);

    // Standings rows.
    const rowsX = (w - contentW) / 2;
    const rowsStartY = dividerY + dividerGap;
    rowTexts.forEach((r, i) => {
      const y = rowsStartY + i * rowHeight;
      r.place.position.set(rowsX, y);
      r.name.position.set(rowsX + placeColW + placeGap, y);
      const scoreRightX =
        rowsX + placeColW + placeGap + nameColW + scoreGap + scoreColW;
      r.score.position.set(scoreRightX - r.score.width, y);
      panel.addChild(r.place, r.name, r.score);

      // Chip-delta column (Buu only): chip icon + signed delta.
      if (showChipDelta && r.chipDeltaText) {
        const colLeftX = scoreRightX + chipDeltaGap;
        const rowCY = y + rowHeight / 2 - 4; // visual centre of the text line
        let icon: Container;
        if (this.chipIconTex) {
          const sprite = new Sprite(this.chipIconTex);
          sprite.anchor.set(0.5, 0.5);
          sprite.width = chipIconR * 2;
          sprite.height = chipIconR * 2;
          icon = sprite;
        } else {
          icon = new Graphics()
            .circle(0, 0, chipIconR)
            .fill({ color: 0xfacc15 })
            .stroke({ color: 0xffffff, width: 1, alpha: 0.9 });
        }
        icon.position.set(colLeftX + chipIconR, rowCY);
        panel.addChild(icon);
        r.chipDeltaText.position.set(colLeftX + chipIconR * 2 + chipIconGap, y);
        panel.addChild(r.chipDeltaText);
      }
    });

    panel.position.set(cx - w / 2, cy - h / 2);
    this.root.addChild(panel);
    return { x: cx - w / 2, y: cy - h / 2, w, h };
  }

  private drawCenterPanel(
    lines: string[],
    cx: number,
    cy: number,
    _footer?: string
  ): void {
    if (!this.root) {
      return;
    }
    const lineHeight = 22;
    const padX = 24;
    const padY = 16;
    const style = new TextStyle({
      fontFamily: "Inter, system-ui, sans-serif",
      fontSize: 16,
      fontWeight: "600",
      fill: 0xffffff,
    });
    const texts = lines.map((l) => new Text({ text: l, style }));
    const w = Math.max(280, ...texts.map((t) => t.width)) + padX * 2;
    const h = texts.length * lineHeight + padY * 2;
    const panel = new Container();
    const bg = new Graphics()
      .roundRect(0, 0, w, h, 12)
      .fill({ color: 0x000000, alpha: 0.85 });
    panel.addChild(bg);
    texts.forEach((t, i) => {
      t.position.set(padX, padY + i * lineHeight);
      panel.addChild(t);
    });
    panel.position.set(cx - w / 2, cy - h / 2);
    this.root.addChild(panel);
  }

  // -------------------------------------------------------------------------
  // Layout debug overlay (step 1 of the Tenhou-style migration)
  // -------------------------------------------------------------------------

  /**
   * Paint the colored layout regions on top of the table. Used
   * while the per-region rendering is being migrated; this is the
   * visual ground truth for where each region will live once the
   * migration completes. Toggled via {@link setShowLayoutDebug}.
   *
   * Colors match the user's mock:
   *   - center: pink
   *   - discards: blue
   *   - playerInfo: orange
   *   - wall: yellow
   *   - hands: green
   */
  private renderLayoutDebug(layout: TableLayout): void {
    if (!this.root) {
      return;
    }
    const fill = (rect: Rect, color: number, alpha = 0.75): Graphics => {
      const g = new Graphics();
      g.rect(rect.x, rect.y, rect.w, rect.h).fill({ color, alpha });
      return g;
    };
    const root = this.root;
    // Paint outer regions first so inner ones sit on top.
    layout.hands.forEach((r) => {
      root.addChild(fill(r, 0x16a34a));
    });
    layout.wall.forEach((r) => {
      root.addChild(fill(r, 0xeab308));
    });
    layout.playerInfo.forEach((r) => {
      root.addChild(fill(r, 0xf97316));
    });
    layout.discards.forEach((r) => {
      root.addChild(fill(r, 0x2563eb));
    });
    root.addChild(fill(layout.center, 0xa855f7));
  }

  /** Paint only the wall-zone rectangles above the rendered table. */
  private renderWallZonesDebug(layout: TableLayout): void {
    if (!this.root) {
      return;
    }
    for (const rect of layout.wall) {
      const zone = new Graphics()
        .rect(rect.x, rect.y, rect.w, rect.h)
        .fill({ color: 0xeab308, alpha: 0.35 });
      zone.zIndex = 900;
      this.root.addChild(zone);
    }
  }

  // -------------------------------------------------------------------------
  // Drawing primitives
  // -------------------------------------------------------------------------

  private renderSeat(
    view: MatchView,
    seat: number,
    cx: number,
    cy: number,
    layout: TableLayout
  ): void {
    if (!this.root) {
      return;
    }
    const factory = this.spriteFactory;
    if (!factory) {
      return;
    }
    const presentation = resolveSeatHandPresentation(
      view,
      this.handResultOverride,
      seat as Seat
    );
    const rawHand = presentation.animationHand;
    const forceReveal = presentation.animationForceReveal;
    const discards = view.discards[seat] ?? [];

    const isYou = view.mySeat === seat;
    // Display-only sort applied to every seat (m → p → s → z, then
    // ascending number; red five (`0X`) sorts as 5). For opponents
    // whose tiles are unknown the array is all `null` and
    // `sortHand` short-circuits to a no-op; once `showHands`
    // reveals an opponent's hand the entries become real tile
    // strings and the same ordering kicks in so revealed hands
    // read in the same canonical order as the focused player's.
    //
    // When the player has just drawn a 14th tile, keep the drawn tile
    // (always the last element pushed by the store on `draw`) visually
    // separated on the right of the sorted 13-tile hand. After the
    // discard event lands, the next render sees a 13-tile hand and
    // re-sorts the whole row.
    //
    // Hand length alone is ambiguous (e.g. after a chi/pon the closed
    // hand is also length 11 == 2 mod 3 even though no tile was drawn),
    // so the reducer tags the seat that holds a freshly drawn tile in
    // `view.freshlyDrawnSeat`. Drives both the sort split and the
    // tsumo-gap rendering below.
    const isFreshlyDrawnNatural = presentation.animationSeparatesLastTile;
    const handNatural = sortHand(rawHand, isFreshlyDrawnNatural);
    // -----------------------------------------------------------------
    // Discard animation: record this seat's natural (post-sort,
    // pre-override) layout so the animator's next-frame diff has
    // the exact pre-discard layout to source from; then, if a
    // phase-A slide is currently in flight for this seat, override
    // the rendered hand with the captured pre-discard snapshot so
    // the painter draws the strip with one slot blanked out. The
    // hidden-slot index is consumed below to skip that hand-tile
    // sprite without disturbing the rest of the strip's geometry.
    //
    // `isConcealed` mirrors the visibility logic in the painting
    // branches below: a hand is concealed unless this is the
    // focused seat, the renderer-wide `showHands` toggle is on,
    // or a win/tenpai override forced the hand face-up
    // (`forceReveal`). Concealed-hand discards source their
    // animation from a fixed middle slot for tedashi / the
    // rightmost slot for tsumogiri.
    // -----------------------------------------------------------------
    const naturalIsConcealed = !isYou && !forceReveal && !this.showHands;
    // -----------------------------------------------------------------
    // Focused-hand custom sort: compute the seat-0 display order
    // BEFORE handing the layout to the discard animator, so the
    // snapshot it captures (and replays through phases A/B on
    // the next discard) reflects exactly what the player was
    // seeing — i.e. their custom order, not the natural sort.
    // Without this the hand would briefly snap back to sorted
    // for one frame at the moment of discard.
    //
    // Only seat 0 honours `HandSorter`; opponents always paint
    // in the natural sort. `rawIndices[displaySlot] =
    // rawHandIndex` lets each per-tile sprite ask the sorter
    // for its smoothly-eased x position; `null` falls back to
    // static slot x.
    // -----------------------------------------------------------------
    let rawIndices: number[] | null = null;
    let seat0Display: { rawIndices: number[]; freshGap: boolean } | null = null;
    if (seat === 0 && !forceReveal) {
      const naturalIndices = naturalOrderRawIndices(
        rawHand,
        isFreshlyDrawnNatural,
        tileSortKey
      );
      // If a drag is mid-flight, decide before paint whether a
      // swap should fire this frame (so the swapped layout is
      // what we actually paint, not the pre-swap one). We use
      // the *current* display order's slot centers since those
      // are what the cursor is being compared against.
      if (this.handSorter.isDragging() && !this.handSorter.isSortFlagOn()) {
        const beforeDisplay = this.handSorter.getDisplayOrder(
          rawHand,
          isFreshlyDrawnNatural,
          naturalIndices
        );
        const t0 = layout.tileSelf;
        const handGap0 = beforeDisplay.freshGap ? TSUMO_GAP : 0;
        const slotCenters = beforeDisplay.rawIndices.map((_, idx) => {
          const last = idx === beforeDisplay.rawIndices.length - 1;
          const extra = handGap0 > 0 && last ? handGap0 : 0;
          return idx * (t0.w + t0.gap) + extra + BIG_TILE_W / 2;
        });
        this.handSorter.maybeSwap(slotCenters);
      }
      seat0Display = this.handSorter.getDisplayOrder(
        rawHand,
        isFreshlyDrawnNatural,
        naturalIndices
      );
    }
    // The "base" layout: what we'd render absent any discard
    // animation. For seat 0 with sortFlag off, this is the
    // player's custom order. The animator gets this so the
    // captured snapshot is in the user's chosen layout.
    let baseHand: Array<string | null> = handNatural;
    let baseFreshlyDrawn = isFreshlyDrawnNatural;
    if (
      seat === 0 &&
      !forceReveal &&
      seat0Display &&
      !this.handSorter.isSortFlagOn()
    ) {
      baseHand = seat0Display.rawIndices.map((idx) => rawHand[idx] ?? null);
      baseFreshlyDrawn = seat0Display.freshGap;
    }
    this.animator.recordHandLayout(seat, {
      sorted: baseHand,
      isFreshlyDrawn: baseFreshlyDrawn,
      isConcealed: naturalIsConcealed,
    });
    const seatDiscardAnim = this.animator.getAnim(seat);
    let hand: Array<string | null> = baseHand;
    let isFreshlyDrawn = baseFreshlyDrawn;
    let hiddenHandSlot: number | null = null;
    if (seat === 0 && !forceReveal && seat0Display) {
      rawIndices = seat0Display.rawIndices;
    }
    // Apply the phase-A hand snapshot through BOTH phases. While
    // phase A is parked (waiting for the next draw) and through
    // phase B's slide, we keep the same gap-in-the-hand layout
    // so the strip only "closes up" once the animation is fully
    // dropped after phase B elapses. This matches the user-
    // visible spec: the discarder's hand stays gapped while a
    // call window is open, and only resorts after the next draw.
    //
    // For seat 0 we also clear `rawIndices` while the snapshot
    // is in effect: the snapshot is captured one frame before
    // rawHand mutates, so its slot indices no longer align with
    // the post-discard `rawHand` the sorter is tracking. Static
    // slot positions (no easing) are correct here — the snapshot
    // *is* the pre-discard layout we want frozen on screen.
    if (seatDiscardAnim && seatDiscardAnim.phaseASnapshot) {
      hand = seatDiscardAnim.phaseASnapshot.hand;
      isFreshlyDrawn = seatDiscardAnim.phaseASnapshot.isFreshlyDrawn;
      hiddenHandSlot = seatDiscardAnim.phaseASnapshot.hiddenSlot;
      rawIndices = null;
    }
    if (presentation.historicalReveal) {
      hand = sortHand(
        presentation.displayHand,
        presentation.displaySeparatesLastTile
      );
      isFreshlyDrawn = presentation.displaySeparatesLastTile;
      hiddenHandSlot = null;
      rawIndices = null;
    }
    const displayForceReveal = presentation.displayForceReveal;
    const handContainer = new Container();
    // Side hands (seats 1 / 3, never the focused user) use a
    // dedicated tile size (`layout.tileSide`) and stack the tiles
    // with overlap along the hand's long axis. The lower tile in
    // screen space sits on top of the higher one (Tenhou
    // convention).
    const isSideHand = !isYou && seat % 2 === 1;

    // Draw-in slide: while the freshly drawn tile arrives, render the
    // real tsumo tile invisible and slide a face-down back into its
    // slot (below). `isFreshlyDrawn` guarantees the reserved last-slot
    // gap the back slides into. In sequenced (live-relay) mode the
    // draw is held pending behind the previous discard: the tile stays
    // hidden (`hideTsumoTile`) before the back actually slides
    // (`isDrawing`), so nothing pops in during the hold.
    const isDrawing =
      view.freshlyDrawnSeat === seat &&
      isFreshlyDrawn &&
      this.animator.isDrawing(seat);
    const hideTsumoTile =
      view.freshlyDrawnSeat === seat &&
      isFreshlyDrawn &&
      this.animator.isDrawTileHidden(seat);
    const drawProgress = isDrawing ? this.animator.getDrawProgress(seat) : 1;
    // Wall-side offset (design px) the back travels along the hand's
    // reading axis into the tsumo slot.
    const DRAW_SLIDE_PX = 44;

    // Hand metrics. For the bottom/top hand we keep the existing
    // 14-tile gap (tsumo separation). Side hands don't expose the
    // tsumo separately. Bottom hand uses `tileSelf`; top hand uses
    // `tileHorizontal`; side hands use `tileSide`.
    let handWidth: number;
    // For side hands, decide up-front whether this hand is being
    // rendered face-up (showHands + at least one known tile) so we
    // can pick a single tile metric for the whole strip — mixed
    // strides would space the tiles unevenly.
    //
    // Revealed side tiles use the same on-screen footprint as the
    // seat's discards (SIDE_TILE_W × SIDE_TILE_H, drawn from the
    // `rightSmall`/`leftSmall` discard sheets) so a flipped-up
    // opponent hand reads the same size as the row of tiles in
    // that seat's pond. The face-down `sideHandL/R` artwork keeps
    // the narrower `tileSide` dims because its source is portrait
    // and would stretch badly at discard dims.
    const sideHandRevealed =
      isSideHand &&
      (this.showHands || displayForceReveal) &&
      hand.some((t) => t !== null);
    if (isSideHand) {
      let stride: number;
      let endTileLong: number;
      if (sideHandRevealed) {
        // Discard-style metrics: along-strip dim = SIDE_TILE_H
        // (the short side of the landscape source artwork after
        // the per-seat container ±π/2 rotation). Use the same
        // along-row overlap as side discards for visual parity.
        stride = SIDE_TILE_H - DISCARD_ROW_OVERLAP_HORIZ;
        endTileLong = SIDE_TILE_H;
      } else {
        const ts = layout.tileSide;
        stride = ts.h - layout.tileSideOverlap;
        endTileLong = ts.h;
      }
      const handGap = isFreshlyDrawn ? TSUMO_GAP : 0;
      handWidth = (hand.length - 1) * stride + endTileLong + handGap;
    } else {
      const t = seat === 0 ? layout.tileSelf : layout.tileHorizontal;
      const handGap = isFreshlyDrawn ? TSUMO_GAP : 0;
      handWidth = hand.length * (t.w + t.gap) - t.gap + handGap;
    }

    const inRiichiMode = isYou && this.riichiMode;

    if (isSideHand) {
      // Side hands: face-down tile sprites at `layout.tileSide`
      // dims, stacked with `layout.tileSideOverlap` overlap along
      // local +x (the hand's reading axis). Z-order: the tile
      // lower on screen sits on top of the one above it.
      //
      // After the per-seat rotation applied to `handContainer`:
      //   - seat 1 (right): local +x → screen -y, so higher i is
      //     higher on screen → lower i should render on TOP
      //     (zIndex = -i).
      //   - seat 3 (left): local +x → screen +y, so higher i is
      //     lower on screen → higher i renders on top (zIndex = i).
      //
      // The sprite sheets `uprightSideHandL`/`R` are drawn upright
      // (tall) in source. We counter-rotate them in local space so
      // they appear upright on screen after the seat's container
      // rotation cancels out.
      handContainer.sortableChildren = true;
      const sidePlacements = layoutSideHand(
        this.tileDesign,
        seat as 1 | 3,
        hand,
        {
          canReveal: this.showHands || displayForceReveal,
          isFreshlyDrawn,
          hiddenSlot: hiddenHandSlot,
        }
      );
      const lastSidePlacement =
        sidePlacements[sidePlacements.length - 1] ?? null;
      for (const p of sidePlacements) {
        const sprite = factory.create({
          atlasId: p.atlasId,
          tile: p.tile,
          width: p.sprite.width,
          height: p.sprite.height,
          rotation: p.sprite.rotation,
        });
        sprite.position.set(p.sprite.x, p.sprite.y);
        // Wait-tint; a no-op for the `null` back tiles.
        this.tintIfWait(sprite, p.tile);
        // Hide the just-drawn tsumo tile while the draw-in back slides.
        if (hideTsumoTile && p === lastSidePlacement) {
          sprite.alpha = 0;
        }
        const wrap = new Container();
        wrap.addChild(sprite);
        wrap.position.set(p.wrap.x, p.wrap.y);
        wrap.zIndex = p.zIndex;
        handContainer.addChild(wrap);
      }
      if (isDrawing && lastSidePlacement) {
        const p = lastSidePlacement;
        // Face-up when the hand is revealed (`p.tile` set), else a
        // face-down back — matching the static strip. Slide it in at
        // the tsumo tile's natural z so it emerges from behind the
        // hand (seat 1) instead of on top of it.
        const slideTile = factory.create({
          atlasId: p.atlasId,
          tile: p.tile,
          width: p.sprite.width,
          height: p.sprite.height,
          rotation: p.sprite.rotation,
        });
        slideTile.position.set(p.sprite.x, p.sprite.y);
        const wrap = new Container();
        wrap.addChild(slideTile);
        wrap.zIndex = p.zIndex;
        wrap.position.set(
          p.wrap.x + DRAW_SLIDE_PX * (1 - drawProgress),
          p.wrap.y
        );
        handContainer.addChild(wrap);
      }
      {
        const rot = SEAT_CONTAINER_ROT[seat];
        const cos = Math.cos(rot);
        const sin = Math.sin(rot);
        const layer = this.screenShadowLayer(handContainer, rot);
        this.placeColumnShadows(
          layer,
          sidePlacements
            // Drawn tile's settled shadow is skipped while it's hidden /
            // sliding; the moving one is added just below.
            .filter((p) => !(hideTsumoTile && p === lastSidePlacement))
            .map((p) => {
              const lx = p.wrap.x + p.sprite.x;
              const ly = p.wrap.y + p.sprite.y;
              return {
                ax: lx * cos - ly * sin,
                ay: lx * sin + ly * cos,
                w: p.sprite.width,
                h: p.sprite.height,
              };
            })
        );
        if (isDrawing && lastSidePlacement) {
          const p = lastSidePlacement;
          const lx = p.wrap.x + DRAW_SLIDE_PX * (1 - drawProgress) + p.sprite.x;
          const ly = p.wrap.y + p.sprite.y;
          this.placeColumnShadows(layer, [
            {
              ax: lx * cos - ly * sin,
              ay: lx * sin + ly * cos,
              w: p.sprite.width,
              h: p.sprite.height,
            },
          ]);
        }
      }
    } else if (seat === 2) {
      // Top hand (opponent across): face-down `topSmall` backs
      // rotated 180°, or the face cell when revealed. No interaction.
      const topHand = this.tileDesign.metrics.topHand;
      const handGap = isFreshlyDrawn ? TSUMO_GAP : 0;
      handWidth = hand.length * topHand.w + handGap;
      const topPlacements = layoutTopHand(this.tileDesign, hand, {
        canReveal: this.showHands || displayForceReveal,
        isFreshlyDrawn,
        hiddenSlot: hiddenHandSlot,
      });
      handContainer.sortableChildren = true;
      const lastTopPlacement = topPlacements[topPlacements.length - 1] ?? null;
      for (const p of topPlacements) {
        const sprite = factory.create({
          atlasId: p.atlasId,
          tile: p.tile,
          width: p.sprite.width,
          height: p.sprite.height,
          rotation: p.sprite.rotation,
        });
        sprite.position.set(p.sprite.x, p.sprite.y);
        this.tintIfWait(sprite, p.tile);
        // Hide the just-drawn tsumo tile while the draw-in back slides.
        if (hideTsumoTile && p === lastTopPlacement) {
          sprite.alpha = 0;
        }
        const wrap = new Container();
        wrap.addChild(sprite);
        wrap.position.set(p.wrap.x, p.wrap.y);
        handContainer.addChild(wrap);
      }
      if (isDrawing && lastTopPlacement) {
        const p = lastTopPlacement;
        // Face-up when the hand is revealed (`p.tile` set), else a back.
        const slideTile = factory.create({
          atlasId: p.atlasId,
          tile: p.tile,
          width: p.sprite.width,
          height: p.sprite.height,
          rotation: p.sprite.rotation,
        });
        slideTile.position.set(p.sprite.x, p.sprite.y);
        const wrap = new Container();
        wrap.addChild(slideTile);
        wrap.position.set(
          p.wrap.x + DRAW_SLIDE_PX * (1 - drawProgress),
          p.wrap.y
        );
        handContainer.addChild(wrap);
      }
      {
        const rot = SEAT_CONTAINER_ROT[seat];
        const cos = Math.cos(rot);
        const sin = Math.sin(rot);
        const layer = this.screenShadowLayer(handContainer, rot);
        const eff = this.tileDesign.effects.shadow;
        if (eff) {
          const placeTopShadow = (p: TilePlacement, shift: number): void => {
            const lx = p.wrap.x + shift + p.sprite.x;
            const ly = p.wrap.y + p.sprite.y;
            const ax = lx * cos - ly * sin;
            const ay = lx * sin + ly * cos;
            // Face-down top tiles stand upright → dedicated upright
            // shadow, sprite preserved; revealed faces read flat.
            if (p.tile === null) {
              this.placeUprightShadow(
                layer,
                ax + p.sprite.width / 2,
                ay + p.sprite.height / 2,
                p.sprite.height,
                eff.uprightSmall
              );
            } else {
              this.placeBasicShadow(
                layer,
                ax + p.sprite.width / 2,
                ay,
                p.sprite.height,
                eff.small
              );
            }
          };
          for (const p of topPlacements) {
            // Drawn tile's settled shadow skipped while hidden / sliding.
            if (hideTsumoTile && p === lastTopPlacement) {
              continue;
            }
            placeTopShadow(p, 0);
          }
          if (isDrawing && lastTopPlacement) {
            placeTopShadow(
              lastTopPlacement,
              DRAW_SLIDE_PX * (1 - drawProgress)
            );
          }
        }
      }
    } else {
      // Bottom hand (seat 0, focused): BIG face-up tiles from the
      // `ownHand` sheet, positioned by the HandSorter and wired for
      // drag / click / hover below.
      const t = layout.tileSelf;
      const spriteW = BIG_TILE_W;
      const spriteH = BIG_TILE_H;
      const handGap = isFreshlyDrawn ? TSUMO_GAP : 0;
      handWidth = hand.length * (t.w + t.gap) - t.gap + handGap;
      const ownShadowSpec = this.tileDesign.effects.shadow;
      const ownShadowLayer = this.screenShadowLayer(handContainer, 0);
      hand.forEach((tile, i) => {
        // Phase-A: leave the discarded slot blank so the animated
        // discard sprite reads as having "come from" this slot.
        if (i === hiddenHandSlot) {
          return;
        }
        // Anchor top-left so hover tint reads directly off the sprite.
        const tileSprite = factory.create({
          atlasId: "ownHand",
          tile,
          width: spriteW,
          height: spriteH,
          anchor: 0,
        });
        this.tintIfWait(tileSprite, tile);
        const extraGap = handGap > 0 && i === hand.length - 1 ? handGap : 0;
        const slotX = i * (t.w + t.gap) + extraGap;
        // Seat 0: ask the HandSorter for the smoothly-eased x
        // (handles drag-to-reorder + post-swap slide). Seat 2:
        // static slot x — opponents don't get the sort feature.
        let posX = slotX;
        if (seat === 0 && rawIndices !== null) {
          posX = this.handSorter.getRenderX(rawIndices[i], slotX);
        }
        tileSprite.position.set(posX, 0);
        // Float the dragged tile above its neighbours so it
        // reads as being "picked up". `sortableChildren` is
        // turned on below the forEach when we know a drag is
        // active for this seat.
        if (
          seat === 0 &&
          rawIndices !== null &&
          this.handSorter.getDraggedRawIdx() === rawIndices[i]
        ) {
          tileSprite.zIndex = 1_000_000;
        }
        if (isYou && tile && canInteractWithFocusedHand(view)) {
          const localRawIdx = rawIndices !== null ? rawIndices[i] : i;
          const localDiscardSource = discardSourceForRawIndex(
            localRawIdx,
            rawHand.length,
            isFreshlyDrawnNatural
          );
          const riichiLegal = findTileAction(
            view.legalActions,
            "riichi",
            tile,
            localDiscardSource
          );
          // Darken tiles that aren't legal riichi discards without
          // making the tile artwork transparent.
          const riichiTint = riichiSelectionTileTint(
            inRiichiMode,
            riichiLegal !== undefined
          );
          if (riichiTint !== null) {
            tileSprite.tint = riichiTint;
          }
          tileSprite.eventMode = "static";
          tileSprite.cursor = "pointer";
          // Light-red hover highlight on the focused hand. Tint
          // applies only to Sprite children (seat 0's tileSprite
          // is a Sprite directly), and we capture the pre-hover
          // tint so wait-tinted tiles restore correctly on out.
          // No persistent style change on click — the optimistic
          // pending-discard tint that used to live here was
          // removed at the user's request.
          if ("tint" in tileSprite) {
            const tintable = tileSprite as unknown as { tint: number };
            const originalTint = tintable.tint;
            this.focusedHandHoverTargets.push({
              sprite: tileSprite as Sprite,
              originalTint,
            });
          }
          const localTile = tile;
          const localIndex = i;
          const localSlotX = slotX;
          const localSpriteW = spriteW;
          // Count how many copies of this tile sit to the LEFT
          // of the clicked slot in the *current* display order:
          // that's the ordinal we hand to the discard animator
          // so it can blank the actually-clicked slot (rather
          // than the leftmost copy) when the discard fires.
          let localOrd = 0;
          for (let k = 0; k < i; k++) {
            if (hand[k] === localTile) {
              localOrd++;
            }
          }
          tileSprite.on("pointerdown", (event) => {
            // Right-clicks are handled globally as
            // pass / tsumogiri (see `mount()`); never let a
            // right-click on a hand tile fire a discard.
            if (event.button === 2) {
              return;
            }
            // The hand is about to mutate. Clear both the tint and
            // cached pointer so a replacement tile under a
            // stationary cursor is not highlighted until the mouse
            // genuinely moves again.
            this.clearFocusedHandHover(true);
            // The click semantics (riichi-tile-select vs
            // discard) are captured into a thunk and stashed
            // for the window-level pointerup handler to fire
            // if the gesture stays under the drag-promotion
            // threshold. If it promotes to a drag, the thunk
            // is discarded and the sorter handles the drop.
            const fireClick = (): void => {
              if (inRiichiMode) {
                if (riichiLegal && this.onActionClick) {
                  this.riichiMode = false;
                  this.onActionClick({ action: riichiLegal });
                }
                return;
              }
              if (this.onTileClick) {
                // Tell the discard animator which copy of a
                // duplicate tile the player actually clicked,
                // so phase A blanks the correct slot.
                this.animator.setNextDiscardSourceHint(
                  seat,
                  localTile,
                  localOrd
                );
                this.onTileClick({
                  seat,
                  index: localIndex,
                  tile: localTile,
                  discardSource: localDiscardSource,
                });
              }
            };
            this.pendingHandClickCallback = fireClick;
            // Begin the drag-or-click gesture. Convert the
            // event's stage-coords global x into
            // handContainer-local x via Pixi's transform
            // walker — handContainer is already parented at
            // this point so the world transform is valid.
            const localPt = handContainer.toLocal({
              x: event.global.x,
              y: event.global.y,
            });
            this.handSorter.pointerDown({
              rawIdx: localRawIdx,
              pointerLocalX: localPt.x,
              tileLeftX: localSlotX,
              tileLongAxisLen: localSpriteW,
            });
          });
        }
        // Focused-hand drop shadow: a basic ownShadow on each tile's
        // right edge (below all tiles). Occlusion by the next tile is
        // intended, so only the rightmost tile's shadow shows. The
        // drawn tile's shadow rides with the sliding tile (added below).
        if (ownShadowSpec && !(hideTsumoTile && i === hand.length - 1)) {
          this.placeUprightShadow(
            ownShadowLayer,
            posX + spriteW,
            spriteH,
            spriteH,
            ownShadowSpec.big
          );
        }
        // Hide the just-drawn tsumo tile while the draw-in back slides.
        if (hideTsumoTile && i === hand.length - 1) {
          tileSprite.alpha = 0;
        }
        handContainer.addChild(tileSprite);
      });
      if (isDrawing) {
        const slotX = (hand.length - 1) * (t.w + t.gap) + handGap;
        const slidePosX = slotX + DRAW_SLIDE_PX * (1 - drawProgress);
        // Shadow travels with the sliding tile (its settled one is
        // skipped above while the tile is hidden / sliding).
        if (ownShadowSpec) {
          this.placeUprightShadow(
            ownShadowLayer,
            slidePosX + spriteW,
            spriteH,
            spriteH,
            ownShadowSpec.big
          );
        }
        // Focused hand is always revealed: slide the real drawn tile
        // in face-up (from the `ownHand` sheet) rather than a back.
        const slideTile = factory.create({
          atlasId: "ownHand",
          tile: hand[hand.length - 1],
          width: spriteW,
          height: spriteH,
          anchor: 0,
        });
        slideTile.position.set(slidePosX, 0);
        handContainer.addChild(slideTile);
      }
      if (seat === 0) {
        // Drag-to-reorder: enable zIndex sorting so the
        // currently-dragged tile (zIndex 1_000_000, set in the
        // forEach above) floats above its neighbours.
        handContainer.sortableChildren = true;
      }
    }

    // Position the hand container within `layout.hands[seat]`.
    //
    // The container's local axes have tile 0 at (0, 0) growing in
    // +x with thickness SMALL_TILE_H along +y. After rotation by
    // `seat * π/2` clockwise (seat 1 = right, 2 = top, 3 = left),
    // the +x axis points along the strip's long axis (centre →
    // clockwise corner) and +y points outboard. We then offset so
    // the run is centred along the long axis and aligned to the
    // strip's *inner* edge (facing the centre of the table).
    const handRect = layout.hands[seat];
    const longAxisLen = seat % 2 === 0 ? handRect.w : handRect.h;
    const sideHandScreenWidth = sideHandRevealed
      ? SIDE_TILE_W
      : layout.tileSide.w;
    // The hand is left-aligned in the band (player's POV): the
    // leftmost tile sits at the band's player-left edge. The meld
    // strip is right-aligned at the band's player-right edge (see
    // `renderMelds`).
    const longAxisOffset = 0;
    void longAxisLen;
    switch (seat) {
      case 0: {
        // bottom — +x to the right, +y downward (no rotation).
        // Inner edge = top of the rect.
        handContainer.position.set(handRect.x + longAxisOffset, handRect.y);
        // Stamp the seat-0 hand origin in design coords so the
        // window-level pointermove handler can convert page
        // coords into handContainer-local x without keeping a
        // stale Pixi node reference between renders.
        this.handContainerOriginX = handRect.x + longAxisOffset;
        break;
      }
      case 1: {
        // right — rotate -90° (counter-clockwise on screen) so the
        // hand reads from bottom→top after rotation. Container's
        // origin is inset from the rect's right edge by the upright
        // tile width, so the strip is flush with the hand zone's
        // screen-right edge.
        handContainer.rotation = -Math.PI / 2;
        handContainer.position.set(
          handRect.x + handRect.w - sideHandScreenWidth,
          handRect.y + handRect.h - longAxisOffset
        );
        break;
      }
      case 2: {
        // top — rotate 180°. Origin lands at the rect's
        // bottom-right; inner edge of the rect is the bottom.
        handContainer.rotation = Math.PI;
        handContainer.position.set(
          handRect.x + handRect.w - longAxisOffset,
          handRect.y + handRect.h
        );
        break;
      }
      case 3: {
        // left — rotate 90° (clockwise). Origin at rect's
        // left edge plus the upright tile width; the rotated tile
        // extends left from there and sits flush with the zone edge.
        handContainer.rotation = Math.PI / 2;
        handContainer.position.set(
          handRect.x + sideHandScreenWidth,
          handRect.y + longAxisOffset
        );
        break;
      }
    }
    // Bottom hand (seat 0) must sit above all walls so the side
    // walls (zIndex 1) don't clip the player's tiles where the
    // bands overlap the hand zone.
    if (seat === 0) {
      handContainer.zIndex = 10;
    }

    // Furiten indicator: red "Furiten" label with black contour
    // overlaid on the top-right of the leftmost tile of the
    // focused player's hand. Driven by the engine-derived
    // `view.furiten[seat]` flag (set / unset via `furiten`
    // wire events). Restricted to seat 0 (the focused hand at the
    // bottom) so opponents' furiten state — which is private in
    // live play — isn't surfaced visually even when the array
    // happens to carry it.
    if (seat === 0 && view.furiten[seat]) {
      const label = new Text({
        text: "Furiten",
        style: new TextStyle({
          fontFamily: "Inter, system-ui, sans-serif",
          fontSize: 18,
          fontWeight: "700",
          fill: 0xff3030,
          stroke: { color: 0x000000, width: 3 },
        }),
      });
      // Anchor at the text's top-right; place that anchor at the
      // top-right corner of tile 0 (with a 2 px inset so the
      // glyphs sit comfortably inside the tile face). The label
      // grows down and to the left from this pivot.
      label.anchor.set(1, 0);
      label.position.set(BIG_TILE_W - 2, 2);
      handContainer.addChild(label);
    }

    this.root.addChild(handContainer);

    // Open / declared melds for this seat. Anchored to the outer
    // (clockwise) corner of the hand so chi/pon/kan stacks read
    // naturally.
    this.renderMelds(
      presentation.displayMelds,
      seat,
      handRect,
      longAxisOffset,
      handWidth,
      !presentation.historicalReveal
    );

    // Discards as a 6-per-row pond. Rows overlap by
    // `DISCARD_ROW_OVERLAP` design pixels along the row-stacking
    // axis; the tile lower on screen sits on top of the one above
    // (mirrored for the top seat, whose pond is rotated 180°).
    // When this seat declared riichi, the tile at
    // `view.riichiTileIdx[seat]` is rotated 90° (SMALL_TILE_H wide ×
    // SMALL_TILE_W tall) — subsequent tiles in the SAME row shift right
    // by the extra width so they don't overlap.
    const discardContainer = new Container();
    discardContainer.sortableChildren = true;
    const riichiIdx = view.riichiTileIdx[seat];
    // -----------------------------------------------------------------
    // Discard slide animation hookup. When this seat has an active
    // phase-A/B animation targeting the very last discard, we skip
    // painting its static wrap and reuse its placement for the overlay
    // below. Riichi declarations use the same motion; their placement
    // carries the sideways atlas / rotation through the overlay.
    // -----------------------------------------------------------------
    const lastIdx = discards.length - 1;
    const lastIsAnimating =
      seatDiscardAnim != null &&
      lastIdx >= 0 &&
      seatDiscardAnim.discardIndex === lastIdx;
    // Lift the pond above the walls (zIndex 0..2) while a tile flies.
    // Its shadows must NOT ride along (they would cover neighbouring
    // ponds), so host them in a low-z sibling — its transform is
    // matched to the pond after the position switch below.
    let flyShadowHost: Container | null = null;
    if (lastIsAnimating) {
      discardContainer.zIndex = 5;
      flyShadowHost = new Container();
      flyShadowHost.zIndex = DISCARD_FLY_SHADOW_Z;
      flyShadowHost.sortableChildren = true;
      this.root.addChild(flyShadowHost);
    }
    // Pure container-local geometry per tile. Tint and the last-tile
    // fresh-nudge / animation remain renderer-owned below.
    const discardPlacements = layoutDiscards(
      this.tileDesign,
      seat as Seat,
      discards,
      riichiIdx
    );
    let animLastPlacement: TilePlacement | null = null;
    for (const placement of discardPlacements) {
      const i = placement.index;
      if (lastIsAnimating && i === lastIdx) {
        animLastPlacement = placement;
        continue;
      }
      const sprite = factory.create({
        atlasId: placement.atlasId,
        tile: placement.tile,
        width: placement.sprite.width,
        height: placement.sprite.height,
        rotation: placement.sprite.rotation,
      });
      sprite.position.set(placement.sprite.x, placement.sprite.y);
      // Wait-tint + fresh-tsumogiri darken cue: the pure layout
      // carries no tint. Tsumogiri is suppressed when already
      // wait-tinted so the red cue stays legible; parallel-array
      // lookups are defensive for older snapshots.
      const tinted = this.tintIfWait(sprite, placement.tile);
      const wasTsumogiri = view.discardTsumogiri[seat]?.[i] ?? false;
      const discardOrdinal = view.discardOrdinals[seat]?.[i] ?? 0;
      const isFreshTsumogiri =
        wasTsumogiri &&
        view.totalDiscards - discardOrdinal < TSUMOGIRI_FRESH_WINDOW;
      if (!tinted && isFreshTsumogiri) {
        sprite.tint = TSUMOGIRI_FRESH_TINT;
      }
      const wrap = new Container();
      wrap.addChild(sprite);
      wrap.zIndex = placement.zIndex;
      wrap.rotation = placement.wrap.rotation;
      wrap.position.set(placement.wrap.x, placement.wrap.y);
      discardContainer.addChild(wrap);
    }
    // Continuous drop shadow that always falls SCREEN-right: bucket
    // tiles into screen-vertical columns and shadow each on its
    // screen-right edge, below all tiles. Per-column for top/bottom
    // seats, per-row for left/right seats — handled automatically.
    {
      const rot = SEAT_CONTAINER_ROT[seat];
      const cos = Math.cos(rot);
      const sin = Math.sin(rot);
      const layer = this.screenShadowLayer(
        flyShadowHost ?? discardContainer,
        rot
      );
      this.placeColumnShadows(
        layer,
        discardPlacements
          // The in-flight last discard paints its own moving shadow in
          // the animated overlay below; skip its settled shadow so it
          // doesn't appear at the destination before the tile lands.
          .filter((p) => !(lastIsAnimating && p.index === lastIdx))
          .map((p) => {
            // Resolve the tile's true screen-space centre and
            // footprint. The sprite offset passes through the wrap's
            // own rotation (non-zero for the sideways riichi tile),
            // and the footprint uses the tile's total on-screen
            // rotation — so a tilted tile buckets into the same
            // screen-column as its row instead of punching a hole
            // that ruptures the continuous strip.
            const wr = p.wrap.rotation;
            const wc = Math.cos(wr);
            const ws = Math.sin(wr);
            const lx = p.wrap.x + (p.sprite.x * wc - p.sprite.y * ws);
            const ly = p.wrap.y + (p.sprite.x * ws + p.sprite.y * wc);
            const theta = rot + wr + p.sprite.rotation;
            const tc = Math.abs(Math.cos(theta));
            const ts = Math.abs(Math.sin(theta));
            const fw = p.sprite.width * tc + p.sprite.height * ts;
            const fh = p.sprite.width * ts + p.sprite.height * tc;
            return {
              ax: lx * cos - ly * sin,
              ay: lx * sin + ly * cos,
              w: fw,
              h: fh,
            };
          }),
        true
      );
    }
    // Position the discard container inside `layout.discards[seat]`.
    // The container's local axes have tile 0 at (0, 0), +x along
    // the row direction, +y across rows. After rotation, the
    // visible rect on screen matches the layout pond rect.
    const discardRect = layout.discards[seat];
    switch (seat) {
      case 0: {
        // bottom — no rotation. Local (0,0) → top-left of rect.
        discardContainer.position.set(discardRect.x, discardRect.y);
        break;
      }
      case 1: {
        // right — rotate -90°. Local +x maps to screen -y, local
        // +y maps to screen +x. Local (0,0) → bottom-left of rect.
        discardContainer.rotation = -Math.PI / 2;
        discardContainer.position.set(
          discardRect.x,
          discardRect.y + discardRect.h
        );
        break;
      }
      case 2: {
        // top — rotate 180°. Local (0,0) → bottom-right of rect.
        discardContainer.rotation = Math.PI;
        discardContainer.position.set(
          discardRect.x + discardRect.w,
          discardRect.y + discardRect.h
        );
        break;
      }
      case 3: {
        // left — rotate 90°. Local +x maps to screen +y, local
        // +y maps to screen -x. Local (0,0) → top-right of rect.
        discardContainer.rotation = Math.PI / 2;
        discardContainer.position.set(
          discardRect.x + discardRect.w,
          discardRect.y
        );
        break;
      }
    }
    this.root.addChild(discardContainer);
    if (flyShadowHost) {
      flyShadowHost.position.set(
        discardContainer.position.x,
        discardContainer.position.y
      );
      flyShadowHost.rotation = discardContainer.rotation;
    }

    // -----------------------------------------------------------------
    // Animated last-discard overlay.
    //
    // Built after the container is parented to `this.root` so
    // `handContainer.toGlobal(...)` / `discardContainer.toLocal(...)`
    // produce valid coordinates (both containers' world
    // transforms are now up to date).
    //
    // Phase A ("to-nudge"): interpolate from the hidden hand
    // slot's center (transformed into discard-container-local
    // coords) to the +10/+10 nudged pond position.
    //
    // Phase B ("to-final"): interpolate from the +10/+10 nudged
    // position back to the flush row position.
    // -----------------------------------------------------------------
    if (lastIsAnimating && seatDiscardAnim && animLastPlacement) {
      const progress = this.animator.getProgress(seat);
      const finalX = animLastPlacement.wrap.x;
      const finalY = animLastPlacement.wrap.y;
      const nudgedX = finalX + 10;
      const nudgedY = finalY + 10;
      let posX: number;
      let posY: number;
      if (seatDiscardAnim.phase === "to-final") {
        posX = nudgedX + (finalX - nudgedX) * progress;
        posY = nudgedY + (finalY - nudgedY) * progress;
      } else {
        const slotIdx = seatDiscardAnim.sourceSlot?.handIndex ?? 0;
        const source = this.computeHandSlotInDiscardLocal(
          handContainer,
          discardContainer,
          seat,
          slotIdx,
          layout,
          isFreshlyDrawn,
          hand.length,
          isSideHand,
          sideHandRevealed
        );
        posX = source.x + (nudgedX - source.x) * progress;
        posY = source.y + (nudgedY - source.y) * progress;
      }
      // Reuse the skipped last placement so the flying tile matches
      // exactly what the static loop would have drawn; only the tile
      // string comes from the animator.
      const sprite = factory.create({
        atlasId: animLastPlacement.atlasId,
        tile: seatDiscardAnim.tile,
        width: animLastPlacement.sprite.width,
        height: animLastPlacement.sprite.height,
        rotation: animLastPlacement.sprite.rotation,
      });
      sprite.position.set(
        animLastPlacement.sprite.x,
        animLastPlacement.sprite.y
      );
      // Tsumogiri fresh-tint: keep the animated tile consistent with
      // how the static last-discard would have looked.
      if (seatDiscardAnim.isTsumogiri) {
        sprite.tint = TSUMOGIRI_FRESH_TINT;
      }
      const wrap = new Container();
      wrap.addChild(sprite);
      const shadow = this.makeTileShadow(
        {
          width: animLastPlacement.sprite.width,
          height: animLastPlacement.sprite.height,
          rotation: animLastPlacement.sprite.rotation,
          cx: animLastPlacement.sprite.x,
          cy: animLastPlacement.sprite.y,
        },
        SEAT_CONTAINER_ROT[seat] + animLastPlacement.wrap.rotation
      );
      wrap.position.set(posX, posY);
      wrap.rotation = animLastPlacement.wrap.rotation;
      // Match the z-order the static loop would have used for this
      // same (last) tile so it doesn't jump in front of its row
      // neighbour (side seats) or the previous row (top seat).
      wrap.zIndex = animLastPlacement.zIndex;
      discardContainer.addChild(wrap);
      if (shadow) {
        // Same low-z host as the static shadows (created with the pond
        // lift): keeps the flying shadow below every seat's tiles.
        this.placeTileShadow(
          flyShadowHost ?? discardContainer,
          shadow,
          posX,
          posY,
          animLastPlacement.wrap.rotation
        );
      }
    }

    // Riichi stick: a horizontal white rectangle with a red dot,
    // laid in front of each seat that has declared riichi. Sits
    // just inboard (table-center side) of the discard pile.
    if (view.riichiDeclared[seat]) {
      const stickW = 90;
      const stickH = 8;
      const stickGap = 10;
      const stick = new Container();
      const bar = new Graphics()
        .roundRect(0, 0, stickW, stickH, 3)
        .fill({ color: 0xf5f5f5 });
      const dot = new Graphics()
        .circle(stickW / 2, stickH / 2, 2.5)
        .fill({ color: 0xc04040 });
      stick.addChild(bar, dot);
      // The stick sits just inboard (table-centre side) of the
      // pond. We compute the inboard edge from the pond rect and
      // place the stick centred along the perpendicular axis.
      const centerX = layout.center.x + layout.center.w / 2;
      const centerY = layout.center.y + layout.center.h / 2;
      switch (seat) {
        case 0: {
          // bottom — horizontal, stick above the pond's top edge
          stick.position.set(centerX - stickW / 2, discardRect.y - stickGap);
          break;
        }
        case 1: {
          // right — vertical, stick to the left of the pond's left edge
          stick.rotation = -Math.PI / 2;
          stick.position.set(discardRect.x - stickGap, centerY + stickW / 2);
          break;
        }
        case 2: {
          // top — horizontal, mirrored, below the pond's bottom edge
          stick.rotation = Math.PI;
          stick.position.set(
            centerX + stickW / 2,
            discardRect.y + discardRect.h + stickGap
          );
          break;
        }
        case 3: {
          // left — vertical, to the right of the pond's right edge
          stick.rotation = Math.PI / 2;
          stick.position.set(
            discardRect.x + discardRect.w + stickGap,
            centerY - stickW / 2
          );
          break;
        }
      }
      this.root.addChild(stick);
    }
  }

  /**
   * Compute the center of a hand tile slot, expressed in the
   * discard container's local coordinate system, for the discard
   * slide animation's phase-A source.
   *
   * The discard animator records which hand index a tile came
   * from; this method mirrors the per-seat positioning math used
   * inside `renderSeat` and then walks through Pixi's world
   * transforms so the slide can be parameterised entirely in
   * discard-container-local coordinates.
   */
  private computeHandSlotInDiscardLocal(
    handContainer: Container,
    discardContainer: Container,
    seat: number,
    slotIdx: number,
    layout: TableLayout,
    isFreshlyDrawn: boolean,
    handLength: number,
    isSideHand: boolean,
    sideHandRevealed: boolean
  ): { x: number; y: number } {
    const handGap = isFreshlyDrawn ? TSUMO_GAP : 0;
    const extraGap = handGap > 0 && slotIdx === handLength - 1 ? handGap : 0;
    let lx: number;
    let ly: number;
    if (isSideHand) {
      if (sideHandRevealed) {
        const stride = SIDE_TILE_H - DISCARD_ROW_OVERLAP_HORIZ;
        lx = slotIdx * stride + extraGap + SIDE_TILE_H / 2;
        ly = SIDE_TILE_W / 2;
      } else {
        const ts = layout.tileSide;
        const stride = ts.h - layout.tileSideOverlap;
        lx = slotIdx * stride + extraGap + ts.h / 2;
        ly = ts.w / 2;
      }
    } else if (seat === 0) {
      const t = layout.tileSelf;
      lx = slotIdx * (t.w + t.gap) + extraGap + BIG_TILE_W / 2;
      ly = BIG_TILE_H / 2;
    } else {
      // Seat 2 (top): face-down small backs sized to tileHorizontal.
      const t = layout.tileHorizontal;
      lx = slotIdx * (t.w + t.gap) + extraGap + t.w / 2;
      ly = t.h / 2;
    }
    const global = handContainer.toGlobal({ x: lx, y: ly });
    return discardContainer.toLocal(global);
  }

  /**
   * Static darkened rounded "mats" behind each seat's hand + meld
   * band, the way Tenhou frames each hand. Fixed to the layout — they
   * never depend on hand contents, so toggling "show hands" can't make
   * them vanish — and drawn just above the felt + vignette, below
   * every tile and tile shadow.
   */
  private renderHandPanels(layout: TableLayout): void {
    if (!this.root) {
      return;
    }
    for (let seat = 0; seat < 4; seat++) {
      const hb = layout.hands[seat];
      const panelRect =
        seat === 0
          ? {
              x: hb.x,
              y: hb.y + BIG_TILE_H - layout.hands[2].h,
              w: hb.w,
              h: layout.hands[2].h,
            }
          : hb;
      const panel = new Graphics()
        .roundRect(
          panelRect.x,
          panelRect.y,
          panelRect.w,
          panelRect.h,
          HAND_PANEL_RADIUS
        )
        .fill({ color: 0x000000, alpha: HAND_PANEL_ALPHA });
      panel.zIndex = -10;
      this.root.addChild(panel);
    }
  }

  /**
   * Static darkened mats behind the four 6×3 discard ponds. Each mat
   * extends 4 design pixels past each horizontal edge and each edge
   * of its inset vertical footprint. The screen-top edge starts from
   * a one-tile-overlap inset so the mat hugs the visible stacked
   * footprint rather than filling the whole layout zone.
   */
  private renderDiscardPanels(layout: TableLayout): void {
    if (!this.root) {
      return;
    }
    for (let seat = 0; seat < 4; seat++) {
      const pond = layout.discards[seat];
      const panelRect = this.discardPanelRect(pond, seat);
      const panel = new Graphics()
        .roundRect(
          panelRect.x,
          panelRect.y,
          panelRect.w,
          panelRect.h,
          HAND_PANEL_RADIUS
        )
        .fill({ color: 0x000000, alpha: HAND_PANEL_ALPHA });
      panel.zIndex = -10;
      this.root.addChild(panel);

      const identityCenter = this.playerPanelCenter(panelRect, seat);
      const playerPanelX = identityCenter.x - PLAYER_PANEL_SIZE / 2;
      const playerPanelY = identityCenter.y - PLAYER_PANEL_SIZE / 2;
      let linkX = 0;
      let linkY = 0;
      let linkW = 0;
      let linkH = 0;
      if (seat === 0) {
        linkX = panelRect.x + panelRect.w;
        linkY = identityCenter.y - PLAYER_PANEL_LINK_WIDTH / 2;
        linkW = PLAYER_PANEL_GAP;
        linkH = PLAYER_PANEL_LINK_WIDTH;
      } else if (seat === 1) {
        linkX = identityCenter.x - PLAYER_PANEL_LINK_WIDTH / 2;
        linkY = panelRect.y - PLAYER_PANEL_GAP;
        linkW = PLAYER_PANEL_LINK_WIDTH;
        linkH = PLAYER_PANEL_GAP;
      } else if (seat === 2) {
        linkX = panelRect.x - PLAYER_PANEL_GAP;
        linkY = identityCenter.y - PLAYER_PANEL_LINK_WIDTH / 2;
        linkW = PLAYER_PANEL_GAP;
        linkH = PLAYER_PANEL_LINK_WIDTH;
      } else {
        linkX = identityCenter.x - PLAYER_PANEL_LINK_WIDTH / 2;
        linkY = panelRect.y + panelRect.h;
        linkW = PLAYER_PANEL_LINK_WIDTH;
        linkH = PLAYER_PANEL_GAP;
      }
      const playerPanel = new Graphics()
        .rect(linkX, linkY, linkW, linkH)
        .fill({ color: 0x000000, alpha: PLAYER_PANEL_ALPHA })
        .roundRect(
          playerPanelX,
          playerPanelY,
          PLAYER_PANEL_SIZE,
          PLAYER_PANEL_SIZE,
          8
        )
        .fill({ color: 0x000000, alpha: PLAYER_PANEL_ALPHA });
      playerPanel.zIndex = -10;
      this.root.addChild(playerPanel);
    }
  }

  private discardPanelRect(pond: Rect, seat: number): Rect {
    const topInset =
      seat % 2 === 0
        ? this.tileDesign.spacing.discardRowVert
        : this.tileDesign.spacing.discardRowHoriz;
    return {
      x: pond.x - 4,
      y: pond.y + topInset - 4,
      w: pond.w + 8,
      h: pond.h - topInset + 8,
    };
  }

  private playerPanelCenter(
    discardPanel: Rect,
    seat: number
  ): { x: number; y: number } {
    // Align the identity square's player-relative bottom edge with
    // the discard mat's: screen bottom/right/top/left for seats
    // 0/1/2/3 respectively.
    if (seat === 0) {
      return {
        x:
          discardPanel.x +
          discardPanel.w +
          PLAYER_PANEL_GAP +
          PLAYER_PANEL_SIZE / 2,
        y: discardPanel.y + discardPanel.h - PLAYER_PANEL_SIZE / 2,
      };
    }
    if (seat === 1) {
      return {
        x: discardPanel.x + discardPanel.w - PLAYER_PANEL_SIZE / 2,
        y: discardPanel.y - PLAYER_PANEL_GAP - PLAYER_PANEL_SIZE / 2,
      };
    }
    if (seat === 2) {
      return {
        x: discardPanel.x - PLAYER_PANEL_GAP - PLAYER_PANEL_SIZE / 2,
        y: discardPanel.y + PLAYER_PANEL_SIZE / 2,
      };
    }
    return {
      x: discardPanel.x + PLAYER_PANEL_SIZE / 2,
      y:
        discardPanel.y +
        discardPanel.h +
        PLAYER_PANEL_GAP +
        PLAYER_PANEL_SIZE / 2,
    };
  }

  /**
   * Render a seat's open / declared melds in a small row anchored to
   * the outer (table-edge) corner of the hand. Each meld is drawn
   * left-to-right in declaration order; the called tile (for
   * chi/pon/daiminkan) is rotated 90° to mark its position
   * (left/middle/right) per Tenhou convention. Ankan renders both
   * outer tiles face-down.
   */
  private renderMelds(
    melds: Meld[],
    seat: number,
    handRect: Rect,
    longAxisOffset: number,
    handWidth: number,
    animate: boolean = true
  ): void {
    if (!this.root || melds.length === 0) {
      return;
    }
    void longAxisOffset;
    void handWidth;
    // Adjacent melds overlap along the strip just like tiles
    // within a single meld: side seats overlap by 16 design px,
    // bottom/top butt flush.
    const meldGap = seat === 1 || seat === 3 ? -16 : 0;
    const strip = new Container();
    // Where adjacent melds overlap, the newer meld must render
    // on top of the older one (matching the discard-pond
    // convention that the most recent tile sits on top of its
    // neighbour). Enable z-sorting on the strip so we can stamp
    // each meld with a zIndex that mirrors its declaration order
    // regardless of the addChild sequence below.
    strip.sortableChildren = true;
    // Lay melds out so the FIRST call sits at the outer end of the
    // strip (player's-right end of the band) and subsequent calls
    // stack inward toward the hand. We render in reverse order
    // along local +x so the strip's leftmost tile (local x=0) is
    // the most recent call, and the rightmost tile is the first
    // call.
    let cursor = 0;
    const meldWidths: number[] = [];
    let loopIter = 0;
    const stripRot = SEAT_CONTAINER_ROT[seat];
    const shadowBoxes: Array<{
      ax: number;
      ay: number;
      w: number;
      h: number;
      isolated?: boolean;
    }> = [];
    for (let i = melds.length - 1; i >= 0; i--) {
      const slideDistance =
        meldTileDims(this.tileDesign, seat).w * MELD_SLIDE_TILE_WIDTHS;
      const slideOffsetX = animate
        ? this.meldAnimator.getMeldOffsetX(seat, i, slideDistance)
        : 0;
      const shouminkanOffsetY = animate
        ? this.meldAnimator.getShouminkanOffsetY(seat, i, slideDistance)
        : 0;
      const { node, width, boxes } = this.drawMeld(
        melds[i],
        seat,
        shouminkanOffsetY
      );
      node.position.set(cursor + slideOffsetX, 0);
      for (const b of boxes) {
        const shadowPoint = rotateMeldLocalPoint(
          cursor + slideOffsetX + b.cx,
          b.cy,
          stripRot
        );
        shadowBoxes.push({
          ax: shadowPoint.x,
          ay: shadowPoint.y,
          w: b.w,
          h: b.h,
          isolated: b.isolated,
        });
      }
      // Z-order between adjacent overlapping melds must match the
      // within-meld convention used in `drawMeld` (tile lower on
      // screen sits on top):
      //   Seat 1 (right, container rot -π/2): local +x → screen -y,
      //     so the meld at the LOWEST cursor is lowest on screen
      //     and should be on top → zIndex = -loopIter.
      //   Seat 3 (left,  container rot +π/2): local +x → screen +y,
      //     so the meld at the HIGHEST cursor is lowest on screen
      //     and should be on top → zIndex = +loopIter.
      //   Seats 0/2 don't overlap (meldGap = 0); any stable order
      //   works, fall back to declaration order.
      if (seat === 1) {
        node.zIndex = -loopIter;
      } else if (seat === 3) {
        node.zIndex = loopIter;
      } else {
        node.zIndex = i;
      }
      strip.addChild(node);
      meldWidths.push(width);
      cursor += width + meldGap;
      loopIter++;
    }
    // Strip content width = sum of meld widths + (n-1) gaps. The
    // last meld in the loop adds a trailing meldGap that we don't
    // want in the strip's anchored width.
    const stripWidth = cursor - meldGap;
    // Anchor the strip so its right end (local +x = stripWidth)
    // aligns with the band's player-right edge. `longAxisLen` is
    // the band's length along the hand-container's local +x.
    const longAxisLen = seat % 2 === 0 ? handRect.w : handRect.h;
    const stripOriginLocalX = longAxisLen - stripWidth;
    // Place the strip's local origin so local +x=0 lies at band-
    // local-x = stripOriginLocalX. The four cases mirror the
    // hand-container's rotation / anchor scheme.
    switch (seat) {
      case 0: {
        // Bottom-align with the closed hand: the hand uses BIG
        // tiles (height BIG_TILE_H) while melds use SMALL tiles
        // (height SMALL_TILE_H). Both share `handRect.y` as their
        // top anchor; shift the meld strip down by the height
        // difference so their bottom edges coincide.
        strip.position.set(
          handRect.x + stripOriginLocalX,
          handRect.y + BIG_TILE_H - SMALL_TILE_H
        );
        break;
      }
      case 1: {
        strip.rotation = -Math.PI / 2;
        strip.position.set(
          handRect.x,
          handRect.y + handRect.h - stripOriginLocalX
        );
        break;
      }
      case 2: {
        strip.rotation = Math.PI;
        strip.position.set(
          handRect.x + handRect.w - stripOriginLocalX,
          handRect.y + handRect.h
        );
        break;
      }
      case 3: {
        strip.rotation = Math.PI / 2;
        strip.position.set(
          handRect.x + handRect.w,
          handRect.y + stripOriginLocalX
        );
        break;
      }
    }
    // Upright meld tiles may share a continuous screen-column shadow.
    // Tilted called tiles must remain isolated: for a left-seat call from
    // the right their centre can align with the upright column, causing the
    // sideways shadow to be incorrectly merged into the long strip.
    const shadowLayer = this.screenShadowLayer(strip, stripRot);
    this.placeColumnShadows(
      shadowLayer,
      shadowBoxes.filter((box) => !box.isolated)
    );
    for (const box of shadowBoxes.filter((candidate) => candidate.isolated)) {
      this.placeColumnShadows(shadowLayer, [box]);
    }
    this.root.addChild(strip);
  }

  /**
   * One open / closed meld. Tiles are drawn in a horizontal row;
   * the called tile (if any) is laid sideways (rotated +90°) at the
   * position matching the seat the call came from (Tenhou
   * convention):
   *
   *   - kamicha (previous seat, `from = (seat-1) mod 4`): LEFT
   *   - toimen  (across,        `from = (seat+2) mod 4`): MIDDLE
   *   - shimocha (next seat,    `from = (seat+1) mod 4`): RIGHT
   *
   * Chi is always from kamicha so it always sits on the left. Pon /
   * daiminkan can come from any of the three. Ankan: outer two tiles
   * render face-down; no rotated tile.
   *
   * Shouminkan ("added kan"): rendered like the original pon (called
   * tile sideways at the from-direction position) with the upgrade
   * tile stacked on top of the called tile.
   */
  private drawMeld(
    meld: Meld,
    seat: number,
    shouminkanOffsetY = 0
  ): {
    node: Container;
    width: number;
    boxes: Array<{
      cx: number;
      cy: number;
      w: number;
      h: number;
      isolated?: boolean;
    }>;
  } {
    const c = new Container();
    c.sortableChildren = true;
    const boxes: Array<{
      cx: number;
      cy: number;
      w: number;
      h: number;
      isolated?: boolean;
    }> = [];
    // Side-seat melds overlap consecutive tiles by 16 design pixels
    // along the row direction, matching the discard pond. Bottom/top
    // seats butt their tiles flush with no gap.
    const meldOverlap = seat === 1 || seat === 3 ? 16 : 0;
    // Within-strip z-order for side seats: the tile lower on
    // screen sits on top of its neighbour, matching discards.
    //   Seat 1 (right, container rot -π/2): cursor +x → screen -y,
    //     so smaller i is lower on screen → zIndex = -i.
    //   Seat 3 (left, container rot +π/2): cursor +x → screen +y,
    //     so larger i is lower on screen → zIndex = i.
    const tileZ = (i: number): number => {
      if (seat === 1) {
        return -i;
      }
      if (seat === 3) {
        return i;
      }
      return 0;
    };
    if (meld.type === "ankan") {
      const tiles = ankanTilesForDisplay(meld.tiles);
      let ax = 0;
      const mt = meldTileDims(this.tileDesign, seat);
      tiles.forEach((tile, i) => {
        const faceUp = !(i === 0 || i === tiles.length - 1);
        const {
          node: sprite,
          offX,
          offY,
          footW,
          footH,
        } = faceUp
          ? this.drawMeldTile(tile, seat)
          : this.drawMeldTile(null, seat);
        sprite.position.set(ax, 0);
        sprite.zIndex = tileZ(i);
        ax += mt.w - meldOverlap;
        c.addChild(sprite);
        boxes.push({
          cx: sprite.position.x + offX,
          cy: sprite.position.y + offY,
          w: footW,
          h: footH,
        });
      });
      return {
        node: c,
        width: tiles.length * mt.w - (tiles.length - 1) * meldOverlap,
        boxes,
      };
    }
    if (meld.claimedTile === null || meld.from === null) {
      // Shouldn't happen for chi/pon/kan, but render defensively as a
      // plain row.
      let dx = 0;
      const mt = meldTileDims(this.tileDesign, seat);
      meld.tiles.forEach((tile, i) => {
        const {
          node: sprite,
          offX,
          offY,
          footW,
          footH,
        } = this.drawMeldTile(tile, seat);
        sprite.position.set(dx, 0);
        sprite.zIndex = tileZ(i);
        dx += mt.w - meldOverlap;
        c.addChild(sprite);
        boxes.push({
          cx: sprite.position.x + offX,
          cy: sprite.position.y + offY,
          w: footW,
          h: footH,
        });
      });
      return {
        node: c,
        width: meld.tiles.length * mt.w - (meld.tiles.length - 1) * meldOverlap,
        boxes,
      };
    }

    // Build the visible tile sequence: non-called tiles in tile-sort
    // order, then insert the called tile at the slot indicated by
    // `from` direction.
    const called = meld.claimedTile;
    // For shouminkan we render the original three pon tiles in the
    // row and stack the upgrade tile on top of the called slot.
    const isShouminkan = meld.type === "shouminkan";
    // Remove a SINGLE copy of the called tile (pon/kan of identical
    // tiles like "1m,1m,1m" would otherwise filter every match and
    // leave `otherTiles` empty → undefined slot tiles → crash).
    const otherTiles = (() => {
      const rest = [...meld.tiles];
      const idx = rest.indexOf(called);
      if (idx >= 0) {
        rest.splice(idx, 1);
      }
      return rest.sort((a, b) => tileSortKey(a) - tileSortKey(b));
    })();
    // For shouminkan there are 4 matching tiles in `meld.tiles`; the
    // base row is 3 tiles (called + 2 others), and the 4th tile goes
    // on top of the called.
    let baseOthers = otherTiles;
    let stackTile: string | null = null;
    if (isShouminkan && otherTiles.length === 3) {
      // The "extra" tile is whichever copy isn't the called tile and
      // doesn't appear in the original pon. We can't reliably tell
      // them apart by string (red 5 aside), so just lift the last
      // copy onto the stack.
      baseOthers = otherTiles.slice(0, 2);
      stackTile = otherTiles[2];
    }

    // From-direction → called tile slot in the base row of length 3:
    //   prev  (kamicha)  → 0 (left)
    //   across (toimen)  → 1 (middle)
    //   next  (shimocha) → 2 (right)
    const calledSlot3 =
      meld.from === (seat + 3) % 4 ? 0 : meld.from === (seat + 2) % 4 ? 1 : 2;

    // Layout: walk slots in screen order. Chi / pon = 3 slots,
    // daiminkan / shouminkan base row = 3 slots (the 4th tile is
    // either irrelevant for chi/pon or stacked on top for shouminkan;
    // for daiminkan the 4th tile sits next to the called tile).
    const slotCount = meld.type === "daiminkan" ? 4 : 3;
    // Daiminkan extends to 4 slots; the called (tilted) tile must
    // still sit at the *edge* corresponding to the from-direction
    // (kamicha → leftmost = 0, shimocha → rightmost = 3) so the
    // rotated tile points outward at the discarder. The toimen
    // case keeps the middle convention but shifts to slot 1 so the
    // 4th non-called copy can sit to its right.
    const calledSlot =
      meld.type === "daiminkan" && calledSlot3 === 2 ? 3 : calledSlot3;
    const slots: Array<{ tile: string; rotated: boolean }> = [];
    let oi = 0;
    for (let s = 0; s < slotCount; s++) {
      if (s === calledSlot) {
        slots.push({ tile: called, rotated: true });
      } else {
        const t = baseOthers[oi++];
        if (t === undefined) {
          continue;
        }
        slots.push({ tile: t, rotated: false });
      }
    }
    let xCursor = 0;
    let calledX = 0;
    const mt = meldTileDims(this.tileDesign, seat);
    // Tilted called tile uses the NEXT-CLOCKWISE seat's sheet so it
    // visually points outward toward the player from whom the tile
    // was claimed (Tenhou convention). Its size matches that
    // seat's discard dims (which may differ from the strip seat's
    // dims for side strips).
    const tiltedSheet = this.tileDesign.sheets.meld[
      ((seat + 1) % 4) as Seat
    ] as SheetKey;
    const tiltedSeat = (seat + 1) % 4;
    const tilted = meldTileDims(this.tileDesign, tiltedSeat);
    slots.forEach((slot, i) => {
      const {
        node: sprite,
        offX,
        offY,
        footW,
        footH,
      } = slot.rotated
        ? this.drawMeldTile(slot.tile, seat, tiltedSheet)
        : this.drawMeldTile(slot.tile, seat);
      sprite.zIndex = tileZ(i);
      if (slot.rotated) {
        sprite.rotation = -Math.PI / 2;
        // After -90° rotation around (0,0), the sprite occupies
        // x∈[0, tilted.h], y∈[-tilted.w, 0]. Shift it so it sits
        // flush with the bottom of the row (y = mt.h) at the
        // current x cursor.
        sprite.position.set(xCursor, mt.h);
        calledX = xCursor;
        xCursor += tilted.h - meldOverlap;
      } else {
        sprite.position.set(xCursor, 0);
        xCursor += mt.w - meldOverlap;
      }
      c.addChild(sprite);
      boxes.push({
        cx: sprite.position.x + offX,
        cy: sprite.position.y + offY,
        w: footW,
        h: footH,
        isolated: slot.rotated,
      });
    });
    if (stackTile !== null) {
      const {
        node: stack,
        offX: stackOffX,
        offY: stackOffY,
        footW: stackFootW,
        footH: stackFootH,
      } = this.drawMeldTile(stackTile, seat, tiltedSheet);
      stack.rotation = -Math.PI / 2;
      // Z-order:
      //   - Bottom seat (0): stack renders UNDER the called tile so
      //     the called tile's top edge occludes the small overlap
      //     band, giving a subtle depth cue.
      //   - Top seat (2): the meld container is rotated 180°, which
      //     visually flips what is "under" into "over" from the
      //     bottom-seat POV. To keep the same "added tile sits on
      //     top of the called tile" semantics, flip z-order so the
      //     stack draws OVER the called tile.
      //   - Side seats (1, 3): the stack sits at the same X as the
      //     called tile, so it overlaps the upright neighbour along
      //     the row exactly like the called tile does. Match the
      //     called tile's zIndex so the stack inherits the same
      //     overlap behavior (called in front of/behind neighbour
      //     per the side-strip discard rule).
      if (seat === 1 || seat === 3) {
        stack.zIndex = tileZ(calledSlot);
      } else {
        stack.zIndex =
          seat === 2 ? tileZ(slots.length) + 1 : tileZ(slots.length) - 1;
      }
      // Vertical offset: bottom/top seats overlap the called tile
      // by `DISCARD_ROW_OVERLAP_HORIZ` for a stacked-in-perspective
      // look. Side seats (1, 3) butt the stack flush against the
      // called tile with NO overlap — the tilted-tile silhouettes
      // are already very close to the row edge and any overlap
      // reads as a glitch from a side perspective.
      const stackOverlap =
        seat === 1 || seat === 3 ? 0 : DISCARD_ROW_OVERLAP_HORIZ;
      stack.position.set(
        calledX,
        mt.h - tilted.w + stackOverlap + shouminkanOffsetY
      );
      c.addChild(stack);
      boxes.push({
        cx: stack.position.x + stackOffX,
        cy: stack.position.y + stackOffY,
        w: stackFootW,
        h: stackFootH,
        isolated: true,
      });
    }
    // Total footprint width = xCursor (sum of strides) + the last
    // tile's full width restored (each stride subtracted `meldOverlap`,
    // but there is no next tile to overlap with the last one).
    return { node: c, width: xCursor + meldOverlap, boxes };
  }

  /**
   * Update the top-right action-timer countdown. Called from a
   * Pixi-ticker callback every frame and also synchronously at
   * the end of `render()` so values stay fresh between ticks.
   *
   * The deadline is a Unix-ms timestamp supplied by the server in
   * its most recent `snapshot` / `event` frame; we tick locally
   * against `Date.now()` so the countdown stays smooth without
   * busy-pinging the server. Server clock skew shows up as a
   * one-shot offset, not a drift.
   */
  private tickTimer(): void {
    const timer = this.timerText;
    if (!timer) {
      return;
    }
    // Keep the HUD glued to the bottom-right corner of the green
    // felt. `timerAnchor` is refreshed every `render` from the
    // current root transform.
    if (this.timerAnchor) {
      timer.position.set(this.timerAnchor.x - 6, this.timerAnchor.y - 4);
    } else if (this.app) {
      timer.position.set(this.app.screen.width - 6, this.app.screen.height - 4);
    }
    const deadline = this.actionDeadline;
    if (deadline === null) {
      if (timer.visible) {
        timer.visible = false;
      }
      this.lastTimerSeconds = null;
      return;
    }
    const now = Date.now();
    // Base = the per-action 5s budget that ticks down first.
    // Once it hits 0, the trailing buffer starts burning.
    const baseRemainingMs = Math.max(0, deadline - now);
    const baseElapsedOverflowMs = Math.max(0, now - deadline);
    const bufferStartMs = this.actionBufferMs ?? 0;
    const bufferRemainingMs = Math.max(
      0,
      bufferStartMs - baseElapsedOverflowMs
    );
    const totalRemainingMs = baseRemainingMs + bufferRemainingMs;
    const baseSec = Math.ceil(baseRemainingMs / 1000);
    const bufferSec = Math.ceil(bufferRemainingMs / 1000);
    const nextText =
      this.actionBufferMs === null
        ? `${baseSec}s`
        : `${baseSec} + ${bufferSec}`;
    if (timer.text !== nextText) {
      timer.text = nextText;
    }
    // Tint thresholds: yellow when in the buffer pool, red when
    // total ≤ 5s (matches the tick-sound threshold).
    const totalSec = Math.ceil(totalRemainingMs / 1000);
    const nextStyle =
      totalSec <= 5
        ? timerStyleDanger
        : baseSec === 0
          ? timerStyleWarn
          : timerStyleNormal;
    if (timer.style !== nextStyle) {
      timer.style = nextStyle;
    }
    if (!timer.visible) {
      timer.visible = true;
    }
    // Fire `timer-tick` on every whole-second crossing while the
    // total remaining is at or below 5s (including the first
    // frame the timer paints at ≤5s, so the player gets the
    // full 5-4-3-2-1 sequence even if the window opens already
    // inside the danger zone).
    if (totalSec > 0 && totalSec <= 5 && totalSec !== this.lastTimerSeconds) {
      playGameSound("timer-tick");
    }
    this.lastTimerSeconds = totalSec;
  }

  private renderActionButtons(view: MatchView, _cx: number): void {
    if (!this.root) {
      return;
    }
    // Once a hand has ended (or the match is over) the action
    // strip is meaningless — `legalActions` may still contain
    // the just-fired win for a beat before the server's
    // `hand_end` echo clears it, and we don't want the tsumo /
    // ron button lingering on top of the win-info panel.
    if (view.lastHandResult !== null || view.matchEnded) {
      return;
    }
    // Pull every non-discard legal action — these are the call /
    // riichi / win decisions that need explicit buttons. Discards
    // are tile-driven (click a tile in the hand).
    const raw = view.legalActions.filter((a) => {
      if (a.type === "discard" || a.type === "draw") {
        return false;
      }
      // With "Auto win" enabled the host effect fires ron /
      // tsumo automatically; suppress the buttons so they don't
      // flash in for the frames before the server echo clears
      // `legalActions` (notably noticeable each draw while in
      // riichi, where tsumo is the only surfaced button).
      if (this.autoWinEnabled && (a.type === "ron" || a.type === "tsumo")) {
        return false;
      }
      return true;
    });

    // Group call-type actions (chi / pon / kan) so we can collapse
    // multiple tile-combination options behind a single chevron
    // button, and consolidate riichi declarations into one toggle.
    const chi = raw.filter((a) => a.type === "chi");
    const pon = raw.filter((a) => a.type === "pon");
    const kan = raw.filter((a) => a.type === "kan");
    const others = raw.filter(
      (a) =>
        a.type !== "chi" &&
        a.type !== "pon" &&
        a.type !== "kan" &&
        a.type !== "riichi"
    );
    const riichiAvailable = raw.some((a) => a.type === "riichi");

    // Clear stale expansion when its group is no longer offered.
    if (
      (this.expandedCallGroup === "chi" && chi.length === 0) ||
      (this.expandedCallGroup === "pon" && pon.length === 0) ||
      (this.expandedCallGroup === "kan" && kan.length === 0)
    ) {
      this.expandedCallGroup = null;
    }

    // Display order, right-to-left: primary win/ron sit closest to
    // the right edge, then call buttons (chi/pon/kan), then
    // riichi, finally pass on the far left.
    type Entry =
      | { kind: "action"; action: LegalAction }
      | { kind: "group"; group: "chi" | "pon" | "kan"; actions: LegalAction[] }
      | { kind: "riichi" };
    const entries: Entry[] = [];
    const others_pass = others.filter((a) => a.type === "pass");
    const others_main = others.filter((a) => a.type !== "pass");
    for (const a of others_pass) {
      entries.push({ kind: "action", action: a });
    }
    if (riichiAvailable) {
      entries.push({ kind: "riichi" });
    }
    if (chi.length === 1) {
      entries.push({ kind: "action", action: chi[0] });
    } else if (chi.length > 1) {
      entries.push({ kind: "group", group: "chi", actions: chi });
    }
    if (pon.length === 1) {
      entries.push({ kind: "action", action: pon[0] });
    } else if (pon.length > 1) {
      entries.push({ kind: "group", group: "pon", actions: pon });
    }
    if (kan.length === 1) {
      entries.push({ kind: "action", action: kan[0] });
    } else if (kan.length > 1) {
      entries.push({ kind: "group", group: "kan", actions: kan });
    }
    for (const a of others_main) {
      entries.push({ kind: "action", action: a });
    }

    if (entries.length === 0) {
      return;
    }

    // Big, right-anchored strip in the empty zone between the
    // central wall and the right-side discard pond. Right edge
    // hugs the inside of the green felt so the buttons never
    // bleed into the dark canvas margin.
    const BTN_H = 64;
    const BTN_GAP = 14;
    const felt = this.feltBoxDesign;
    if (!felt) {
      return;
    }
    const RIGHT_EDGE = felt.x + felt.w - 16;
    const BASE_Y = felt.y + felt.h - 240;

    const strip = new Container();
    // Walls set `wallContainer.zIndex` up to 2 via the root's
    // sortable-children mode — bump the button strip well above
    // that so the call buttons aren't obscured by the wall in
    // front of seat 0.
    strip.zIndex = 50;

    // First pass: build buttons + measure.
    const rendered: Array<{ c: Container; w: number }> = [];
    for (const entry of entries) {
      if (entry.kind === "riichi") {
        rendered.push(this.drawRiichiToggleButton(BTN_H));
      } else if (entry.kind === "group") {
        rendered.push(
          this.drawCallGroupButton(entry.group, entry.actions.length, BTN_H)
        );
      } else {
        rendered.push(this.drawActionButton(entry.action, BTN_H));
      }
    }
    const totalW =
      rendered.reduce((acc, r) => acc + r.w, 0) +
      BTN_GAP * (rendered.length - 1);
    let x = RIGHT_EDGE - totalW;
    rendered.forEach(({ c, w }) => {
      c.position.set(x, BASE_Y);
      strip.addChild(c);
      x += w + BTN_GAP;
    });

    // Expanded option row — drawn ABOVE the group row, anchored to
    // the right edge as well. Each option is a wide tile-preview
    // button using the `bottomSmall` sheet.
    if (this.expandedCallGroup) {
      const opts =
        this.expandedCallGroup === "chi"
          ? chi
          : this.expandedCallGroup === "pon"
            ? pon
            : kan;
      if (opts.length > 0) {
        const OPT_GAP = 12;
        const optRendered: Array<{ c: Container; w: number }> = [];
        for (const a of opts) {
          optRendered.push(this.drawCallOptionButton(a, BTN_H));
        }
        const optTotal =
          optRendered.reduce((acc, r) => acc + r.w, 0) +
          OPT_GAP * (optRendered.length - 1);
        let ox = RIGHT_EDGE - optTotal;
        const optY = BASE_Y - BTN_H - 14;
        optRendered.forEach(({ c, w }) => {
          c.position.set(ox, optY);
          strip.addChild(c);
          ox += w + OPT_GAP;
        });
      }
    }

    this.root.addChild(strip);
  }

  /**
   * "Riichi" toggle button. Clicking it flips `riichiMode`; the
   * next render then dims non-riichi-legal tiles and routes hand
   * clicks to the matching `riichi:TILE` legal action.
   */
  private drawRiichiToggleButton(height = 44): {
    c: Container;
    w: number;
  } {
    const labelStyle = new TextStyle({
      fontFamily: "Inter, system-ui, sans-serif",
      fontSize: Math.round(height * 0.42),
      fontWeight: "700",
      fill: 0xffffff,
    });
    const active = this.riichiMode;
    const text = active ? "Cancel" : "Riichi";
    const labelNode = new Text({ text, style: labelStyle });
    const padX = 22;
    const width = Math.max(110, labelNode.width + padX * 2);
    const bg = new Graphics()
      .roundRect(0, 0, width, height, 10)
      .fill({ color: active ? 0xe0c060 : 0xc0a040 });
    labelNode.anchor.set(0.5);
    labelNode.position.set(width / 2, height / 2);
    const c = new Container();
    c.addChild(bg, labelNode);
    c.eventMode = "static";
    c.cursor = "pointer";
    c.on("pointerdown", (event) => {
      if (event.button === 2) {
        return;
      }
      this.riichiMode = !this.riichiMode;
      this.requestRender();
    });
    return { c, w: width };
  }

  /**
   * Collapsed call-group button (Chi/Pon/Kan with > 1 options).
   * Shows the label + a `▾` chevron; clicking toggles the
   * expansion row so the player can pick a specific tile combo.
   */
  private drawCallGroupButton(
    group: "chi" | "pon" | "kan",
    optionCount: number,
    height = 64
  ): { c: Container; w: number } {
    const palette: Record<typeof group, ColorSource> = {
      chi: 0x4a7fb4,
      pon: 0xb47f3a,
      kan: 0x7a4ab4,
    };
    const labelStyle = new TextStyle({
      fontFamily: "Inter, system-ui, sans-serif",
      fontSize: Math.round(height * 0.42),
      fontWeight: "700",
      fill: 0xffffff,
    });
    const active = this.expandedCallGroup === group;
    const labelText = group === "chi" ? "Chi" : group === "pon" ? "Pon" : "Kan";
    const text = `${labelText} ${active ? "▴" : "▾"}`;
    const labelNode = new Text({ text, style: labelStyle });
    const padX = 22;
    const width = Math.max(120, labelNode.width + padX * 2);
    const fillColor = palette[group];
    const bg = new Graphics()
      .roundRect(0, 0, width, height, 10)
      .fill({ color: fillColor });
    if (active) {
      bg.roundRect(0, 0, width, height, 10).stroke({
        color: 0xffffff,
        width: 3,
      });
    }
    labelNode.anchor.set(0.5);
    labelNode.position.set(width / 2, height / 2);
    const c = new Container();
    c.addChild(bg, labelNode);
    c.eventMode = "static";
    c.cursor = "pointer";
    // Track which group's expansion this button toggles; ignored
    // by lint via the parameter usage above.
    void optionCount;
    c.on("pointerdown", (event) => {
      if (event.button === 2) {
        return;
      }
      this.expandedCallGroup = active ? null : group;
      this.requestRender();
    });
    return { c, w: width };
  }

  /**
   * Tile-preview button used inside the expanded call-options row.
   * Renders the meld's tiles (caller-contributed + called tile)
   * using the `bottomSmall` sprite sheet, sized to fit the strip
   * height. Clicking dispatches the underlying `LegalAction`.
   */
  private drawCallOptionButton(
    action: LegalAction,
    height = 64
  ): { c: Container; w: number } {
    // Compose the visible meld:
    //   chi / pon / daiminkan: caller's tiles + called tile (from
    //                          the discard)
    //   ankan:                 4 same tiles (no called tile)
    //   shouminkan:            single tile being added on top of
    //                          an existing pon
    const previewTiles: string[] = [];
    if (action.tiles) {
      previewTiles.push(...action.tiles);
    }
    if (
      action.tile &&
      action.kanKind !== "ankan" &&
      action.kanKind !== "shouminkan"
    ) {
      previewTiles.push(action.tile);
    }
    // Sort by mahjong rank rather than tile-string lexicography so
    // red fives sit between a normal five and six instead of before one.
    previewTiles.splice(
      0,
      previewTiles.length,
      ...sortTilesForDisplay(previewTiles)
    );

    const tileH = height - 12;
    const tileW = (tileH * SMALL_TILE_W) / SMALL_TILE_H;
    const tileGap = 2;
    const padX = 12;
    const width =
      padX * 2 +
      previewTiles.length * tileW +
      tileGap * Math.max(0, previewTiles.length - 1);

    const palette: Record<string, ColorSource> = {
      chi: 0x4a7fb4,
      pon: 0xb47f3a,
      kan: 0x7a4ab4,
    };
    const bg = new Graphics()
      .roundRect(0, 0, width, height, 10)
      .fill({ color: palette[action.type] ?? 0x666666 });

    const c = new Container();
    c.addChild(bg);

    let tx = padX;
    const ty = (height - tileH) / 2;
    for (const tile of previewTiles) {
      const sprite = new Sprite(this.getTileTexture("bottomSmall", tile));
      sprite.width = tileW;
      sprite.height = tileH;
      sprite.position.set(tx, ty);
      c.addChild(sprite);
      tx += tileW + tileGap;
    }

    c.eventMode = "static";
    c.cursor = "pointer";
    c.on("pointerdown", (event) => {
      if (event.button === 2) {
        return;
      }
      this.expandedCallGroup = null;
      if (this.onActionClick) {
        this.onActionClick({ action });
      }
    });
    return { c, w: width };
  }

  private drawActionButton(
    action: LegalAction,
    height = 44
  ): { c: Container; w: number } {
    const labelStyle = new TextStyle({
      fontFamily: "Inter, system-ui, sans-serif",
      fontSize: Math.round(height * 0.42),
      fontWeight: "700",
      fill: 0xffffff,
    });
    const palette: Record<string, ColorSource> = {
      chi: 0x4a7fb4,
      pon: 0xb47f3a,
      kan: 0x7a4ab4,
      ron: 0xc04040,
      tsumo: 0x40a060,
      pass: 0x444444,
      win: 0x40a060,
      riichi: 0xc0a040,
    };
    // Single-option chi/pon/kan: shorten the label to just the
    // group name (the discarded tile is already obvious on the
    // table). Other action types keep their full label.
    let text: string;
    if (action.type === "chi") {
      text = "Chi";
    } else if (action.type === "pon") {
      text = "Pon";
    } else if (action.type === "kan") {
      text = "Kan";
    } else {
      text = labelForAction(action);
    }
    const labelNode = new Text({ text, style: labelStyle });
    const padX = 22;
    const width = Math.max(110, labelNode.width + padX * 2);
    const bg = new Graphics()
      .roundRect(0, 0, width, height, 10)
      .fill({ color: palette[action.type] ?? 0x666666 });
    labelNode.anchor.set(0.5);
    labelNode.position.set(width / 2, height / 2);
    const c = new Container();
    c.addChild(bg, labelNode);
    c.eventMode = "static";
    c.cursor = "pointer";
    c.on("pointerdown", (event) => {
      if (event.button === 2) {
        return;
      }
      if (this.onActionClick) {
        this.onActionClick({ action });
      }
    });
    return { c, w: width };
  }

  /**
   * Face-up tile container for a meld in the given seat's strip.
   *
   * The sprite is sized so its on-screen footprint matches the
   * seat's discard tile dimensions:
   *   - bottom/top (seats 0/2): SMALL_TILE_W × SMALL_TILE_H on screen
   *   - side       (seats 1/3): 58 × (58 × 107/116) on screen
   *
   * In meld-strip local space, +x is the row's reading direction.
   * The sprite's local width is therefore the discard tile's
   * cross-axis screen size (i.e. screen height after container
   * rotation), and the local height is the long-axis screen size.
   */
  private drawMeldTile(
    tile: string | null,
    seat: number,
    sheetOverride?: SheetKey
  ): {
    node: Container;
    offX: number;
    offY: number;
    footW: number;
    footH: number;
  } {
    // When using an override sheet (tilted called tile), size the
    // tile to match the override-seat's discard dimensions so the
    // sprite preserves its source proportions.
    const sheetSeatBySheet: Record<SheetKey, number> = {
      bottomSmall: 0,
      rightSmall: 1,
      topSmall: 2,
      leftSmall: 3,
      ownHand: 0,
      sideHandL: 3,
      sideHandR: 1,
    };
    const dimsSeat = sheetOverride ? sheetSeatBySheet[sheetOverride] : seat;
    const dims = meldTileDims(this.tileDesign, dimsSeat);
    // Sheets come from the active design; face-down (ankan outer)
    // tiles read the back-sheet map. Casts are safe: the design's
    // atlas ids are exactly the legacy sheet keys.
    const sheet =
      sheetOverride ??
      ((tile === null
        ? this.tileDesign.sheets.meldFaceDown[seat as Seat]
        : this.tileDesign.sheets.meld[seat as Seat]) as SheetKey);
    const tex = this.getTileTexture(sheet, tile);
    const c = new Container();
    const sprite = new Sprite(tex);
    sprite.anchor.set(0.5, 0.5);
    this.tintIfWait(sprite, tile);
    // Counter-rotate the sprite by the strip's container rotation
    // so the per-seat pre-rotated source displays in its natural
    // orientation in screen space (just like discards). Pre-
    // rotation sprite dims are chosen so the post-rotation
    // footprint equals dims.w × dims.h.
    const stripRot = [0, -Math.PI / 2, Math.PI, Math.PI / 2][seat];
    // Pre-rotation sprite dims must be chosen so that after the
    // total rotation the screen footprint equals dims.w × dims.h.
    // Without an override, total rotation = -stripRot (axes swap
    // for seats 1/3). With the tilted override we add an extra
    // +π/2, which flips which seats need the swap (seats 0/2).
    const swapAxes = sheetOverride
      ? seat === 0 || seat === 2
      : seat === 1 || seat === 3;
    if (swapAxes) {
      sprite.width = dims.h;
      sprite.height = dims.w;
    } else {
      sprite.width = dims.w;
      sprite.height = dims.h;
    }
    sprite.rotation = -stripRot + (sheetOverride ? Math.PI / 2 : 0);
    sprite.position.set(dims.w / 2, dims.h / 2);
    c.addChild(sprite);
    // Screen footprint + tile-centre offset (folding in the caller's
    // -90° tilt for called tiles) so the meld can bucket its tiles
    // into screen-columns for the shadow pass.
    const tiltRot = sheetOverride ? -Math.PI / 2 : 0;
    const tc = Math.cos(tiltRot);
    const tsin = Math.sin(tiltRot);
    return {
      node: c,
      offX: (dims.w / 2) * tc - (dims.h / 2) * tsin,
      offY: (dims.w / 2) * tsin + (dims.h / 2) * tc,
      footW: sprite.width,
      footH: sprite.height,
    };
  }

  /**
   * Build (or fetch from cache) the sub-texture for a single tile
   * on a given sheet. For single-tile sheets the `tile` argument
   * is ignored. Delegates to the texture store; atlas ids match the
   * legacy sheet keys.
   */
  private getTileTexture(sheet: SheetKey, tile: string | null): Texture {
    if (!this.textureStore) {
      // mount() loads the store before this.root is created, so any
      // render after mount must find it present.
      throw new Error("TableRenderer: texture store not loaded");
    }
    return this.textureStore.getTexture(sheet, tile);
  }
}

export function pointInsideRect(
  point: { x: number; y: number },
  rect: { x: number; y: number; w: number; h: number }
): boolean {
  return (
    point.x >= rect.x &&
    point.x <= rect.x + rect.w &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.h
  );
}

const SUIT_ORDER: Record<string, number> = { m: 0, p: 1, s: 2, z: 3 }; /**
 * Sort key for a single tile string. Suits ordered m → p → s → z; within
 * a suit, ascending by number. Red fives (`0m`/`0p`/`0s`) sort immediately
 * after the regular five and before six.
 */
function tileSortKey(tile: string): number {
  const suit = tile[tile.length - 1];
  const n = Number(tile.slice(0, -1));
  const suitWeight = (SUIT_ORDER[suit] ?? 9) * 100;
  // 0 (red five) → 5.5 so it sorts after the plain 5 and before 6.
  const numWeight = n === 0 ? 5.5 : n;
  return suitWeight + numWeight;
}

export function sortTilesForDisplay(tiles: readonly string[]): string[] {
  return [...tiles].sort((a, b) => tileSortKey(a) - tileSortKey(b));
}

export function ankanTilesForDisplay(tiles: readonly string[]): string[] {
  const ordered = sortTilesForDisplay(tiles);
  const redIndex = ordered.findIndex((tile) => /^0[mps]$/.test(tile));
  if (redIndex < 0 || ordered.length < 3) {
    return ordered;
  }
  const [redFive] = ordered.splice(redIndex, 1);
  ordered.splice(1, 0, redFive);
  return ordered;
}

/**
 * Display-only sort. Preserves nulls (opponent tiles) by leaving the
 * input untouched when any element is `null`. When `isFreshlyDrawn`
 * is true the last tile is treated as the just-drawn tile and held
 * out on the right; the leading tiles are sorted. The caller is
 * expected to derive `isFreshlyDrawn` from `view.freshlyDrawnSeat`
 * (set by the reducer on `draw`, cleared on `discard` / `call` /
 * `hand_start`). Hand length alone can't distinguish a freshly
 * drawn hand from a post-call "must-discard" hand — both can be
 * length (== 2 mod 3).
 */
function sortHand(
  hand: Array<string | null>,
  isFreshlyDrawn: boolean
): Array<string | null> {
  if (hand.some((t) => t === null)) {
    return hand;
  }
  const tiles = hand as string[];
  if (isFreshlyDrawn && tiles.length >= 2) {
    const closed = tiles.slice(0, tiles.length - 1);
    const drawn = tiles[tiles.length - 1];
    closed.sort((a, b) => tileSortKey(a) - tileSortKey(b));
    return [...closed, drawn];
  }
  return [...tiles].sort((a, b) => tileSortKey(a) - tileSortKey(b));
}

/**
 * Human label for a non-discard legal action. Phase 0.5: just the
 * action kind capitalised, plus a hint for chi shapes (`Chi 4·6` to
 * distinguish the three possible runs).
 */
function labelForAction(action: LegalAction): string {
  if (action.type === "chi" && action.tiles) {
    const a = action.tiles[0];
    const b = action.tiles[1];
    return `Chi ${tileNum(a)}·${tileNum(b)}`;
  }
  if (action.type === "kan") {
    if (action.kanKind === "ankan") {
      const t = action.tiles?.[0];
      return t ? `Ankan ${tileNum(t)}` : "Ankan";
    }
    if (action.kanKind === "shouminkan") {
      const t = action.tiles?.[0];
      return t ? `Shouminkan ${tileNum(t)}` : "Shouminkan";
    }
    return "Kan";
  }
  if (action.type === "pon") {
    return "Pon";
  }
  if (action.type === "ron") {
    return "Ron";
  }
  if (action.type === "tsumo") {
    return "Tsumo";
  }
  if (action.type === "pass") {
    return "Pass";
  }
  if (action.type === "riichi") {
    return "Riichi";
  }
  if (action.type === "win") {
    return "Win";
  }
  return action.type;
}

function tileNum(tile: string): string {
  if (tile === "0m" || tile === "0p" || tile === "0s") {
    return "5";
  }
  if (tile.endsWith("z")) {
    return tile;
  }
  return tile.slice(0, -1);
}
