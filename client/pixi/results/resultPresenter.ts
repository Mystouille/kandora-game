import { Container, Graphics } from "pixi.js";
import { playGameSound } from "../../sound";
import type {
  HandResult,
  RenderFrame,
  RenderResources,
} from "../scene/renderTypes";
import type { Rect } from "../tableLayout";
import {
  advanceMatchEndRevealSound,
  shouldStageWinReveal,
  winResultRevealKey,
} from "../geometry/resultReveal";
import { renderMatchEnd } from "./matchEndPanel";
import { renderResultCenterPanel } from "./resultPanels";
import { buildNonWinResultRows, buildWinResultRows } from "./resultRows";
import {
  renderResultScoreBoxes,
  renderResultStickInfo,
} from "./resultScoreBoxes";
import {
  DEFAULT_RESULT_LABELS,
  type MeldDrawingPort,
  type ResultLabels,
  type ResultRow,
  type ResultRowPlan,
} from "./resultTypes";

export class ResultPresenter {
  private showHandResult = true;
  private stagedRevealEnabled = true;
  private resultOverride: HandResult | null = null;
  private resultLabels: ResultLabels = {
    ...DEFAULT_RESULT_LABELS,
    abortKinds: { ...DEFAULT_RESULT_LABELS.abortKinds },
    chomboReasons: { ...DEFAULT_RESULT_LABELS.chomboReasons },
  };
  private pressHidden = false;
  private pressEnabled = false;
  private winPageIndex = 0;
  private winPageResultKey: string | null = null;
  private winPageRevealStartedAt: number | null = null;
  private winPageYakuRevealSoundsPlayed = 0;
  private winPageUraRevealSoundPlayed = false;
  private matchEndRevealSoundPlayed = false;
  private resultPanelBoundsListener: ((rect: Rect | null) => void) | null =
    null;
  private resultPanelBounds: Rect | null = null;

  constructor(
    private readonly requestRender: () => void,
    private readonly rerenderNow: () => void = requestRender
  ) {}

  get handResultOverride(): HandResult | null {
    return this.resultOverride;
  }

  get winInfoPressEnabled(): boolean {
    return this.pressEnabled;
  }

  get handResultPressHidden(): boolean {
    return this.pressHidden;
  }

  get lastResultPanelBounds(): Readonly<Rect> | null {
    return this.resultPanelBounds;
  }

  setShowHandResult(flag: boolean): void {
    this.showHandResult = flag;
  }

  setStagedRevealEnabled(flag: boolean): void {
    if (this.stagedRevealEnabled === flag) {
      return;
    }
    this.stagedRevealEnabled = flag;
    this.winPageRevealStartedAt = null;
    this.requestRender();
  }

  setHandResultOverride(result: HandResult | null): void {
    this.resultOverride = result;
  }

  setResultLabels(labels: ResultLabels): void {
    this.resultLabels = labels;
  }

  setResultPanelBoundsListener(
    callback: ((rect: Rect | null) => void) | null
  ): void {
    this.resultPanelBoundsListener = callback;
  }

  hideHandResult(): void {
    this.pressHidden = true;
    this.requestRender();
  }

  restoreHandResult(): void {
    if (!this.pressHidden) {
      return;
    }
    this.pressHidden = false;
    this.requestRender();
  }

  render(
    frame: RenderFrame,
    resources: RenderResources,
    melds: MeldDrawingPort
  ): Rect | null {
    const { view, layout, root } = frame;
    const cx = layout.center.x + layout.center.w / 2;
    const cy = layout.center.y + layout.center.h / 2;
    const effectiveResult = this.resultOverride ?? view.lastHandResult;
    if (!effectiveResult || view.matchEnded) {
      this.winPageResultKey = null;
      this.winPageIndex = 0;
      this.winPageRevealStartedAt = null;
    }
    this.pressEnabled = Boolean(effectiveResult && !view.matchEnded);
    let designRect: Rect | null = null;
    if (this.showHandResult && !this.pressHidden) {
      if (effectiveResult && !view.matchEnded) {
        designRect = this.renderHandResult(
          frame,
          resources,
          melds,
          effectiveResult,
          cx,
          cy
        );
      }
      if (view.matchEnded) {
        designRect = renderMatchEnd(view, root, resources, cx, cy);
      }
    }
    const revealSound = advanceMatchEndRevealSound(
      this.matchEndRevealSoundPlayed,
      view.matchEnded !== null,
      view.matchEnded !== null && designRect !== null
    );
    this.matchEndRevealSoundPlayed = revealSound.nextPlayed;
    if (revealSound.play) {
      playGameSound("yaku-reveal");
    }
    this.publishBounds(root, designRect);
    return designRect;
  }

