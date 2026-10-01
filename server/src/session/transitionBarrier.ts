import type { MatchRuntime } from "../runtime";

export type TransitionKind =
  | "win_reaction"
  | "exhaustive_draw_reaction"
  | "turn_pacing"
  | "bot_discard_pacing"
  | "auto_riichi_pacing"
  | "match_end_display"
  | "win_to_panel"
  | "ryuukyoku_declaration_pacing"
  | "ryuukyoku_result_pacing";

export class TransitionBarrier {
  private active: TransitionKind | null = null;

  constructor(private readonly runtime: MatchRuntime) {}

  get kind(): TransitionKind | null {
    return this.active;
  }

  async run(transition: TransitionKind, delayMs: number): Promise<void> {
    if (this.active !== null) {
      throw new Error(
        `MatchProcess: nested transition ${transition} during ${this.active}`
      );
    }
    this.active = transition;
    try {
      await this.runtime.sleep(delayMs);
    } finally {
      if (this.active === transition) {
        this.active = null;
      }
    }
  }
}
