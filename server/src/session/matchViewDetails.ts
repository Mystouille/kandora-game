import { estimateDuplicateExhaustion } from "~/game/duplicate/duplicateExhaustion";
import type { DuplicateWallState } from "~/game/protocol/messages";
import type { MatchKernel } from "./matchKernel";

export class MatchViewDetails {
  constructor(private readonly kernel: MatchKernel) {}

  computeSinking(): [boolean, boolean, boolean, boolean] {
    const state = this.kernel.view;
    if (!state.ruleSet.buuMode) {
      return [false, false, false, false];
    }
    const threshold = state.ruleSet.sinkThreshold;
    return [
      state.scores[0] <= threshold,
      state.scores[1] <= threshold,
      state.scores[2] <= threshold,
      state.scores[3] <= threshold,
    ];
  }

  duplicateWallState(): DuplicateWallState | undefined {
    const counts = this.kernel.duplicateQueueCounts();
    if (counts === null) {
      return undefined;
    }
    const state = this.kernel.view;
    const forecast = estimateDuplicateExhaustion(counts.remaining, {
      phase: state.phase,
      turn: state.turn,
      pendingReplacementSeat: state.pendingShouminkan?.seat ?? null,
    });
    return {
      initial: [...counts.initial],
      remaining: [...counts.remaining],
      limitingSeat: forecast?.limitingSeat ?? null,
      estimatedDrawsRemaining: forecast?.estimatedDrawsRemaining ?? null,
    };
  }

  duplicateWallEventFields():
    { duplicateWallState: DuplicateWallState } | Record<string, never> {
    const duplicateWallState = this.duplicateWallState();
    return duplicateWallState ? { duplicateWallState } : {};
  }
}
