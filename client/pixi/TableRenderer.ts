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
  Rectangle,
  Sprite,
  Text,
  Texture,
  TextStyle,
  type ColorSource,
} from "pixi.js";
import type { MatchView } from "../store";
import type { LegalAction, Meld } from "~/game/protocol/messages";
import { computeTableLayout, type TableLayout, type Rect } from "./tableLayout";
import ownHandUrl from "~/game/tenhouSprites/ownHand.png";
import bottomSmallUrl from "~/game/tenhouSprites/bottomSmall.png";
import topSmallUrl from "~/game/tenhouSprites/topSmall.png";
import leftSmallUrl from "~/game/tenhouSprites/leftSmall.png";
import rightSmallUrl from "~/game/tenhouSprites/rightSmall.png";
import sideHandLUrl from "~/game/tenhouSprites/uprightSideHandL.png";
import sideHandRUrl from "~/game/tenhouSprites/uprightSideHandR.png";

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
const BIG_TILE_SCALE = 0.51;
const BIG_TILE_W = BIG_TILE_SRC.w * BIG_TILE_SCALE;
const BIG_TILE_H = BIG_TILE_SRC.h * BIG_TILE_SCALE;
const HAND_PAD = 24;

// Per-tile overlap along the row direction inside a discard pond.
// Used both by `renderDiscards` and (when `showHands` reveals a side
// hand) by the side-hand layout so a flipped-up opponent hand strides
// identically to that seat's discard row.
const DISCARD_ROW_OVERLAP_HORIZ = 14.5;
const DISCARD_ROW_OVERLAP_VERT = 15;
/**
 * Distance from the table center to the inner edge of each discard
 * pile. Bumped up so the four piles don't crowd / overlap in the
 * middle of the table. (Original 80 left tiles of seats 0/2 kissing
 * the side rows of seats 1/3.)
 */
const DESIGN_W = 1280;
const DESIGN_H = 800;

/** Visual separation in design pixels between the just-drawn 14th
 * tile and the sorted 13-tile run. 0.8% of the 1000 px design
 * width. */
const TSUMO_GAP = 8;

const BG_COLOR: ColorSource = 0x2a2a2a;
const FELT_COLOR: ColorSource = 0x0d4d2c;

