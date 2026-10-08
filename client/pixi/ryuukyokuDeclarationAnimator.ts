import type { MatchView } from "../store";
import { copySeatValues } from "~/game/rules/seats";
import {
  CALL_EFFECT_DURATION_MS,
  callEffectPresentation,
} from "./meldAnimator";

export const RYUUKYOKU_DECLARATION_EFFECT_DURATION_MS = CALL_EFFECT_DURATION_MS;

export interface RyuukyokuDeclarationEffectFrame {
  seat: number;
  label: "Tenpai" | "Noten";
  alpha: number;
  scale: number;
}

interface RyuukyokuDeclarationAnimatorOptions {
  now?: () => number;
}

interface RyuukyokuDeclarationEffect {
  seat: number;
  label: RyuukyokuDeclarationEffectFrame["label"];
  startMs: number;
}

type DeclarationView = Pick<
  MatchView,
  "ryuukyokuDeclarations" | "lastHandResult"
>;

function snapshotDeclarations(
  view: DeclarationView
): MatchView["ryuukyokuDeclarations"] {
  return copySeatValues(view.ryuukyokuDeclarations);
}

/**
 * Diffs public exhaustive-draw declarations between render frames. Live,
 * one-at-a-time declarations get a callout; hydration, seeking, and merged
 * archived hand-end jumps remain static.
 */
export class RyuukyokuDeclarationAnimator {
  private readonly now: () => number;
  private previousDeclarations: MatchView["ryuukyokuDeclarations"] | null =
    null;
  private effect: RyuukyokuDeclarationEffect | null = null;
  private enabled = true;
  private snapNextFlag = false;

  constructor(options: RyuukyokuDeclarationAnimatorOptions = {}) {
    this.now = options.now ?? (() => performance.now());
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) {
      this.effect = null;
    }
  }

  snapNext(): void {
    this.snapNextFlag = true;
    this.effect = null;
  }

  reset(): void {
    this.previousDeclarations = null;
    this.effect = null;
    this.snapNextFlag = false;
  }

  beginFrame(view: DeclarationView): void {
    const current = snapshotDeclarations(view);
    const previous = this.previousDeclarations;
    const now = this.now();
    this.previousDeclarations = current;
    this.dropCompleted(now);

    if (this.snapNextFlag) {
      this.snapNextFlag = false;
      this.effect = null;
      return;
    }
    if (!previous || !this.enabled) {
      return;
    }

    const additions: Array<{ seat: number; tenpai: boolean }> = [];
    let changedCount = 0;
    for (let seat = 0; seat < current.length; seat++) {
      const currentDeclaration = current[seat];
      if (previous[seat] === currentDeclaration) {
        continue;
      }
      changedCount += 1;
      if (previous[seat] === null && currentDeclaration !== null) {
        additions.push({ seat, tenpai: currentDeclaration });
      }
    }

    if (
      view.lastHandResult !== null ||
      changedCount !== 1 ||
      additions.length !== 1
    ) {
      if (changedCount > 0 || view.lastHandResult !== null) {
        this.effect = null;
      }
      return;
    }

    const addition = additions[0];
    this.effect = {
      seat: addition.seat,
      label: addition.tenpai ? "Tenpai" : "Noten",
      startMs: now,
    };
  }

  getCallEffect(): RyuukyokuDeclarationEffectFrame | null {
    const now = this.now();
    this.dropCompleted(now);
    if (!this.effect) {
      return null;
    }
    const progress =
      (now - this.effect.startMs) / RYUUKYOKU_DECLARATION_EFFECT_DURATION_MS;
    return {
      seat: this.effect.seat,
      label: this.effect.label,
      ...callEffectPresentation(progress),
    };
  }

  hasActive(): boolean {
    this.dropCompleted(this.now());
    return this.effect !== null;
  }

  private dropCompleted(now: number): void {
    if (
      this.effect &&
      now - this.effect.startMs >= RYUUKYOKU_DECLARATION_EFFECT_DURATION_MS
    ) {
      this.effect = null;
    }
  }
}
