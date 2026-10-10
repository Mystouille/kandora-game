/**
 * Shared Pixi table facade. The host owns store subscriptions; each drawing,
 * interaction, asset and HUD concern below owns only its own state.
 */
import type { MatchView } from "../store";
import { isTableSeatActive, rotateMatchView } from "../tableProjection";
import {
  resolveFelt,
  tableLayoutFromConfig,
  validateTableLayoutConfig,
  type TableLayoutConfig,
  type Rect,
} from "./tableLayout";
import type { Seat } from "./tableGeometry";
import type { TileDesign } from "./tiles/tileDesign";
import { ACTIVE_TILE_DESIGN } from "./tiles/activeTileDesign";
import { ACTIVE_TABLE_LAYOUT } from "./layouts/activeTableLayout";
import {
  webTableLayoutConfig,
  type WebTableLayoutMode,
} from "./layouts/webTableLayout";
import { DiscardAnimator } from "./discardAnimator";
import { MeldAnimator } from "./meldAnimator";
import { RyuukyokuDeclarationAnimator } from "./ryuukyokuDeclarationAnimator";
import { SceneGraph } from "./scene/sceneGraph";
import { RendererAssets } from "./scene/rendererAssets";
import { SceneAnchors } from "./scene/sceneAnchors";
import type { FocusedDiscardDrawingFrame } from "./geometry/reviewDrawingGeometry";
import type {
  ActionClick,
  HandResult,
  RenderFrame,
  SeatEnrichment,
  TableRendererPresentation,
  TileClick,
} from "./scene/renderTypes";
import { HandRenderer } from "./renderers/handRenderer";
import { DiscardRenderer } from "./renderers/discardRenderer";
import { MeldRenderer } from "./renderers/meldRenderer";
import { MeldTileRenderer } from "./renderers/meldTiles";
import { renderNukiTiles } from "./renderers/nukiRenderer";
import { WallRenderer } from "./renderers/wallRenderer";
import { TileShadows } from "./renderers/tileShadows";
import { TablePanels } from "./renderers/tablePanels";
import { renderCallEffects } from "./renderers/callEffectRenderer";
import { InteractionController } from "./interaction/interactionController";
import {
  CanvasInteractions,
  type CanvasShortcutFrame,
} from "./interaction/canvasInteractions";
import { ActionControls } from "./controls/actionControls";
import { HudRenderer } from "./hud/hudRenderer";
import type { CenterLabels } from "./hud/hudTypes";
import { ResultPresenter } from "./results/resultPresenter";
import type { ResultLabels } from "./results/resultTypes";
import { tableRenderPolicy } from "./geometry/tableGeometry";
export type {
  ActionClick,
  SeatEnrichment,
  TableRendererPresentation,
  TileClick,
  TsumogiriTintMode,
} from "./scene/renderTypes";
export {
  tableRenderPolicy,
  shouldTintTsumogiri,
  wallZIndex,
  discardContainerZIndex,
  playerIdentityCenter,
  callEffectAnchor,
  type TableRenderPolicy,
} from "./geometry/tableGeometry";
export {
  focusedHandTileMetrics,
  focusedHandTileSpriteSpec,
  focusedHandLongAxisOffset,
} from "./geometry/handGeometry";
export {
  MOBILE_DORA_INDICATOR_GAP,
  mobileDoraIndicatorSlots,
  mobileCenterInnerRect,
  mobileDoraRowGeometry,
  mobileCounterCells,
  CENTER_DORA_INDICATOR_GAP,
  centerDoraIndicatorSlots,
  centerInfoInnerRect,
  centerDoraRowGeometry,
  centerCounterCells,
  centerCounterSpecs,
  fitCounterContentInCell,
  type MobileDoraRowGeometry,
  type CenterDoraRowGeometry,
  type CenterCounterSpec,
} from "./geometry/centerGeometry";
export {
  WEB_RIICHI_STICK,
  MOBILE_RIICHI_STICK,
  riichiStickMetrics,
  mobileRiichiStickPlacement,
  type RiichiStickPlacement,
} from "./geometry/riichiGeometry";
export {
  actionButtonStyle,
  layoutActionButtonRows,
  actionButtonLabel,
  actionButtonColor,
  orderedRyuukyokuDeclarationActions,
  type ActionButtonStyle,
  type ActionButtonPlacement,
} from "./geometry/actionGeometry";
export {
  isDoubleTapGesture,
  isMobileDoubleTapShortcutTarget,
  genericPassOrTsumogiriAction,
  topmostHandHoverTargetIndex,
  riichiSelectionTileTint,
  darkenTileTint,
  canInteractWithFocusedHand,
  canApplyFocusedHandHover,
  focusedHandOrderPolicy,
  isPendingDiscardDisplaySlot,
  pointInsideRect,
  type TapSample,
} from "./geometry/interactionPolicy";
export {
  layoutTouchingMeldColumn,
  layoutMeldStripGroups,
  type MeldStripGroupPlacement,
  type MeldStripGroupBounds,
} from "./geometry/meldGeometry";
export {
  DISCARD_SHADOW_Z_INDEX,
  RIICHI_STICK_Z_INDEX,
  TEAM_LOGO_Z_INDEX,
} from "./geometry/renderConstants";
export {
  resolveSeatHandPresentation,
  type SeatHandPresentation,
} from "./geometry/handPresentation";
export {
  activePlayerIndicatorSeat,
  advanceMatchEndRevealSound,
  formatTableScore,
  shouldStageWinReveal,
  handResultDealerSeat,
  shouldRevealWinScoreSummary,
  uraDoraRevealAtMs,
  shouldRevealWinScoreDelta,
  winResultRevealKey,
  buildResultYakuEntries,
  resultUraDoraIndicators,
} from "./geometry/resultReveal";
export {
  scoreCartridgeTextLayout,
  scoreCartridgeScoreScale,
  scoreCartridgeFontSize,
  resultScoreBoxLayout,
} from "./geometry/scoreGeometry";
export {
  resolveActionTimerState,
  resolveTableHudState,
  actionTimerTickDecision,
} from "./hud/actionTimerViewModel";
export {
  sortTilesForDisplay,
  ankanTilesForDisplay,
} from "./geometry/tileOrder";
export class TableRenderer {
  private readonly scene = new SceneGraph();
  private readonly animator = new DiscardAnimator();
  private readonly meldAnimator = new MeldAnimator();
  private readonly declarationAnimator = new RyuukyokuDeclarationAnimator();
  private readonly anchors = new SceneAnchors();
  private readonly requestRender = (): void => this.scene.requestRender();
  private readonly interaction = new InteractionController(
    this.animator,
    this.requestRender
  );
  private readonly controls = new ActionControls(
    this.animator,
    this.requestRender,
    (click) => this.interaction.emitAction(click)
  );
  private readonly hud = new HudRenderer(this.requestRender);
  private readonly results = new ResultPresenter(this.requestRender, () => {
    if (this.lastView) {
      this.render(this.lastView);
    }
  });
  private readonly canvasInteractions = new CanvasInteractions(
    () => this.shortcutFrame(),
    () => this.interaction.handlePassOrTsumogiriShortcut(),
    this.results
  );
  private readonly assets: RendererAssets;
  private readonly hands: HandRenderer;
  private readonly discards: DiscardRenderer;
  private readonly melds: MeldRenderer;
  private readonly walls: WallRenderer;
  private readonly panels: TablePanels;
  private readonly presentation: TableRendererPresentation;
  private layoutConfig: TableLayoutConfig;
  private webTableLayoutMode: WebTableLayoutMode;
  private showHands = false;
  private lastView: MatchView | null = null;
  constructor(opts?: {
    tileDesign?: TileDesign;
    layoutConfig?: TableLayoutConfig;
    presentation?: TableRendererPresentation;
    webTableLayoutMode?: WebTableLayoutMode;
  }) {
    const tileDesign = opts?.tileDesign ?? ACTIVE_TILE_DESIGN;
    this.presentation = opts?.presentation ?? "standard";
    this.webTableLayoutMode = opts?.webTableLayoutMode ?? "standard";
    this.layoutConfig =
      opts?.layoutConfig ??
      (this.presentation === "standard"
        ? webTableLayoutConfig(this.webTableLayoutMode)
        : ACTIVE_TABLE_LAYOUT);
    this.assets = new RendererAssets(tileDesign);
    const resources = this.assets.resources;
    const shadows = new TileShadows(resources);
    this.hands = new HandRenderer(
      resources,
      this.animator,
      this.interaction,
      shadows
    );
    this.discards = new DiscardRenderer(resources, this.animator, shadows);
    this.melds = new MeldRenderer(resources, this.meldAnimator, shadows);
    this.walls = new WallRenderer(resources, shadows, this.requestRender);
    this.panels = new TablePanels(tileDesign);
  }
  async mount(container: HTMLElement): Promise<void> {
    const app = await this.scene.mount(container, this.layoutConfig);
    this.canvasInteractions.mount(app);
    await this.assets.load();
    const root = this.scene.createRoot();
    this.hud.mount(app, this.presentation);
    this.scene.startAnimationPump(
      () =>
        this.animator.hasActive() ||
        this.meldAnimator.hasActive() ||
        this.declarationAnimator.hasActive() ||
        this.interaction.hasActiveAnimation()
    );
    this.interaction.mount(app, root);
    this.scene.observe(container);
  }
  setOnTileClick(handler: (click: TileClick) => void): void {
    this.interaction.setOnTileClick(handler);
  }
  setOnActionClick(handler: (click: ActionClick) => void): void {
    this.interaction.setOnActionClick((click) => {
      if (click.action.type === "riichi") {
        this.controls.clearRiichiMode();
      }
      handler(click);
    });
  }
  setOnRenderRequest(handler: () => void): void {
    this.scene.setOnRenderRequest(handler);
  }
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
  setWebTableLayoutMode(mode: WebTableLayoutMode): void {
    const config = webTableLayoutConfig(mode);
    if (this.webTableLayoutMode === mode && this.layoutConfig === config) {
      return;
    }
    this.webTableLayoutMode = mode;
    this.layoutConfig = config;
    this.panels.clear();
    this.requestRender();
  }
  setOnAutoSortChange(callback: ((on: boolean) => void) | null): void {
    this.interaction.setOnAutoSortChange(callback);
  }
  setAutoSort(on: boolean): void {
    this.interaction.setAutoSort(on);
  }
  setAnimationsEnabled(flag: boolean): void {
    this.animator.setEnabled(flag);
    this.meldAnimator.setEnabled(flag);
    this.declarationAnimator.setEnabled(flag);
  }
  snapNextAnimation(): void {
    this.animator.snapNext();
    this.meldAnimator.snapNext();
    this.declarationAnimator.snapNext();
  }
  setDrawSequencing(
    enabled: boolean,
    sounds?: {
      onDiscardLand: (
        seat: number,
        isRiichiDeclaration: boolean,
        presentationSeq: number
      ) => void;
      onDrawLand: (seat: number, presentationSeq: number) => void;
      onCatchUpSnap?: () => void;
    }
  ): void {
    this.animator.setSequenced(enabled);
    this.animator.setSoundHooks(sounds ?? {});
    this.requestRender();
  }
  setMinimumDrawToDiscardDelayEnabled(enabled: boolean): void {
    this.animator.setMinimumDrawToDiscardDelayEnabled(enabled);
  }
  setShowTsumogiri(flag: boolean): void {
    this.discards.setShowTsumogiri(flag);
  }
  setMobileActionButtonRightBoundary(boundaryPx: number | null): void {
    this.controls.setMobileActionButtonRightBoundary(boundaryPx);
  }
  setAutoWinEnabled(flag: boolean): void {
    this.controls.setAutoWinEnabled(flag);
  }
  setNoCallEnabled(flag: boolean): void {
    this.controls.setNoCallEnabled(flag);
  }
  setShowHands(flag: boolean): void {
    this.showHands = flag;
  }
  setShowWalls(flag: boolean): void {
    this.walls.setShowWalls(flag);
  }
  setShowUndealtWall(flag: boolean): void {
    this.walls.setShowUndealtWall(flag);
  }
  setLiveSpectate(flag: boolean): void {
    this.walls.setLiveSpectate(flag);
  }
  setShowLayoutDebug(flag: boolean): void {
    this.hud.setShowLayoutDebug(flag);
  }
  setShowWallZonesDebug(flag: boolean): void {
    this.hud.setShowWallZonesDebug(flag);
  }
  setConnectionDiagnosticsVisible(flag: boolean): void {
    this.hud.setConnectionDiagnosticsVisible(flag);
  }
  setShowWaits(flag: boolean): void {
    this.hud.setShowWaits(flag);
  }
  setShowNames(flag: boolean): void {
    this.hud.setShowNames(flag);
  }
  setCenterLabels(labels: CenterLabels): void {
    this.hud.setCenterLabels(labels);
  }
  setSeatEnrichment(list: (SeatEnrichment | null)[]): void {
    this.hud.setSeatEnrichment(list);
  }
  setShowHandResult(flag: boolean): void {
    this.results.setShowHandResult(flag);
  }
  setStagedRevealEnabled(flag: boolean): void {
    this.results.setStagedRevealEnabled(flag);
  }
  setHandResultOverride(result: HandResult | null): void {
    this.results.setHandResultOverride(result);
  }
  setResultLabels(labels: ResultLabels): void {
    this.results.setResultLabels(labels);
  }
  setResultPanelBoundsListener(
    callback: ((rect: Rect | null) => void) | null
  ): void {
    this.results.setResultPanelBoundsListener(callback);
  }
  setPondCenterListener(
    callback:
      | ((
          point: {
            x: number;
            y: number;
          } | null
        ) => void)
      | null
  ): void {
    this.anchors.setPondCenterListener(callback);
  }
  setBottomHandBoundsListener(
    callback: ((rect: Rect | null) => void) | null
  ): void {
    this.anchors.setBottomHandBoundsListener(callback);
  }
  setFocusedDiscardDrawingListener(
    callback: ((frame: FocusedDiscardDrawingFrame | null) => void) | null
  ): void {
    this.anchors.setFocusedDiscardDrawingListener(callback);
  }
  render(view: MatchView): void {
    if (!this.scene.app || !this.scene.root) {
      return;
    }
    if (view.playerCount === 3 && !view.tableProjection) {
      view = rotateMatchView(view, view.mySeat ?? 0);
    }
    if (
      this.lastView &&
      (this.lastView.playerCount ?? 4) !== (view.playerCount ?? 4)
    ) {
      this.results.setHandResultOverride(null);
    }
    if (
      this.lastView &&
      (this.lastView.playerCount !== view.playerCount ||
        this.lastView.tableProjection?.focus !== view.tableProjection?.focus)
    ) {
      this.animator.reset();
      this.meldAnimator.reset();
      this.declarationAnimator.reset();
      this.interaction.reset();
    }
    this.lastView = view;
    this.animator.beginFrame(view);
    this.meldAnimator.beginFrame(view);
    this.declarationAnimator.beginFrame(view);
    this.interaction.beginFrame(view);
    this.controls.beginFrame(view);
    const layout = tableLayoutFromConfig(this.layoutConfig);
    const felt = resolveFelt(this.layoutConfig);
    const resources = this.assets.resources;
    resources.textureStore.setRulesFamily(view.rulesFamily);
    const root = this.scene.beginFrame(layout, felt, resources);
    const frame: RenderFrame = {
      view,
      layout,
      root,
      presentation: this.presentation,
      waitTiles: this.hud.waitTiles(view),
    };
    const discardPanels = this.panels.discardPanelRects(
      frame,
      this.layoutConfig.id,
      this.webTableLayoutMode
    );
    const discardOptions = this.panels.discardLayoutOptions(
      frame,
      this.webTableLayoutMode
    );
    this.panels.render(frame, discardPanels);
    const policy = tableRenderPolicy(
      this.presentation,
      this.webTableLayoutMode
    );
    if (policy.indicatorCenter) {
      this.hud.renderMobileCenterPanel(frame);
    }
    this.hud.renderDebug(frame);
    const drawer = new MeldTileRenderer(resources, frame.waitTiles);
    const seatPaintOrder: readonly Seat[] = [2, 1, 3, 0];
    for (const seat of seatPaintOrder) {
      if (!isTableSeatActive(view, seat)) {
        continue;
      }
      const hand = this.hands.render(frame, seat, {
        showHands: this.showHands,
        historicalResult: this.results.handResultOverride,
        isRiichiMode: () => this.controls.isRiichiMode,
      });
      this.melds.render(frame, seat, hand, drawer);
      this.discards.render(frame, seat, hand, discardOptions);
      renderNukiTiles(frame, resources, seat, discardPanels);
    }
    this.hud.render(frame, resources, discardPanels, policy.indicatorCenter);
    if (policy.perimeterWalls) {
      this.walls.render(frame);
    }
    renderCallEffects(frame, this.meldAnimator, this.declarationAnimator);
    this.hud.updateLiveHud(view, {
      x: root.position.x + (felt.x + felt.w) * root.scale.x,
      y: root.position.y + (felt.y + felt.h) * root.scale.y,
    });
    this.controls.render(frame, resources, felt);
    this.results.render(frame, resources, drawer);
    this.anchors.publish(frame, discardOptions);
    this.interaction.finishFrame();
  }
  private shortcutFrame(): CanvasShortcutFrame | null {
    const root = this.scene.root;
    const view = this.lastView;
    if (!root || !view) {
      return null;
    }
    return {
      root,
      view,
      layout: tableLayoutFromConfig(this.layoutConfig),
      presentation: this.presentation,
      actionBounds: this.controls.bounds,
    };
  }
  destroy(): void {
    this.interaction.destroy();
    this.canvasInteractions.destroy();
    this.hud.destroy();
    this.animator.reset();
    this.meldAnimator.reset();
    this.declarationAnimator.reset();
    this.assets.destroy();
    this.scene.destroy();
  }
}
