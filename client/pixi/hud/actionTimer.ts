import { Text, TextStyle } from "pixi.js";
import type { MatchView } from "../../store";
import type { ActionWindowView } from "~/game/protocol/timing";
import { synchronizedWindowNow } from "../../time/liveTimingBinding";
import { playGameCountdownSound } from "../../sound";
import type { TableRendererPresentation } from "../scene/renderTypes";
import type { TimerAnchor, TimerHost } from "./hudTypes";
import {
  projectActionTimer,
  resolveTableHudState,
} from "./actionTimerViewModel";

function actionTimerStyle(
  presentation: TableRendererPresentation,
  fill: number,
  fontWeight: "700" | "800"
): TextStyle {
  const mobile = presentation === "mobile";
  return new TextStyle({
    fontFamily: "Inter, system-ui, sans-serif",
    fontSize: mobile ? 24 : 18,
    fontWeight,
    fill,
    stroke: { color: 0x000000, width: mobile ? 5 : 4, join: "round" },
  });
}

const actionTimerStyles = {
  standard: {
    normal: actionTimerStyle("standard", 0xffffff, "700"),
    warn: actionTimerStyle("standard", 0xfacc15, "700"),
    danger: actionTimerStyle("standard", 0xef4444, "800"),
  },
  mobile: {
    normal: actionTimerStyle("mobile", 0xffffff, "700"),
    warn: actionTimerStyle("mobile", 0xfacc15, "700"),
    danger: actionTimerStyle("mobile", 0xef4444, "800"),
  },
};

export type ActionTimerView = Pick<
  MatchView,
  | "conn"
  | "drawsTaken"
  | "lastSeq"
  | "readyCheck"
  | "actionDeadline"
  | "actionBufferMs"
  | "actionWindow"
>;

export class ActionTimer {
  private host: TimerHost | null = null;
  private timerText: Text | null = null;
  private presentation: TableRendererPresentation = "standard";
  private timerAnchor: TimerAnchor | null = null;
  private actionDeadline: number | null = null;
  private actionBufferMs: number | null = null;
  private window: ActionWindowView | null = null;
  private lastTimerSeconds: number | null = null;
  private readonly tickHandler = (): void => {
    this.tick();
  };

  mount(host: TimerHost, presentation: TableRendererPresentation): void {
    this.destroy();
    this.host = host;
    this.presentation = presentation;
    const timer = new Text({
      text: "",
      style: actionTimerStyles[presentation].normal,
    });
    timer.anchor.set(1, 1);
    timer.position.set(host.screen.width - 6, host.screen.height - 4);
    timer.visible = false;
    host.stage.addChild(timer);
    this.timerText = timer;
    host.ticker.add(this.tickHandler);
  }

  update(
    view: ActionTimerView,
    diagnosticsOrAnchor?: boolean | TimerAnchor | null,
    timerAnchor: TimerAnchor | null = null
  ): void {
    const state = resolveTableHudState(
      view,
      typeof diagnosticsOrAnchor === "boolean" ? diagnosticsOrAnchor : false
    );
    this.actionDeadline = state.deadline;
    this.actionBufferMs = state.bufferMs;
    this.window = view.actionWindow ?? null;
    this.timerAnchor =
      typeof diagnosticsOrAnchor === "object" && diagnosticsOrAnchor !== null
        ? diagnosticsOrAnchor
        : timerAnchor;
    this.tick();
  }

  render(
    view: ActionTimerView,
    diagnosticsOrAnchor?: boolean | TimerAnchor | null,
    timerAnchor: TimerAnchor | null = null
  ): void {
    if (
      typeof diagnosticsOrAnchor === "boolean" ||
      diagnosticsOrAnchor === undefined
    ) {
      this.update(view, diagnosticsOrAnchor, timerAnchor);
    } else {
      this.update(view, diagnosticsOrAnchor);
    }
  }

  tick(): void {
    const timer = this.timerText;
    if (!timer) {
      return;
    }
    const inset =
      this.presentation === "mobile" ? { x: 10, y: 10 } : { x: 6, y: 4 };
    if (this.timerAnchor) {
      timer.position.set(
        this.timerAnchor.x - inset.x,
        this.timerAnchor.y - inset.y
      );
    } else if (this.host) {
      timer.position.set(
        this.host.screen.width - inset.x,
        this.host.screen.height - inset.y
      );
    }
    const deadline = this.actionDeadline;
    if (deadline === null) {
      if (timer.visible) {
        timer.visible = false;
      }
      this.lastTimerSeconds = null;
      return;
    }
    const authorityNow = this.window
      ? synchronizedWindowNow(this.window)
      : null;
    if (this.window && authorityNow === null) {
      timer.text = "Synchronizing clock";
      timer.visible = true;
      return;
    }
    const frame = projectActionTimer(
      this.window?.baseEndsAt ?? deadline,
      this.window?.bankAtOpenMs ?? this.actionBufferMs,
      this.window && authorityNow !== null
        ? Math.max(authorityNow, this.window.opensAt)
        : Date.now(),
      this.lastTimerSeconds
    );
    if (timer.text !== frame.text) {
      timer.text = frame.text;
    }
    const nextStyle = actionTimerStyles[this.presentation][frame.style];
    if (timer.style !== nextStyle) {
      timer.style = nextStyle;
    }
    if (!timer.visible) {
      timer.visible = true;
    }
    if (frame.play) {
      playGameCountdownSound(
        "timer-tick",
        `action:${deadline}`,
        frame.displayedTotalSeconds
      );
    }
    this.lastTimerSeconds = frame.displayedTotalSeconds;
  }

  destroy(): void {
    this.host?.ticker.remove(this.tickHandler);
    this.timerText?.destroy({ texture: false });
    this.host = null;
    this.timerText = null;
    this.timerAnchor = null;
    this.actionDeadline = null;
    this.actionBufferMs = null;
    this.window = null;
    this.lastTimerSeconds = null;
  }
}
