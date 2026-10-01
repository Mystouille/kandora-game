import { Graphics, Text, TextStyle } from "pixi.js";
import type { MatchView } from "../../store";
import type {
  RenderFrame,
  RenderResources,
  SeatEnrichment,
  TableRendererPresentation,
} from "../scene/renderTypes";
import { RELATIVE_SCORE_DISPLAY_MS } from "../geometry/renderConstants";
import { ActionTimer } from "./actionTimer";
import { renderMobileCenterInfo, renderMobileCenterPanel } from "./centerInfo";
import { renderLayoutDebug, renderWallZonesDebug } from "./debugRenderer";
import {
  DEFAULT_CENTER_LABELS,
  type CenterLabels,
  type DiscardPanelRects,
  type TimerAnchor,
  type TimerHost,
} from "./hudTypes";
import { resolveTableHudState } from "./legacyTimerViewModel";
import { NameRenderer } from "./nameRenderer";
import { renderRoundInfo } from "./roundRenderer";
import { renderScores } from "./scoreRenderer";

const hudStyle = new TextStyle({
  fontFamily: "Inter, system-ui, sans-serif",
  fontSize: 14,
  fill: 0xffffff,
});

export class HudRenderer {
  private centerLabels: CenterLabels = { ...DEFAULT_CENTER_LABELS };
  private showNames = true;
  private showWaits = false;
  private showRelativeScores = false;
  private showLayoutDebug = false;
  private showWallZonesDebug = false;
  private showConnectionDiagnostics = true;
  private relativeScoresResetTimer: ReturnType<typeof setTimeout> | null = null;
  private diagnosticsText: Text | null = null;
  private readonly actionTimer = new ActionTimer();
  private readonly names: NameRenderer;

  constructor(private readonly requestRender: () => void) {
    this.names = new NameRenderer(requestRender);
  }

  mount(host: TimerHost, presentation: TableRendererPresentation): void {
    this.diagnosticsText?.destroy({ texture: false });
    const diagnostics = new Text({ text: "", style: hudStyle });
    diagnostics.position.set(16, 16);
    host.stage.addChild(diagnostics);
    this.diagnosticsText = diagnostics;
    this.actionTimer.mount(host, presentation);
  }

  setShowNames(flag: boolean): void {
    this.showNames = flag;
  }

  setShowWaits(flag: boolean): void {
    this.showWaits = flag;
  }

  setShowLayoutDebug(flag: boolean): void {
    this.showLayoutDebug = flag;
  }

  setShowWallZonesDebug(flag: boolean): void {
    this.showWallZonesDebug = flag;
  }

  setConnectionDiagnosticsVisible(flag: boolean): void {
    this.showConnectionDiagnostics = flag;
  }

  setCenterLabels(labels: CenterLabels): void {
    this.centerLabels = labels;
  }

  setSeatEnrichment(list: (SeatEnrichment | null)[]): void {
    this.names.setSeatEnrichment(list);
  }

  waitTiles(
    view: Pick<MatchView, "currentWaits" | "mySeat">
  ): ReadonlySet<string> {
    if (
      this.showWaits &&
      view.currentWaits &&
      view.mySeat !== null &&
      view.mySeat !== undefined
    ) {
      return new Set(view.currentWaits[view.mySeat] ?? []);
    }
    return new Set();
  }

  renderMobileCenterPanel(frame: RenderFrame): void {
    renderMobileCenterPanel(frame);
  }

  renderDebug(frame: RenderFrame): void {
    if (this.showLayoutDebug) {
      renderLayoutDebug(frame);
    }
    if (this.showWallZonesDebug) {
      renderWallZonesDebug(frame);
    }
  }

  render(
    frame: RenderFrame,
    resources: RenderResources,
    discardPanels: DiscardPanelRects,
    indicatorCenter: boolean
  ): void {
    this.renderCenterScoreToggle(frame);
    renderScores(frame, this.showRelativeScores, this.showWaits);
    if (this.showNames) {
      this.names.render(frame, resources, discardPanels, this.centerLabels);
    }
    if (indicatorCenter) {
      renderMobileCenterInfo(frame, resources);
    } else {
      renderRoundInfo(frame, this.centerLabels);
    }
  }

  updateLiveHud(view: MatchView, timerAnchor: TimerAnchor | null): void {
    const state = resolveTableHudState(view, this.showConnectionDiagnostics);
    if (this.diagnosticsText) {
      this.diagnosticsText.text = state.diagnostics;
    }
    this.actionTimer.update(view, timerAnchor);
  }

  private renderCenterScoreToggle(frame: RenderFrame): void {
    const center = frame.layout.center;
    const area = new Graphics()
      .rect(center.x, center.y, center.w, center.h)
      .fill({ color: 0x000000, alpha: 0.001 });
    area.eventMode = "static";
    area.cursor = "pointer";
    area.on("pointerdown", (event) => {
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
    frame.root.addChild(area);
  }

  destroy(): void {
    if (this.relativeScoresResetTimer !== null) {
      clearTimeout(this.relativeScoresResetTimer);
      this.relativeScoresResetTimer = null;
    }
    this.actionTimer.destroy();
    this.diagnosticsText?.destroy({ texture: false });
    this.diagnosticsText = null;
    this.names.destroy();
  }
}
