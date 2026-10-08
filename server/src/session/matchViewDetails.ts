import { copySeatValues } from "~/game/rules/seats";
import { seatValues } from "~/game/rules/seats";
import { type SeatValues } from "~/game/protocol/seat";
import { estimateDuplicateExhaustion } from "~/game/duplicate/duplicateExhaustion";
import type { DuplicateWallState } from "~/game/protocol/messages";
import type { MatchKernel } from "./matchKernel";

export class MatchViewDetails {
  constructor(private readonly kernel: MatchKernel) {}

  computeSinking(): SeatValues<boolean> {
    const state = this.kernel.view;
    if (!state.ruleSet.buuMode) {
      return seatValues(state.ruleSet.playerCount, () => false);
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
      pendingReplacementSeat:
        state.pendingNuki?.seat ?? state.pendingShouminkan?.seat ?? null,
      pendingOpeningReplacement: state.pendingNuki?.opening ?? false,
    });
    return {
      initial: copySeatValues(counts.initial),
      remaining: copySeatValues(counts.remaining),
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
