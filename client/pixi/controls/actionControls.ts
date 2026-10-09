import { Container } from "pixi.js";
import type { LegalAction } from "~/game/protocol/messages";
import type { MatchView } from "../../store";
import { decisionIsReady } from "../../time/liveTimingBinding";
import { intentForWindow } from "../../time/actionWindowViewModel";
import {
  filterNoCallActionButtons,
  shouldDeferCallPromptControls,
} from "../../callPrompt";
import type { DiscardAnimator } from "../discardAnimator";
import type { Rect } from "../tableLayout";
import type {
  ActionClick,
  RenderFrame,
  RenderResources,
} from "../scene/renderTypes";
import {
  actionButtonStyle,
  layoutActionButtonRows,
  orderedRyuukyokuDeclarationActions,
} from "../geometry/actionGeometry";
import {
  drawActionButton,
  drawCallGroupButton,
  drawCallOptionButton,
  drawRiichiToggleButton,
  type ActionButtonNode,
  type CallGroup,
} from "./actionButtonNodes";

type Entry =
  | { kind: "action"; action: LegalAction }
  | { kind: "group"; group: CallGroup; actions: LegalAction[] }
  | { kind: "riichi" };

export class ActionControls {
  private riichiMode = false;
  private expandedCallGroup: CallGroup | null = null;
  private actionButtonBounds: Rect[] = [];
  private mobileActionButtonRightBoundaryPx: number | null = null;
  private autoWinEnabled = false;
  private noCallEnabled = false;

  constructor(
    private readonly animator: DiscardAnimator,
    private readonly requestRender: () => void,
    private readonly onActionClick: (click: ActionClick) => void
  ) {}

  get isRiichiMode(): boolean {
    return this.riichiMode;
  }

  get bounds(): ReadonlyArray<Readonly<Rect>> {
    return this.actionButtonBounds;
  }

  beginFrame(view: Pick<MatchView, "legalActions">): void {
    if (
      this.riichiMode &&
      !view.legalActions.some((action) => action.type === "riichi")
    ) {
      this.riichiMode = false;
    }
  }

  clearRiichiMode(): void {
    this.riichiMode = false;
  }

  setMobileActionButtonRightBoundary(boundaryPx: number | null): void {
    if (this.mobileActionButtonRightBoundaryPx === boundaryPx) {
      return;
    }
    this.mobileActionButtonRightBoundaryPx = boundaryPx;
    this.requestRender();
  }

  setAutoWinEnabled(flag: boolean): void {
    if (this.autoWinEnabled === flag) {
      return;
    }
    this.autoWinEnabled = flag;
    this.requestRender();
  }

  setNoCallEnabled(flag: boolean): void {
    if (this.noCallEnabled === flag) {
      return;
    }
    this.noCallEnabled = flag;
    this.requestRender();
  }