/** Axis-aligned bounding box of a non-empty list of `Rect`s. */
function boundingBox(rects: readonly Rect[]): Rect {
  const x0 = Math.min(...rects.map((r) => r.x));
  const y0 = Math.min(...rects.map((r) => r.y));
  const x1 = Math.max(...rects.map((r) => r.x + r.w));
  const y1 = Math.max(...rects.map((r) => r.y + r.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

const hudStyle = new TextStyle({
  fontFamily: "Inter, system-ui, sans-serif",
  fontSize: 14,
  fill: 0xffffff,
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

const SHEET_URLS: Record<SheetKey, string> = {
  ownHand: ownHandUrl,
  bottomSmall: bottomSmallUrl,
  topSmall: topSmallUrl,
  leftSmall: leftSmallUrl,
  rightSmall: rightSmallUrl,
  sideHandL: sideHandLUrl,
  sideHandR: sideHandRUrl,
};

const MULTI_TILE_SHEET_COLS = 10;
const MULTI_TILE_SHEET_ROWS = 4;

/** Which sheets are multi-tile grids vs single-tile images. */
const IS_MULTI_TILE: Record<SheetKey, boolean> = {
  ownHand: true,
  bottomSmall: true,
  topSmall: true,
  leftSmall: true,
  rightSmall: true,
  sideHandL: false,
  sideHandR: false,
};

/**
 * Locate a tile in a 10×4 sheet. Returns `(row, col)` in cell
 * coordinates.
 *
 *   row 0 = manzu (col 0 = 0m / aka 5m)
 *   row 1 = pinzu
 *   row 2 = souzu
 *   row 3 = honors (col 0 = back, 1–7 = 1z–7z)
 *
 * Returns `(3, 0)` for `null` (face-down) or unknown tiles.
 */
function tileSheetCell(tile: string | null): { row: number; col: number } {
  if (tile === null) {
    return { row: 3, col: 0 };
  }
  const suit = tile[tile.length - 1];
  const n = Number(tile.slice(0, -1));
  if (suit === "m") {
    return { row: 0, col: n };
  }
  if (suit === "p") {
    return { row: 1, col: n };
  }
  if (suit === "s") {
    return { row: 2, col: n };
  }
  if (suit === "z") {
    return { row: 3, col: n };
  }
  return { row: 3, col: 0 };
}

export interface TileClick {
  seat: number;
  index: number;
  /** Tile string for the clicked tile (own seat only — opponents are redacted). */
  tile: string;
}

export interface ActionClick {
  action: LegalAction;
}

export class TableRenderer {
  private app: Application | null = null;
  private root: Container | null = null;
  private hudText: Text | null = null;
  private onTileClick: ((click: TileClick) => void) | null = null;
  private onActionClick: ((click: ActionClick) => void) | null = null;
  /** Optional callback fired when the renderer's internal UI state
   * changes (e.g. riichi mode toggle) and a re-render is needed.
   * The host (match route) wires this to `renderer.render(state)`. */
  private onRenderRequest: (() => void) | null = null;
  /**
   * When true, seat 0 has entered the "select riichi tile" UI mode
   * (toggled by the Riichi button). Only tiles backed by a
   * `riichi:TILE` legal action are clickable; clicking sends the
   * matching action id instead of a discard. Cleared automatically
   * when the seat's legal actions no longer include any riichi
   * options (e.g. after the riichi declaration is confirmed).
   */
  private riichiMode = false;
  /** When true, paint the colored layout regions on top of the
   * normal table (debug aid while migrating to the Tenhou-style
   * layout). Toggled via {@link setShowLayoutDebug}. */
  private showLayoutDebug = false;
  /** Replay-viewer overlay toggles. The renderer is render-pure
   * (no internal animation loop), so toggles take effect on the
   * next `render()` call. Defaults match `defaultReplayOverlayState`
   * in `ReplayOverlayPanel`. */
  private showWaits = false;
  private showHands = false;
  private showWalls = false;
  private showNames = true;
  /** When false, the post-hand win-info panel and the match-end
   * standings panel are skipped during `render()`. Used by the
   * "hide hand result" eye button next to the panel so reviewers
   * can peek at the board state underneath the overlay. */
  private showHandResult = true;
  /** Callback invoked at the end of every `render()` with the
   * canvas-pixel rect of the currently-visible result panel
   * (win-info inner zone or match-end standings panel), or
   * `null` when no panel is showing. The React layer uses this
   * to anchor the "hide hand result" eye button to the right
   * edge of the panel. */
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
  /** Per-sheet loaded textures, keyed by sheet name. Populated in
   * `mount()`. */
  private sheets = new Map<
    SheetKey,
    { texture: Texture; cellW: number; cellH: number }
  >();
  /** Per-tile sub-textures, keyed by `"sheet:row:col"`. Lazily
   * built by `getTileTexture`. */
  private tileTextures = new Map<string, Texture>();

  async mount(container: HTMLElement): Promise<void> {
    const app = new Application();
    await app.init({
      width: DESIGN_W,
      height: DESIGN_H,
      background: BG_COLOR,
      antialias: true,
      roundPixels: true,
      resolution: window.devicePixelRatio || 1,
      autoDensity: true,
      resizeTo: container,
    });
    container.appendChild(app.canvas);
    this.app = app;

    // Load every tile spritesheet in parallel. Each multi-tile
    // sheet's cell dimensions are derived from its natural size;
    // single-tile sheets store the full image dims so callers can
    // size sprites uniformly.
    const keys = Object.keys(SHEET_URLS) as SheetKey[];
    const loaded = await Promise.all(
      keys.map(async (key) => {
        const tex = (await Assets.load(SHEET_URLS[key])) as Texture;
        return [key, tex] as const;
      })
    );
    for (const [key, tex] of loaded) {
      const isMulti = IS_MULTI_TILE[key];
      const cellW = isMulti ? tex.width / MULTI_TILE_SHEET_COLS : tex.width;
      const cellH = isMulti ? tex.height / MULTI_TILE_SHEET_ROWS : tex.height;
      this.sheets.set(key, { texture: tex, cellW, cellH });
    }

    const root = new Container();
    app.stage.addChild(root);
    this.root = root;

    const hud = new Text({ text: "", style: hudStyle });
    hud.position.set(16, 16);
    app.stage.addChild(hud);
    this.hudText = hud;

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
          if (this.onRenderRequest) {
            this.onRenderRequest();
          }
        });
      });
      this.resizeObserver.observe(container);
    }
  }

  setOnTileClick(handler: (click: TileClick) => void): void {
    this.onTileClick = handler;
  }

  setOnActionClick(handler: (click: ActionClick) => void): void {
    this.onActionClick = handler;
  }

  setOnRenderRequest(handler: () => void): void {
    this.onRenderRequest = handler;
  }

  /** Toggle the colored-region debug overlay. */
  setShowLayoutDebug(flag: boolean): void {
    this.showLayoutDebug = flag;
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

  /** Render seat display names alongside the score chips. */
  setShowNames(flag: boolean): void {
    this.showNames = flag;
  }

  /** Hide / show the post-hand win-info panel and the match-end
   * standings panel. Defaults to true. */
  setShowHandResult(flag: boolean): void {
    this.showHandResult = flag;
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

  destroy(): void {
    if (this.resizeRafHandle !== null) {
      cancelAnimationFrame(this.resizeRafHandle);
      this.resizeRafHandle = null;
    }
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
    if (this.app) {
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
  }

  /** Re-render the entire table for the given view. Cheap enough at Phase 0.5 scale. */
  render(view: MatchView): void {
    if (!this.app || !this.root || !this.hudText) {
      return;
    }
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
    // Scale the design-space root (DESIGN_W × DESIGN_H) so it fits
    // inside the current canvas while preserving aspect ratio. The
    // root is centered within whichever axis has slack. `resizeTo:
    // container` keeps the canvas sized to its parent, so this
    // effectively makes every asset scale with the window.
    const screenW = this.app.screen.width;
    const screenH = this.app.screen.height;

    // Compute the Tenhou-style layout. Its natural footprint is
    // square; we scale it to fit the canvas. Step 1 of the layout
    // migration: scaling uses the layout's `table` rect; the legacy
    // DESIGN_W / DESIGN_H constants are still consumed by the
    // not-yet-migrated render passes (renderSeat / renderScores /
    // etc.), so the on-screen positions there don't shift yet. The
    // colored debug overlay sits on top and paints the new regions.
    const layout = computeTableLayout(DESIGN_W, DESIGN_H);
    const scale = Math.min(screenW / layout.table.w, screenH / layout.table.h);
    this.root.scale.set(scale);
    this.root.position.set(
      (screenW - layout.table.w * scale) / 2,
      (screenH - layout.table.h * scale) / 2
    );
    const root = this.root;
    root.removeChildren();

    // Felt: paint the central tile-bearing region (bounding box of
    // the four wall bands plus the four player hands) in classic
    // mahjong green so the play area still reads as "felt", while
    // the canvas background around the player-info chips stays
    // neutral dark gray.
    const feltBox = boundingBox([...layout.wall, ...layout.hands]);
    root.addChild(
      new Graphics().rect(feltBox.x, feltBox.y, feltBox.w, feltBox.h).fill({
        color: FELT_COLOR,
      })
    );

    // Legacy render passes anchor on DESIGN_W/2, DESIGN_H/2. The
    // layout's centre may not coincide with that point, so passes
    // not yet migrated will be visually off-centre relative to the
    // new regions — expected during the step-by-step migration.
    const cx = layout.center.x + layout.center.w / 2;
    const cy = layout.center.y + layout.center.h / 2;

    if (this.showLayoutDebug) {
      this.renderLayoutDebug(layout);
    }

    // Seat 0 (bottom — `you`), 1 (right), 2 (top), 3 (left)
    for (let seat = 0; seat < 4; seat++) {
      this.renderSeat(view, seat, cx, cy, layout);
    }

    // Per-seat score chips + dealer marker.
    this.renderScores(view, layout.center);
    // Per-seat display names next to each discard pond.
    this.renderPlayerNames(view, layout);
    // Round / honba / sticks / wall-remaining centre block.
    this.renderRoundInfo(view, layout.center);
    // Wall stacks + dora indicators around the centre.
    this.renderWalls(view, layout);

    // HUD — only meaningful on live matches; suppressed for replays
    // (no WS, no seq, no meaningful conn status). Wall count is
    // inferred from `liveDrawsTaken` (draws off the live wall,
    // excluding rinshan) rather than the server's authoritative
    // `wallRemaining` field.
    const conn = view.conn;
    const wall = Math.max(0, 70 - view.liveDrawsTaken);
    const seq = view.lastSeq;
    if (conn === "replay") {
      this.hudText.text = "";
    } else {
      this.hudText.text = `conn: ${conn}   wall: ${wall}   seq: ${seq}`;
    }

    // Call / action buttons (chi/pon/kan/ron/pass). Discard-style
    // legals stay tile-driven; only "decision" actions surface here.
    this.renderActionButtons(view, cx);

    // Hand-result panel — shown after a hand ends and stays up
    // until the next `hand_start` clears `lastHandResult`. Both
    // panels honour the `showHandResult` toggle so the eye
    // button next to them can hide the overlay on press.
    let designRect: { x: number; y: number; w: number; h: number } | null =
      null;
    if (this.showHandResult) {
      if (view.lastHandResult && !view.matchEnded) {
        designRect = this.renderHandResult(view, cx, cy, layout);
      }
      if (view.matchEnded) {
        designRect = this.renderMatchEnd(view, cx, cy);
      }
    }

    // Publish the result-panel bounds (in canvas pixels) so the
    // React layer can anchor the "hide hand result" eye button to
    // its right edge. The fit transform applied to `this.root`
    // earlier in this method is mirrored here. We dedupe against
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
  }

  // -------------------------------------------------------------------------
  // Score / round / result overlays
  // -------------------------------------------------------------------------

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
    const chipW = Math.round(center.w * 0.5);
    const chipH = Math.round(center.h * 0.16);
    const inset = Math.round(center.h * 0.08);
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
      const isDealer = view.dealer === seat;
      const chip = new Container();
      const bg = new Graphics()
        .roundRect(-chipW / 2, -chipH / 2, chipW, chipH, 6)
        .fill({ color: isDealer ? 0xb88a2e : 0x000000, alpha: 0.7 });
      const txt = new Text({
        text: `${view.scores[seat]}`,
        style: new TextStyle({
          fontFamily: "Inter, system-ui, sans-serif",
          fontSize: Math.max(12, Math.round(chipH * 0.6)),
          fontWeight: "700",
          fill: 0xffffff,
        }),
      });
      txt.anchor.set(0.5, 0.5);
      chip.addChild(bg, txt);
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
    const label = `${view.roundWind}${view.roundNumber}`;
    const fontSize = Math.max(14, Math.round(center.h * 0.13));
    const heading = new Text({
      text: label,
      style: new TextStyle({
        fontFamily: "Inter, system-ui, sans-serif",
        fontSize,
        fontWeight: "700",
        fill: 0xffffff,
      }),
    });
    heading.anchor.set(0.5, 0.5);
    // Three small status lines below the heading: honba counters,
    // riichi sticks, and wall remaining. Stacked vertically.
    const lineSize = Math.max(10, Math.round(center.h * 0.085));
    const lineGap = Math.round(lineSize * 0.25);
    // Wall count is inferred from `liveDrawsTaken` (draws off
    // the live wall, excluding rinshan replacement draws) rather
    // than reading the server's authoritative `wallRemaining`
    // field — the live wall starts at 70 tiles after the deal.
    const wallRemaining = Math.max(0, 70 - view.liveDrawsTaken);
    const lineSpecs: Array<{ text: string; color: number }> = [
      { text: `本 ${view.honba}`, color: 0xfde68a },
      { text: `供 ${view.riichiSticks}`, color: 0xfca5a5 },
      { text: `山 ${wallRemaining}`, color: 0xd1d5db },
    ];
    // Vertically centre the whole block (heading + 3 lines + gaps)
    // on the centre rect.
    const linesBlockH =
      lineSpecs.length * lineSize + (lineSpecs.length - 1) * lineGap;
    const headingGap = Math.round(lineSize * 0.6);
    const totalH = fontSize + headingGap + linesBlockH;
    const topY = cy - totalH / 2;
    heading.position.set(cx, topY + fontSize / 2);
    this.root.addChild(heading);
    let lineY = topY + fontSize + headingGap + lineSize / 2;
    for (const spec of lineSpecs) {
      const t = new Text({
        text: spec.text,
        style: new TextStyle({
          fontFamily: "Inter, system-ui, sans-serif",
          fontSize: lineSize,
          fontWeight: "600",
          fill: spec.color,
        }),
      });
      t.anchor.set(0.5, 0.5);
      t.position.set(cx, lineY);
      this.root.addChild(t);
      lineY += lineSize + lineGap;
    }
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
    const padX = 8;
    const padY = 4;
    const gap = 26;
    // Shift each label toward the table centre along the seat's
    // player-up axis (screen-up for seat 0, etc.).
    const centerShift = 15;
    for (let seat = 0; seat < 4; seat++) {
      const name = view.seatNames[seat];
      if (!name) {
        continue;
      }
      const rect = layout.discards[seat];
      const container = new Container();
      const txt = new Text({
        text: name,
        style: new TextStyle({
          fontFamily: "Inter, system-ui, sans-serif",
          fontSize,
          fontWeight: "600",
          fill: 0xffffff,
        }),
      });
      txt.anchor.set(0.5, 0.5);
      const w = Math.ceil(txt.width) + padX * 2;
      const h = Math.ceil(txt.height) + padY * 2;
      const bg = new Graphics()
        .roundRect(-w / 2, -h / 2, w, h, 4)
        .fill({ color: 0x000000, alpha: 0.65 })
        .stroke({ color: 0xffffff, width: 1, alpha: 0.25 });
      container.addChild(bg, txt);
      // Place the label adjacent to the discard rect on the
      // player's right-hand side. Discard local +x points to the
      // player's right; the seat's screen-side mapping is:
      //   seat 0 (bottom, no rotation) → right edge of rect
      //   seat 1 (right, -90°)         → top edge of rect
      //   seat 2 (top, 180°)           → left edge of rect
      //   seat 3 (left, +90°)          → bottom edge of rect
      switch (seat) {
        case 0: {
          container.rotation = 0;
          container.position.set(
            rect.x + rect.w + gap + w / 2,
            rect.y + rect.h / 2 - centerShift
          );
          break;
        }
        case 1: {
          container.rotation = -Math.PI / 2;
          container.position.set(
            rect.x + rect.w / 2 - centerShift,
            rect.y - gap - w / 2
          );
          break;
        }
        case 2: {
          container.rotation = Math.PI;
          container.position.set(
            rect.x - gap - w / 2,
            rect.y + rect.h / 2 + centerShift
          );
          break;
        }
        case 3: {
          container.rotation = Math.PI / 2;
          container.position.set(
            rect.x + rect.w / 2 + centerShift,
            rect.y + rect.h + gap + w / 2
          );
          break;
        }
      }
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
    // 16-px vertical (screen-y) offset of the upper stack tile
    // relative to the lower stack tile. Applied uniformly to every
    // wall (consequence: top/bottom walls show two visible rows of
    // tiles separated by 16 px in screen-y; left/right walls show
    // each upper-stack tile peeking out 16 px above its lower-stack
    // partner).
    const ROW_OFFSET_Y = 16;
    // 16-px overlap between consecutive tiles along the long axis,
    // applied only on vertical (left/right) walls.
    const SIDE_TILE_OVERLAP = 16;
    // Cross-axis overlap between the two visible rows of a stack
    // when the `showWalls` overlay flattens the wall (both rows
    // fully drawn, stacked along the cross axis with this much
    // overlap). Matches `SIDE_TILE_OVERLAP` so the reveal layout
    // reads consistently with the long-axis stack overlap.
    const WALL_REVEAL_ROW_OVERLAP = 16;
    const SIDE_WALL_SCREEN_W = 57;
    const SIDE_WALL_ASPECT = 107 / 116;

    // Per-seat sheet for the wall back-tile (matches the discard
    // sheet for each seat). Seat 2 reuses `bottomSmall` so the
    // top wall keeps the same lighting as the bottom wall.
    // Seat 3 uses `rightSmall` because `leftSmall` doesn't have a
    // back-tile cell at (row 3, col 0); the artwork is the same
    // shape (the sprite is rotated below as needed).
    const wallBackSheets: Record<number, SheetKey> = {
      0: "bottomSmall",
      1: "rightSmall",
      2: "bottomSmall",
      3: "rightSmall",
    };
    // Per-seat sheet for face-up wall tiles. Mirrors the discard
    // sheet map: each seat uses its own pre-rotated artwork so a
    // revealed wall tile reads from the seat's natural viewing
    // direction (upside-down on the top wall, sideways on left /
    // right walls). Used when `showWalls` reveals a live tile or
    // when a dora indicator is exposed on the dead wall.
    const wallFaceSheets: Record<number, SheetKey> = {
      0: "bottomSmall",
      1: "rightSmall",
      2: "topSmall",
      3: "leftSmall",
    };

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
    const INITIAL_DEAL_TILES = 52;
    const liveDrawsConsumed = view.liveDrawsTaken ?? view.drawsTaken;
    const drawsTaken = liveDrawsConsumed + INITIAL_DEAL_TILES;
    // Number of kans declared this hand = total draws minus
    // live-wall draws (the difference is the rinshan replacement
    // draws). Each kan removes one rinshan tile from the dead
    // wall and shifts one tile from the rinshan end of the live
    // wall into the dead wall to preserve its 14-tile count.
    const kanCount = Math.max(
      0,
      Math.min(4, view.drawsTaken - liveDrawsConsumed)
    );

    for (let seat = 0; seat < 4; seat++) {
      const band = layout.wall[seat];
      const isHoriz = seat % 2 === 0;
      const tile = isHoriz ? layout.tileHorizontal : layout.tileVertical;
      const screenTileW = isHoriz ? tile.w : SIDE_WALL_SCREEN_W;
      const screenTileH = isHoriz
        ? tile.h
        : SIDE_WALL_SCREEN_W * SIDE_WALL_ASPECT;
      const tileLongDim = isHoriz ? screenTileW : screenTileH;
      const baseStride = isHoriz
        ? screenTileW + tile.gap
        : screenTileH - SIDE_TILE_OVERLAP;
      // Half-tile gap inserted at any dead↔live boundary within a
      // single band.
      const gapSize = tileLongDim / 2;

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
      const backSheet = wallBackSheets[seat];
      const faceSheet = wallFaceSheets[seat];

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
            const liveIdx = tileDrawIdx - 52;
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
          // Visual nudge: when the dead wall ends up on the right
          // wall (seat 1) it visually reads as sitting too high
          // because the rinshan-side stacks pile near the top of
          // the band. Drop those tiles 20 px so the dead-wall
          // section sits closer to mid-screen.
          const deadRightShiftY = seat === 1 && role.kind === "dead" ? 30 : 0;
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
              y =
                band.y +
                band.h -
                tileLongDim -
                longOffset +
                sideLift +
                deadRightShiftY;
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
              crossInset +
              (row === 0 ? ROW_OFFSET_Y / 2 : -ROW_OFFSET_Y / 2);
          } else if (seat === 1) {
            x = band.x + crossInset;
            y =
              band.y +
              band.h -
              tileLongDim -
              longOffset -
              (row === 1 ? ROW_OFFSET_Y : 0) +
              deadRightShiftY;
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
        }
      }

      wallContainer.zIndex = seat === 0 ? 2 : seat === 2 ? 0 : 1;
      this.root.sortableChildren = true;
      this.root.addChild(wallContainer);
    }
  }

  private renderHandResult(
    view: MatchView,
    cx: number,
    cy: number,
    layout: TableLayout
  ): { x: number; y: number; w: number; h: number } | null {
    if (!this.root) {
      return null;
    }
    const r = view.lastHandResult;
    if (!r) {
      return null;
    }
    // For wins, the upstream stream emits `win` then `hand_end`
    // as two consecutive events. Both produce a `lastHandResult`,
    // which would surface the panel twice while stepping through
    // the replay. Suppress the intermediate state: a win's panel
    // only renders once `hand_end` has filled in the deltas.
    if (r.win && !r.delta) {
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
    this.renderResultCenterInfo(r, cx, cy, overlay);

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
    parent: Container
  ): void {
    if (!this.root) {
      return;
    }
    const container = new Container();

    // Build the lines we want to render. Each entry is either a
    // single label (centered) or a yaku name + value pair.
    type Row =
      | { kind: "yaku"; name: string; value: string }
      | { kind: "title"; text: string; size: number }
      | { kind: "label"; text: string; size: number; color?: number };

    const rows: Row[] = [];

    if (r.win) {
      // Title line: "Tsumo" / "Ron"
      if (r.reason === "tsumo") {
        rows.push({ kind: "title", text: "Tsumo", size: 36 });
      } else if (r.reason === "ron") {
        rows.push({ kind: "title", text: "Ron", size: 36 });
      }
      // Yaku rows. Skip yaku whose displayed value is 0 han
      // (server may still emit them — typically dora when no dora
      // tiles are held — and they shouldn't take up a line).
      const yakuKeys = r.win.yaku ? Object.keys(r.win.yaku) : [];
      for (const name of yakuKeys) {
        const value = r.win.yaku?.[name] ?? "";
        // value is typically of the form "1 han" / "2 han"; treat
        // anything whose leading integer is 0 as zero-han.
        const leading = parseInt(value, 10);
        if (Number.isFinite(leading) && leading === 0) {
          continue;
        }
        rows.push({ kind: "yaku", name, value });
      }
      // Han/fu summary or yakuman line.
      const han = r.win.han ?? 0;
      const fu = r.win.fu ?? 0;
      const ym = r.win.yakumanCount ?? 0;
      if (ym > 0) {
        rows.push({
          kind: "label",
          text: ym > 1 ? `${ym}× Yakuman` : "Yakuman",
          size: 32,
        });
      } else {
        // From 5 han up the fu no longer affects the basic-points
        // calculation (mangan / haneman / ...), so suppress it.
        const text = han >= 5 ? `${han} han` : `${han} han ${fu} fu`;
        rows.push({ kind: "label", text, size: 32 });
      }
      // Points line. We take the value straight from the log
      // (`r.win.ten`) rather than re-computing from han/fu — the
      // server is the source of truth for scoring, which keeps the
      // display ruleset-agnostic.
      if (typeof r.win.ten === "number") {
        rows.push({
          kind: "label",
          text: `${r.win.ten}pts`,
          size: 28,
          color: 0xfde68a,
        });
      }
    } else if (r.reason === "exhaustive_draw") {
      rows.push({ kind: "title", text: "Exhaustive draw", size: 32 });
    } else if (r.reason === "abort") {
      rows.push({
        kind: "title",
        text: `Abort: ${r.abortKind ?? "unknown"}`,
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
      | { kind: "single"; text: Text; h: number };
    const built: Built[] = [];
    let maxYakuName = 0;
    let maxYakuValue = 0;
    let maxSingle = 0;
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
        built.push({ kind: "yaku", name, value, h: yakuRowH });
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
    const contentW = Math.max(yakuColW, maxSingle);
    // Total height = sum of row heights + spacing.
    let totalH = 0;
    let prevKind: "yaku" | "single" | null = null;
    for (const b of built) {
      if (prevKind !== null) {
        totalH +=
          b.kind !== prevKind || b.kind === "single"
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
    for (const b of built) {
      if (prevKind !== null) {
        y +=
          b.kind !== prevKind || b.kind === "single"
            ? labelGapBefore
            : lineSpacing;
      }
      if (b.kind === "yaku") {
        const colLeft = (panelW - yakuColW) / 2;
        b.name.position.set(colLeft, y);
        b.value.position.set(colLeft + yakuColW - b.value.width, y);
        container.addChild(b.name, b.value);
      } else {
        b.text.position.set((panelW - b.text.width) / 2, y);
        container.addChild(b.text);
      }
      y += b.h;
      prevKind = b.kind;
    }
    container.position.set(cx - panelW / 2, cy - panelH / 2);
    parent.addChild(container);
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
    const nameText = new Text({
      text: isDealer ? `${name} (dealer)` : name,
      style: new TextStyle({
        fontFamily: "Inter, system-ui, sans-serif",
        fontSize: 20,
        fontWeight: "700",
        fill: 0xffffff,
      }),
    });
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
    const padX = 18;
    const padY = 14;
    const innerGap = 10;
    const rowContentW = deltaText
      ? scoreText.width + innerGap + deltaText.width
      : scoreText.width;
    const rowContentH = Math.max(scoreText.height, deltaText?.height ?? 0);
    const innerW = Math.max(nameText.width, rowContentW) + padX * 2;
    const innerH = nameText.height + 8 + rowContentH + padY * 2;
    const bg = new Graphics()
      .roundRect(0, 0, innerW, innerH, 10)
      .fill({ color: 0x000000, alpha: 0.85 })
      .stroke({ color: 0xffffff, width: 1, alpha: 0.3 });
    container.addChild(bg);
    nameText.position.set((innerW - nameText.width) / 2, padY);
    container.addChild(nameText);
    const rowY = padY + nameText.height + 8;
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
    const rows = ordered.map((f) => ({
      place: f.place,
      name: seatNames?.[f.seat] ?? `Seat ${f.seat}`,
      score: f.score,
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
    const rowTexts = rows.map((r) => ({
      place: new Text({ text: `${r.place}.`, style: rowStyle }),
      name: new Text({ text: r.name, style: rowStyle }),
      score: new Text({ text: `${r.score}`, style: rowStyle }),
    }));

    const placeColW = Math.max(...rowTexts.map((r) => r.place.width));
    const nameColW = Math.max(...rowTexts.map((r) => r.name.width));
    const scoreColW = Math.max(...rowTexts.map((r) => r.score.width));
    const placeGap = 8; // space between place number and name
    const scoreGap = 28; // space between name column and scores
    const contentW = placeColW + placeGap + nameColW + scoreGap + scoreColW;

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
      r.score.position.set(
        rowsX +
          placeColW +
          placeGap +
          nameColW +
          scoreGap +
          (scoreColW - r.score.width),
        y
      );
      panel.addChild(r.place, r.name, r.score);
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
    const rawHand = view.hands[seat] ?? [];
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
    const isFreshlyDrawn = view.freshlyDrawnSeat === seat;
    const hand = sortHand(rawHand, isFreshlyDrawn);
    const handContainer = new Container();
    // Side hands (seats 1 / 3, never the focused user) use a
    // dedicated tile size (`layout.tileSide`) and stack the tiles
    // with overlap along the hand's long axis. The lower tile in
    // screen space sits on top of the higher one (Tenhou
    // convention).
    const isSideHand = !isYou && seat % 2 === 1;

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
      isSideHand && this.showHands && hand.some((t) => t !== null);
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

    // Pre-index this seat's riichi legal actions by tile so a click
    // in `riichiMode` can dispatch the right `riichi:TILE` action.
    const riichiLegalsByTile = new Map<string, LegalAction>();
    if (isYou) {
      for (const a of view.legalActions) {
        if (a.type === "riichi" && a.tile) {
          riichiLegalsByTile.set(a.tile, a);
        }
      }
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
      const ts = layout.tileSide;
      // Pick stride based on whether the strip is being shown
      // face-up. Revealed tiles use the side-discard footprint
      // (see `sideHandRevealed` block above) so successive tiles
      // stride by `SIDE_TILE_H - DISCARD_ROW_OVERLAP_HORIZ` —
      // identical to a side seat's discard row.
      const stride = sideHandRevealed
        ? SIDE_TILE_H - DISCARD_ROW_OVERLAP_HORIZ
        : ts.h - layout.tileSideOverlap;
      const handGap = isFreshlyDrawn ? TSUMO_GAP : 0;
      const zSign = seat === 1 ? -1 : 1;
      // Face-down sheet by default; with `showHands` and a real
      // tile string we swap to the seat's face-up discard sheet
      // (`rightSmall`/`leftSmall`) which already contains the
      // per-tile artwork pre-rotated for that seat.
      const backSheet: SheetKey = seat === 1 ? "sideHandR" : "sideHandL";
      const faceSheet: SheetKey = seat === 1 ? "rightSmall" : "leftSmall";
      const localRot = seat === 1 ? Math.PI / 2 : -Math.PI / 2;
      hand.forEach((tile, i) => {
        const wrap = new Container();
        const extraGap = handGap > 0 && i === hand.length - 1 ? handGap : 0;
        wrap.position.set(i * stride + extraGap, 0);
        wrap.zIndex = zSign * i;
        const reveal = this.showHands && tile !== null;
        const tex = this.getTileTexture(
          reveal ? faceSheet : backSheet,
          reveal ? tile : null
        );
        const sprite = new Sprite(tex);
        sprite.anchor.set(0.5, 0.5);
        if (reveal) {
          this.tintIfWait(sprite, tile);
          // Discard-style rendering: the `rightSmall`/`leftSmall`
          // sheets store the tile artwork already pre-rotated for
          // the seat's view, sized as SIDE_TILE_W × SIDE_TILE_H
          // (landscape source). We counter-rotate by `-localRot`
          // so the sprite's screen-AABB after the handContainer's
          // ±π/2 rotation matches a side discard tile exactly,
          // then add π so the tile face points "down" toward the
          // table center (an opponent's revealed hand should read
          // upright from our perspective, not from theirs).
          sprite.width = SIDE_TILE_W;
          sprite.height = SIDE_TILE_H;
          sprite.rotation = -localRot + Math.PI;
          sprite.position.set(SIDE_TILE_H / 2, SIDE_TILE_W / 2);
        } else {
          // Face-down `sideHandL/R`: portrait source artwork sized
          // (ts.w × ts.h). After `localRot` of ±π/2, the sprite's
          // screen-AABB in local space becomes (ts.h × ts.w) —
          // exactly the cell we want to fill.
          sprite.width = ts.w;
          sprite.height = ts.h;
          sprite.rotation = localRot;
          sprite.position.set(ts.h / 2, ts.w / 2);
        }
        wrap.addChild(sprite);
        handContainer.addChild(wrap);
      });
    } else {
      // Bottom hand (seat 0) uses BIG tile sprites from the
      // `ownHand` spritesheet; top hand (seat 2) uses SMALL back
      // tiles from the `topSmall` sheet. Stride along the hand's
      // long axis uses the layout's tile dims so the run fits the
      // designed hand zone.
      const t = seat === 0 ? layout.tileSelf : layout.tileHorizontal;
      const spriteW = seat === 0 ? BIG_TILE_W : t.w;
      const spriteH = seat === 0 ? BIG_TILE_H : t.h;
      const handGap = isFreshlyDrawn ? TSUMO_GAP : 0;
      handWidth = hand.length * (t.w + t.gap) - t.gap + handGap;
      hand.forEach((tile, i) => {
        let tileSprite: Container;
        if (seat === 0) {
          // Face-up from the focused-hand sheet; sprite is sized
          // to BIG_TILE_W × BIG_TILE_H (source × scale).
          const tex = this.getTileTexture("ownHand", tile);
          const sprite = new Sprite(tex);
          sprite.width = spriteW;
          sprite.height = spriteH;
          this.tintIfWait(sprite, tile);
          tileSprite = sprite;
        } else {
          // Top hand (seat 2) — face-down back tile from the
          // `topSmall` sheet. The sheet is drawn upright, but the
          // seat-2 `handContainer` is rotated 180°; counter-rotate
          // the sprite so the tile reads right-side-up on screen.
          //
          // With `showHands` and a real tile, swap to the face-up
          // cell of the same sheet (same orientation, just a
          // different sub-frame).
          const reveal = this.showHands && tile !== null;
          const tex = this.getTileTexture("topSmall", reveal ? tile : null);
          const sprite = new Sprite(tex);
          sprite.anchor.set(0.5, 0.5);
          sprite.width = spriteW;
          sprite.height = spriteH;
          sprite.rotation = Math.PI;
          sprite.position.set(spriteW / 2, spriteH / 2);
          if (reveal) {
            this.tintIfWait(sprite, tile);
          }
          const wrap = new Container();
          wrap.addChild(sprite);
          tileSprite = wrap;
        }
        const extraGap = handGap > 0 && i === hand.length - 1 ? handGap : 0;
        tileSprite.position.set(i * (t.w + t.gap) + extraGap, 0);
        // Optimistic pending discard tint.
        if (
          view.pendingDiscard &&
          view.pendingDiscard.seat === seat &&
          tile === view.pendingDiscard.tile
        ) {
          tileSprite.alpha = 0.4;
        }
        if (isYou && tile) {
          const riichiLegal = riichiLegalsByTile.get(tile);
          // Dim tiles that aren't legal riichi discards while the
          // player is in select-riichi-tile mode.
          if (inRiichiMode && !riichiLegal) {
            tileSprite.alpha = 0.3;
          }
          tileSprite.eventMode = "static";
          tileSprite.cursor = "pointer";
          const localTile = tile;
          const localIndex = i;
          tileSprite.on("pointerdown", () => {
            if (inRiichiMode) {
              // Only riichi-legal tiles complete the declaration;
              // clicks on dimmed tiles are no-ops.
              if (riichiLegal && this.onActionClick) {
                this.riichiMode = false;
                this.onActionClick({ action: riichiLegal });
              }
              return;
            }
            if (this.onTileClick) {
              this.onTileClick({
                seat,
                index: localIndex,
                tile: localTile,
              });
            }
          });
        }
        handContainer.addChild(tileSprite);
      });
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
        break;
      }
      case 1: {
        // right — rotate -90° (counter-clockwise on screen) so the
        // hand reads from bottom→top after rotation. Container's
        // origin lands at the rect's bottom-left; -90° pivots the
        // strip up along the inner edge.
        handContainer.rotation = -Math.PI / 2;
        handContainer.position.set(
          handRect.x,
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
        // top-right; reads top→bottom.
        handContainer.rotation = Math.PI / 2;
        handContainer.position.set(
          handRect.x + handRect.w,
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
    this.root.addChild(handContainer);

    // Open / declared melds for this seat. Anchored to the outer
    // (clockwise) corner of the hand so chi/pon/kan stacks read
    // naturally.
    this.renderMelds(
      view.melds[seat] ?? [],
      seat,
      handRect,
      longAxisOffset,
      handWidth
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
    const discardCols = 6;
    // Per-orientation row overlap (in design pixels along the
    // row-stacking axis):
    //   - vertical tiles (bottom/top seats): rows nest visually so
    //     successive rows overlap their predecessor.
    //   - horizontal tiles (side seats): rows stack edge-to-edge.
    // (Overlap constants are hoisted to module scope so the side-hand
    // reveal path can reuse `DISCARD_ROW_OVERLAP_HORIZ`.)
    // Each seat uses its own pre-rotated sheet, with the sprite
    // counter-rotated so the source artwork displays in its
    // natural source orientation in screen space (cancelling the
    // discard container's per-seat rotation).
    const discardSheets: Record<number, SheetKey> = {
      0: "bottomSmall",
      1: "rightSmall",
      2: "topSmall",
      3: "leftSmall",
    };
    const discardSheet = discardSheets[seat];
    const containerRotations = [0, -Math.PI / 2, Math.PI, Math.PI / 2];
    const spriteCounterRot = -containerRotations[seat];
    const isHorizontalDiscardSheet = seat === 1 || seat === 3;
    // Side-seat (horizontal-artwork) discards use SIDE_TILE_*
    // for screen-space dims; bottom/top use SMALL_TILE_* (bumped
    // by +3 design px in width, height scaled to preserve the
    // vertical-tile aspect).
    //   screen W = local H across rows (since container rotates
    //              local +x into screen ±y)
    //   screen H = local W along row direction
    const tileLocalW = isHorizontalDiscardSheet
      ? SIDE_TILE_H
      : SMALL_TILE_W + 3;
    const tileLocalH = isHorizontalDiscardSheet
      ? SIDE_TILE_W
      : ((SMALL_TILE_W + 3) * SMALL_TILE_H) / SMALL_TILE_W;
    // Row stride: vertical seats overlap their rows by
    // DISCARD_ROW_OVERLAP_VERT (so successive rows nest); side
    // seats stack rows with no overlap (the side-by-side overlap
    // for side seats happens within a row, see `tileStride`).
    const rowStride =
      tileLocalH - (isHorizontalDiscardSheet ? 0 : DISCARD_ROW_OVERLAP_VERT);
    const riichiIdx = view.riichiTileIdx[seat];
    let cursorX = 0;
    let cursorRow = 0;
    discards.forEach((tile, i) => {
      const row = Math.floor(i / discardCols);
      if (row !== cursorRow) {
        cursorRow = row;
        cursorX = 0;
      }
      const isRiichi = i === riichiIdx;
      // Outer wrap: handles the existing container-local
      // positioning (and the riichi +π/2 rotation).
      const wrap = new Container();
      // Within-row z-order for side seats: the tile lower on
      // screen sits on top.
      //   Seat 1 (right, container rot -π/2): cursor +x → screen
      //     -y, so smaller i (smaller cursorX) is lower on screen
      //     → smaller i on top → zIndex = -i.
      //   Seat 3 (left, container rot +π/2): cursor +x → screen
      //     +y, so larger i is lower on screen → larger i on top
      //     → zIndex = i.
      let withinRowZ = 0;
      if (seat === 1) {
        withinRowZ = -i;
      } else if (seat === 3) {
        withinRowZ = i;
      }
      wrap.zIndex = (seat === 2 ? -row : row) * 1000 + withinRowZ;
      // The riichi tile is rotated +π/2 inside the wrap (see below).
      // The regular discard sheet's artwork orientation produces
      // wrong-oriented art when rotated by an extra π/2, so each
      // seat's riichi tile reads from a sheet whose source
      // orientation is perpendicular to the regular sheet:
      //   - seat 0 (bottom, regular vertical art) → `leftSmall`
      //   - seat 1 (right,  regular horizontal art) → `bottomSmall`
      //   - seat 2 (top,    regular vertical art) → `leftSmall`
      //   - seat 3 (left,   regular horizontal art) → `topSmall`
      // After the wrap +π/2 and container rotation, the riichi tile
      // reads upright (and with lighting matching the side it sits
      // on, for seats 1/3).
      const riichiSheetBySeat: Record<number, SheetKey> = {
        0: "leftSmall",
        1: "bottomSmall",
        2: "leftSmall",
        3: "topSmall",
      };
      const riichiSheet: SheetKey = riichiSheetBySeat[seat];
      const sheetToUse = isRiichi ? riichiSheet : discardSheet;
      const tex = this.getTileTexture(sheetToUse, tile);
      const sprite = new Sprite(tex);
      sprite.anchor.set(0.5, 0.5);
      this.tintIfWait(sprite, tile);
      // Pre-rotation sprite dims chosen so that after sprite
      // rotation (and container rotation) the on-screen bounds
      // are tileLocalH × tileLocalW.
      if (isRiichi && isHorizontalDiscardSheet) {
        // Side-seat riichi (seats 1/3): vertical-art sheet,
        // wrap +π/2 produces the tilted on-screen look. Pre-
        // rotation dims = screen dims for a tilted side tile
        // (long edge along wrap-local x = tileLocalH; short
        // edge along wrap-local y = tileLocalW).
        //
        // Seat 3 (left) additionally needs +π so the riichi
        // tile points outward like seat 1 does naturally.
        sprite.width = SMALL_TILE_W;
        sprite.height = SMALL_TILE_H;
        sprite.rotation = seat === 3 ? Math.PI : 0;
      } else if (isRiichi) {
        // Bottom/top seat riichi (seats 0/2): horizontal-art
        // sheet (leftSmall). Source aspect is 116:107, so we
        // size to SIDE_TILE_W × SIDE_TILE_H (preserving aspect)
        // rather than to the vertical-tile footprint. No wrap
        // rotation; the sprite sits landscape in the row.
        sprite.width = SIDE_TILE_W;
        sprite.height = SIDE_TILE_H;
        sprite.rotation = spriteCounterRot;
      } else if (isHorizontalDiscardSheet) {
        sprite.width = tileLocalH;
        sprite.height = tileLocalW;
        sprite.rotation = spriteCounterRot;
      } else {
        sprite.width = tileLocalW;
        sprite.height = tileLocalH;
        sprite.rotation = spriteCounterRot;
      }
      if (isRiichi && isHorizontalDiscardSheet) {
        // Side-seat riichi: position the sprite within the wrap
        // so that after the wrap +π/2 rotation (applied below),
        // its container-x range is exactly [cursorX, cursorX +
        // SMALL_TILE_H] and its container-y is centred on rowY +
        // tileLocalH/2 (aligning with the row's regular tiles).
        sprite.position.set(tileLocalH / 2, SMALL_TILE_H / 2);
      } else if (isRiichi) {
        // Bottom/top seat riichi: SIDE_TILE_W × SIDE_TILE_H
        // footprint, vertically centred within the row's
        // cross-axis band (tileLocalH).
        sprite.position.set(SIDE_TILE_W / 2, tileLocalH / 2);
      } else {
        sprite.position.set(tileLocalW / 2, tileLocalH / 2);
      }
      wrap.addChild(sprite);
      const rowY = row * rowStride;
      // Horizontal stride along the row direction. Vertical seats
      // butt their tiles flush; side seats overlap consecutive
      // tiles in a row by DISCARD_ROW_OVERLAP_HORIZ.
      const tileStride =
        tileLocalW - (isHorizontalDiscardSheet ? DISCARD_ROW_OVERLAP_HORIZ : 0);
      // Riichi stride = the riichi tile's screen extent along the
      // row direction. Side seats subtract DISCARD_ROW_OVERLAP_HORIZ
      // so the next tile overlaps the riichi the same way regular
      // tiles overlap each other; bottom/top seats advance by the
      // riichi tile's landscape width (SIDE_TILE_W).
      const riichiStride = isHorizontalDiscardSheet
        ? SMALL_TILE_H - DISCARD_ROW_OVERLAP_HORIZ
        : SIDE_TILE_W;
      if (isRiichi) {
        if (isHorizontalDiscardSheet) {
          // Side seats: wrap +π/2 produces the tilted look. The
          // wrap origin compensates so the sprite's container-x
          // left edge lands exactly at cursorX.
          wrap.rotation = Math.PI / 2;
          wrap.position.set(cursorX + SMALL_TILE_H, rowY);
        } else {
          // Bottom/top seats: source is already landscape, no
          // wrap rotation. Sprite sits at (cursorX, rowY) with
          // its short edge (tileLocalW) along container +y.
          wrap.rotation = 0;
          wrap.position.set(cursorX, rowY);
        }
        cursorX += riichiStride;
      } else {
        wrap.position.set(cursorX, rowY);
        cursorX += tileStride;
      }
      discardContainer.addChild(wrap);
    });
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
    handWidth: number
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
    for (let i = melds.length - 1; i >= 0; i--) {
      const { node, width } = this.drawMeld(melds[i], seat);
      node.position.set(cursor, 0);
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
    seat: number
  ): { node: Container; width: number } {
    const c = new Container();
    c.sortableChildren = true;
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
      const tiles = meld.tiles;
      let ax = 0;
      const mt = meldTileDims(seat);
      tiles.forEach((tile, i) => {
        const faceUp = !(i === 0 || i === tiles.length - 1);
        const sprite = faceUp
          ? this.drawMeldTile(tile, seat)
          : this.drawMeldTile(null, seat);
        sprite.position.set(ax, 0);
        sprite.zIndex = tileZ(i);
        ax += mt.w - meldOverlap;
        c.addChild(sprite);
      });
      return {
        node: c,
        width: tiles.length * mt.w - (tiles.length - 1) * meldOverlap,
      };
    }
    if (meld.claimedTile === null || meld.from === null) {
      // Shouldn't happen for chi/pon/kan, but render defensively as a
      // plain row.
      let dx = 0;
      const mt = meldTileDims(seat);
      meld.tiles.forEach((tile, i) => {
        const sprite = this.drawMeldTile(tile, seat);
        sprite.position.set(dx, 0);
        sprite.zIndex = tileZ(i);
        dx += mt.w - meldOverlap;
        c.addChild(sprite);
      });
      return {
        node: c,
        width: meld.tiles.length * mt.w - (meld.tiles.length - 1) * meldOverlap,
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
    const calledSlot =
      meld.from === (seat + 3) % 4 ? 0 : meld.from === (seat + 2) % 4 ? 1 : 2;

    // Layout: walk slots in screen order. Chi / pon = 3 slots,
    // daiminkan / shouminkan base row = 3 slots (the 4th tile is
    // either irrelevant for chi/pon or stacked on top for shouminkan;
    // for daiminkan the 4th tile sits next to the called tile).
    const slotCount = meld.type === "daiminkan" ? 4 : 3;
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
    const mt = meldTileDims(seat);
    // Tilted called tile uses the NEXT-CLOCKWISE seat's sheet so it
    // visually points outward toward the player from whom the tile
    // was claimed (Tenhou convention). Its size matches that
    // seat's discard dims (which may differ from the strip seat's
    // dims for side strips).
    const nextSheets: Record<number, SheetKey> = {
      0: "rightSmall",
      1: "topSmall",
      2: "leftSmall",
      3: "bottomSmall",
    };
    const tiltedSheet = nextSheets[seat];
    const tiltedSeat = (seat + 1) % 4;
    const tilted = meldTileDims(tiltedSeat);
    slots.forEach((slot, i) => {
      const sprite = slot.rotated
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
    });
    if (stackTile !== null) {
      const stack = this.drawMeldTile(stackTile, seat, tiltedSheet);
      stack.rotation = -Math.PI / 2;
      // Render the stacked kan tile UNDER the called tile
      stack.zIndex = tileZ(slots.length) - 1;
      stack.position.set(calledX, mt.h - tilted.w + DISCARD_ROW_OVERLAP_HORIZ);
      c.addChild(stack);
    }
    // Total footprint width = xCursor (sum of strides) + the last
    // tile's full width restored (each stride subtracted `meldOverlap`,
    // but there is no next tile to overlap with the last one).
    return { node: c, width: xCursor + meldOverlap };
  }

  private renderActionButtons(view: MatchView, cx: number): void {
    if (!this.root) {
      return;
    }
    // Pull every non-discard legal action — these are the call /
    // riichi / win decisions that need explicit buttons. Discards are
    // tile-driven (click a tile in the hand).
    //
    // Riichi is special: the server surfaces one legal action per
    // legal declaration tile, but the UI consolidates them into a
    // single "Riichi" toggle. Clicking the button enters
    // `riichiMode`; the next click on a riichi-legal tile sends the
    // matching `riichi:TILE` action id.
    const raw = view.legalActions.filter(
      (a) => a.type !== "discard" && a.type !== "draw"
    );
    const buttons: Array<LegalAction | { synthetic: "riichi" }> = [];
    let seenRiichi = false;
    for (const a of raw) {
      if (a.type === "riichi") {
        if (!seenRiichi) {
          seenRiichi = true;
          buttons.push({ synthetic: "riichi" });
        }
        continue;
      }
      buttons.push(a);
    }
    if (buttons.length === 0) {
      return;
    }
    const strip = new Container();
    const btnH = 44;
    const btnPad = 16;
    const btnGap = 12;
    // Two passes: first measure, then position centered.
    const rendered: Container[] = [];
    const widths: number[] = [];
    for (const entry of buttons) {
      if ("synthetic" in entry) {
        const { container, width } = this.drawRiichiToggleButton();
        rendered.push(container);
        widths.push(width);
      } else {
        const { container, width } = this.drawActionButton(entry);
        rendered.push(container);
        widths.push(width);
      }
    }
    const totalW =
      widths.reduce((a, b) => a + b, 0) + btnGap * (buttons.length - 1);
    let x = -totalW / 2;
    rendered.forEach((c, i) => {
      c.position.set(x, 0);
      strip.addChild(c);
      x += widths[i] + btnGap;
    });
    // Sit just above the bottom hand row.
    strip.position.set(cx, DESIGN_H - HAND_PAD - SMALL_TILE_H - btnH - btnPad);
    this.root.addChild(strip);
  }

  /**
   * "Riichi" toggle button. Clicking it flips `riichiMode`; the
   * next render then dims non-riichi-legal tiles and routes hand
   * clicks to the matching `riichi:TILE` legal action.
   */
  private drawRiichiToggleButton(): {
    container: Container;
    width: number;
  } {
    const labelStyle = new TextStyle({
      fontFamily: "Inter, system-ui, sans-serif",
      fontSize: 18,
      fontWeight: "700",
      fill: 0xffffff,
    });
    const active = this.riichiMode;
    const text = active ? "Cancel Riichi" : "Riichi";
    const labelNode = new Text({ text, style: labelStyle });
    const padX = 18;
    const width = Math.max(72, labelNode.width + padX * 2);
    const height = 44;
    const bg = new Graphics()
      .roundRect(0, 0, width, height, 8)
      .fill({ color: active ? 0xe0c060 : 0xc0a040 });
    labelNode.anchor.set(0.5);
    labelNode.position.set(width / 2, height / 2);
    const c = new Container();
    c.addChild(bg, labelNode);
    c.eventMode = "static";
    c.cursor = "pointer";
    c.on("pointerdown", () => {
      this.riichiMode = !this.riichiMode;
      // Re-render so the new mode reflects in tile alpha + button
      // label. We don't have a direct re-render hook; calling
      // `render` requires the latest view, which the caller owns.
      // Fire an action click with a sentinel so the host (match
      // route) can trigger a re-render. Simpler: just rely on the
      // host's render-on-state-change loop — toggling riichiMode
      // alone won't trigger one, so we emit a no-op click that the
      // host can ignore. Instead, we redraw directly:
      if (this.onRenderRequest) {
        this.onRenderRequest();
      }
    });
    return { container: c, width };
  }

  private drawActionButton(action: LegalAction): {
    container: Container;
    width: number;
  } {
    const labelStyle = new TextStyle({
      fontFamily: "Inter, system-ui, sans-serif",
      fontSize: 18,
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
    const text = labelForAction(action);
    const labelNode = new Text({ text, style: labelStyle });
    const padX = 18;
    const width = Math.max(72, labelNode.width + padX * 2);
    const height = 44;
    const bg = new Graphics()
      .roundRect(0, 0, width, height, 8)
      .fill({ color: palette[action.type] ?? 0x666666 });
    labelNode.anchor.set(0.5);
    labelNode.position.set(width / 2, height / 2);
    const c = new Container();
    c.addChild(bg, labelNode);
    c.eventMode = "static";
    c.cursor = "pointer";
    c.on("pointerdown", () => {
      if (this.onActionClick) {
        this.onActionClick({ action });
      }
    });
    return { container: c, width };
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
  ): Container {
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
    const dims = meldTileDims(dimsSeat);
    const seatSheets: Record<number, SheetKey> = {
      0: "bottomSmall",
      1: "rightSmall",
      2: "topSmall",
      3: "leftSmall",
    };
    // For face-down tiles (ankan outer slots), seats 2 and 3 fall
    // back to the seat-0 / seat-1 sheets — matching the wall's
    // back-tile sheet map. `topSmall` / `leftSmall` don't carry a
    // back-tile cell at (row 3, col 0); the back artwork is the
    // same regardless of seat orientation since it's rotationally
    // symmetric.
    const faceDownSeatSheets: Record<number, SheetKey> = {
      0: "bottomSmall",
      1: "rightSmall",
      2: "bottomSmall",
      3: "rightSmall",
    };
    const sheet =
      sheetOverride ??
      (tile === null ? faceDownSeatSheets[seat] : seatSheets[seat]);
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
    return c;
  }

  /**
   * Build (or fetch from cache) the sub-texture for a single tile
   * on a given sheet. For single-tile sheets the `tile` argument
   * is ignored. Returns `null` if the sheet hasn't loaded yet.
   */
  private getTileTexture(sheet: SheetKey, tile: string | null): Texture {
    const entry = this.sheets.get(sheet);
    if (!entry) {
      // mount() awaits all sheet loads before this.root is created,
      // so any render after mount must find every sheet present.
      throw new Error(`TableRenderer: sheet ${sheet} not loaded`);
    }
    if (!IS_MULTI_TILE[sheet]) {
      return entry.texture;
    }
    const cell = tileSheetCell(tile);
    const key = `${sheet}:${cell.row}:${cell.col}`;
    const cached = this.tileTextures.get(key);
    if (cached) {
      return cached;
    }
    // Inset the frame by 0.5 px on each side to prevent neighboring
    // cells from bleeding into the sampled texels when the sprite
    // is downscaled with antialiasing.
    const inset = 0.5;
    const frame = new Rectangle(
      cell.col * entry.cellW + inset,
      cell.row * entry.cellH + inset,
      entry.cellW - inset * 2,
      entry.cellH - inset * 2
    );
    const tex = new Texture({ source: entry.texture.source, frame });
    this.tileTextures.set(key, tex);
    return tex;
  }
}

/**
 * Local-space tile dimensions for a meld in the given seat's
 * strip. Local +x is the strip's reading direction. After the
 * meld container's per-seat rotation, on-screen tile size matches
 * the seat's discard tile size:
 *   - bottom/top (0/2): screen W=SMALL_TILE_W, screen H=SMALL_TILE_H
 *   - side (1/3):       screen W=SIDE_TILE_W, screen H=SIDE_TILE_H
 *
 * The local +x dimension equals the long-axis stride (the
 * direction tiles advance along), so for side seats the local
 * "width" is actually the short side-screen-height (53.x), and
 * the local "height" (cross axis) is the long side-screen-width
 * (58).
 */
function meldTileDims(seat: number): { w: number; h: number } {
  const isSide = seat === 1 || seat === 3;
  if (!isSide) {
    return { w: SMALL_TILE_W, h: SMALL_TILE_H };
  }
  // Container rotation ±π/2 swaps width/height between local and
  // screen. Local +x maps to screen ∓y, so local width = screen
  // height and local height = screen width.
  return { w: SIDE_TILE_H, h: SIDE_TILE_W };
}

const SUIT_ORDER: Record<string, number> = { m: 0, p: 1, s: 2, z: 3 }; /**
 * Sort key for a single tile string. Suits ordered m → p → s → z; within
 * a suit, ascending by number. Red fives (`0m`/`0p`/`0s`) collate at 5
 * and tie-break before the regular five (matches Tenhou-style rendering).
 */
function tileSortKey(tile: string): number {
  const suit = tile[tile.length - 1];
  const n = Number(tile.slice(0, -1));
  const suitWeight = (SUIT_ORDER[suit] ?? 9) * 100;
  // 0 (red five) → 4.5 so it sorts just before the plain 5.
  const numWeight = n === 0 ? 4.5 : n;
  return suitWeight + numWeight;
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