  private renderHandResult(
    frame: RenderFrame,
    resources: RenderResources,
    melds: MeldDrawingPort,
    result: HandResult,
    cx: number,
    cy: number
  ): Rect | null {
    const { view, layout, root } = frame;
    const resultKey = winResultRevealKey(view, result);
    if (this.winPageResultKey !== resultKey) {
      this.winPageResultKey = resultKey;
      this.winPageIndex = 0;
      this.winPageRevealStartedAt = null;
    }
    // A transient win event has no final deltas; wait for hand_end.
    if (result.wins && result.wins.length > 0 && !result.delta) {
      return null;
    }
    const inner: Rect = {
      x: layout.hands[3].x + layout.hands[3].w,
      y: layout.hands[2].y + layout.hands[2].h,
      w: layout.hands[1].x - (layout.hands[3].x + layout.hands[3].w),
      h: layout.hands[0].y - (layout.hands[2].y + layout.hands[2].h),
    };
    const overlay = new Container();
    overlay.zIndex = 1000;
    root.sortableChildren = true;
    root.addChild(overlay);
    const backdrop = new Graphics()
      .rect(inner.x, inner.y, inner.w, inner.h)
      .fill({ color: 0x000000, alpha: 0.6 });
    overlay.addChild(backdrop);
    let scoreDeltaRevealed = true;
    let rows: readonly ResultRow[];
    if (result.wins && result.wins.length > 0 && !result.buuChombo) {
      if (this.winPageIndex >= result.wins.length) {
        this.winPageIndex = 0;
        this.winPageRevealStartedAt = null;
      }
      const stageReveal = shouldStageWinReveal(
        this.stagedRevealEnabled,
        this.resultOverride !== null
      );
      if (stageReveal) {
        if (this.winPageRevealStartedAt === null) {
          this.winPageRevealStartedAt = performance.now();
          this.winPageYakuRevealSoundsPlayed = 0;
          this.winPageUraRevealSoundPlayed = false;
        }
      } else {
        this.winPageRevealStartedAt = null;
      }
      const revealElapsedMs = stageReveal
        ? performance.now() - (this.winPageRevealStartedAt ?? 0)
        : Number.POSITIVE_INFINITY;
      const plan = buildWinResultRows(
        { ...result, wins: result.wins },
        this.winPageIndex,
        stageReveal,
        revealElapsedMs,
        view.scoreCap,
        view.uraDoraEnabled,
        view.playerCount === 3 && view.sanmaType === "kansai"
      );
      this.advanceRevealSounds(plan, stageReveal);
      rows = plan.rows;
      scoreDeltaRevealed = plan.scoreDeltaRevealed;
      if (stageReveal && !plan.scoreSummaryRevealed) {
        this.requestRender();
      }
    } else {
      rows = buildNonWinResultRows(result, view.seatNames, this.resultLabels);
    }
    const totalPages = result.wins?.length ?? 0;
    renderResultCenterPanel(
      rows,
      cx,
      cy,
      overlay,
      resources,
      melds,
      totalPages > 1 ? () => this.advancePage(totalPages) : null
    );
    renderResultStickInfo(result, inner, overlay);
    renderResultScoreBoxes(view, result, inner, overlay, scoreDeltaRevealed);
    return inner;
  }

  private advanceRevealSounds(plan: ResultRowPlan, stageReveal: boolean): void {
    if (
      stageReveal &&
      plan.revealedYakuCount > this.winPageYakuRevealSoundsPlayed
    ) {
      const count = plan.revealedYakuCount - this.winPageYakuRevealSoundsPlayed;
      for (let index = 0; index < count; index++) {
        playGameSound("yaku-reveal");
      }
      this.winPageYakuRevealSoundsPlayed = plan.revealedYakuCount;
    }
    if (
      stageReveal &&
      plan.uraIndicatorsRevealed &&
      !this.winPageUraRevealSoundPlayed
    ) {
      if (!plan.hasUraYaku) {
        playGameSound("yaku-reveal");
      }
      this.winPageUraRevealSoundPlayed = true;
    }
  }

  private advancePage(total: number): void {
    if (total <= 1) {
      return;
    }
    this.winPageIndex = (this.winPageIndex + 1) % total;
    this.winPageRevealStartedAt = null;
    this.rerenderNow();
  }

  private publishBounds(root: Container, designRect: Rect | null): void {
    const nextBounds = designRect
      ? {
          x: designRect.x * root.scale.x + root.position.x,
          y: designRect.y * root.scale.y + root.position.y,
          w: designRect.w * root.scale.x,
          h: designRect.h * root.scale.y,
        }
      : null;
    const previous = this.resultPanelBounds;
    const changed =
      (previous === null) !== (nextBounds === null) ||
      (previous !== null &&
        nextBounds !== null &&
        (previous.x !== nextBounds.x ||
          previous.y !== nextBounds.y ||
          previous.w !== nextBounds.w ||
          previous.h !== nextBounds.h));
    if (changed) {
      this.resultPanelBounds = nextBounds;
      this.resultPanelBoundsListener?.(nextBounds);
    }
  }

  destroy(): void {
    this.resultPanelBoundsListener = null;
    this.resultPanelBounds = null;
    this.pressEnabled = false;
    this.pressHidden = false;
    this.winPageResultKey = null;
    this.winPageIndex = 0;
    this.winPageRevealStartedAt = null;
    this.winPageYakuRevealSoundsPlayed = 0;
    this.winPageUraRevealSoundPlayed = false;
    this.matchEndRevealSoundPlayed = false;
  }
}