  render(frame: RenderFrame, resources: RenderResources, felt: Rect): void {
    const { view, layout, root, presentation } = frame;
    this.actionButtonBounds = [];
    if (!decisionIsReady(view.actionWindow)) {
      return;
    }
    const intent = view.actionWindow
      ? intentForWindow(view.actionWindow, view.lastSeq)
      : undefined;
    if (view.lastHandResult !== null || view.matchEnded) {
      return;
    }
    if (
      shouldDeferCallPromptControls(
        view.legalActions,
        this.animator.isDiscardPresentationPending()
      )
    ) {
      this.expandedCallGroup = null;
      return;
    }
    const raw = filterNoCallActionButtons(
      view.legalActions,
      this.noCallEnabled
    ).filter((action) => {
      if (view.playerCount === 3 && action.type === "chi") {
        return false;
      }
      if (
        view.playerCount === 3 &&
        view.sanmaType === "kansai" &&
        action.type === "nuki"
      ) {
        return false;
      }
      if (action.type === "discard" || action.type === "draw") {
        return false;
      }
      if (
        this.autoWinEnabled &&
        (action.type === "ron" || action.type === "tsumo")
      ) {
        return false;
      }
      return true;
    });
    const chi = raw.filter((action) => action.type === "chi");
    const pon = raw.filter((action) => action.type === "pon");
    const kan = raw.filter((action) => action.type === "kan");
    const declarations = orderedRyuukyokuDeclarationActions(raw);
    const others = raw.filter(
      (action) =>
        action.type !== "chi" &&
        action.type !== "pon" &&
        action.type !== "kan" &&
        action.type !== "riichi" &&
        action.type !== "declare_tenpai" &&
        action.type !== "declare_noten"
    );
    const riichiAvailable = raw.some((action) => action.type === "riichi");
    if (
      (this.expandedCallGroup === "chi" && chi.length === 0) ||
      (this.expandedCallGroup === "pon" && pon.length === 0) ||
      (this.expandedCallGroup === "kan" && kan.length === 0)
    ) {
      this.expandedCallGroup = null;
    }
    const entries: Entry[] = [];
    for (const action of others.filter((action) => action.type === "pass")) {
      entries.push({ kind: "action", action });
    }
    if (riichiAvailable) {
      entries.push({ kind: "riichi" });
    }
    for (const [group, actions] of [
      ["chi", chi],
      ["pon", pon],
      ["kan", kan],
    ] as const) {
      if (actions.length === 1) {
        entries.push({ kind: "action", action: actions[0] });
      } else if (actions.length > 1) {
        entries.push({ kind: "group", group, actions });
      }
    }
    for (const action of declarations) {
      entries.push({ kind: "action", action });
    }
    for (const action of others.filter((action) => action.type !== "pass")) {
      entries.push({ kind: "action", action });
    }
    if (entries.length === 0) {
      return;
    }
    const style = actionButtonStyle(presentation);
    const leftEdge = felt.x + style.rightInset;
    let rightEdge = felt.x + felt.w - style.rightInset;
    if (
      presentation === "mobile" &&
      this.mobileActionButtonRightBoundaryPx !== null &&
      root.scale.x > 0
    ) {
      const boundaryDesignX =
        (this.mobileActionButtonRightBoundaryPx - root.position.x) /
        root.scale.x;
      rightEdge = Math.min(rightEdge, boundaryDesignX - style.gap);
    }
    const bottomEdge =
      presentation === "mobile"
        ? layout.hands[0].y
        : felt.y + felt.h - style.bottomOffset + style.height;
    const strip = new Container();
    strip.zIndex = 50;
    const rendered: ActionButtonNode[] = [];
    for (const entry of entries) {
      if (entry.kind === "riichi") {
        rendered.push(
          drawRiichiToggleButton(presentation, this.riichiMode, () => {
            this.riichiMode = !this.riichiMode;
            this.requestRender();
          })
        );
      } else if (entry.kind === "group") {
        rendered.push(
          drawCallGroupButton(
            presentation,
            entry.group,
            this.expandedCallGroup,
            (group) => {
              this.expandedCallGroup = group;
              this.requestRender();
            }
          )
        );
      } else {
        rendered.push(
          drawActionButton(
            presentation,
            entry.action,
            (action) =>
              this.onActionClick({ action, ...(intent ? { intent } : {}) }),
            view.rulesFamily === "mcr" &&
              (entry.action.type === "ron" || entry.action.type === "tsumo")
              ? "Hu"
              : undefined
          )
        );
      }
    }
    const mainLayout = layoutActionButtonRows(
      rendered.map(({ w }) => w),
      leftEdge,
      rightEdge,
      bottomEdge,
      style.height,
      style.gap,
      style.optionRowGap
    );
    this.actionButtonBounds.push(
      ...mainLayout.placements.map(({ x, y, w, h }) => ({ x, y, w, h }))
    );
    rendered.forEach(({ c }, index) => {
      const placement = mainLayout.placements[index];
      c.position.set(placement.x, placement.y);
      strip.addChild(c);
    });
    if (this.expandedCallGroup) {
      const options =
        this.expandedCallGroup === "chi"
          ? chi
          : this.expandedCallGroup === "pon"
            ? pon
            : kan;
      if (options.length > 0) {
        const optionNodes = options.map((action) =>
          drawCallOptionButton(
            presentation,
            resources.textureStore,
            action,
            (choice) => {
              this.expandedCallGroup = null;
              this.onActionClick({
                action: choice,
                ...(intent ? { intent } : {}),
              });
            }
          )
        );
        const optionBottomEdge =
          bottomEdge -
          mainLayout.rowCount * (style.height + style.optionRowGap);
        const optionLayout = layoutActionButtonRows(
          optionNodes.map(({ w }) => w),
          leftEdge,
          rightEdge,
          optionBottomEdge,
          style.height,
          style.optionGap,
          style.optionRowGap
        );
        this.actionButtonBounds.push(
          ...optionLayout.placements.map(({ x, y, w, h }) => ({ x, y, w, h }))
        );
        optionNodes.forEach(({ c }, index) => {
          const placement = optionLayout.placements[index];
          c.position.set(placement.x, placement.y);
          strip.addChild(c);
        });
      }
    }
    root.addChild(strip);
  }
}
