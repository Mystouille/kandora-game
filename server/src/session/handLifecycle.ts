import type { Seat } from "~/game/protocol/messages";

import type {
  PlayingReadyCheckpoint,
  PlayingResultTransitionCheckpoint,
} from "../checkpoint";

import { MatchKernel } from "./matchKernel";

import type { HandLifecyclePort } from "./lifecyclePorts";

import { gameTiming } from "./timingPolicy";

export class HandLifecycle {
  private pendingWinRevealMs = 0;

  constructor(
    private readonly kernel: MatchKernel,
    private readonly port: HandLifecyclePort
  ) {}
  get pendingRevealMs(): number {
    return this.pendingWinRevealMs;
  }
  recordWinReveal(durationMs: number): void {
    this.pendingWinRevealMs = Math.max(this.pendingWinRevealMs, durationMs);
  }

  async beginInitialHandAfterReady(): Promise<void> {
    await this.port.emitEvent({
      type: "hand_start",
      round: 0,
      dealer: this.kernel.currentState().dealer,
      roundWind: this.kernel.currentState().roundWind,
      roundNumber: this.kernel.currentState().roundNumber,
      honba: this.kernel.currentState().honba,
      riichiSticks: this.kernel.currentState().riichiSticks,
      scores: [...this.kernel.currentState().scores] as [
        number,
        number,
        number,
        number,
      ],
      sinking: this.port.computeSinking(),
      hand: undefined,
      doraIndicators: [...this.kernel.currentState().doraIndicators],
      dice: this.port.rollDice(),
      ...this.port.duplicateWallEventFields(),
    });

    await this.port.advanceTurn();
  }

  async afterHandEnd(): Promise<void> {
    if (this.kernel.currentState().phase === "match_ended") {
      await this.port.endMatch(
        this.kernel.currentState().lastHandResult?.reason ?? "exhaustive_draw",
        { skipHandEnd: true }
      );
      return;
    }
    if (this.kernel.currentState().phase !== "hand_ended") {
      return;
    }

    this.port.resetCallState();

    for (let s = 0; s < 4; s++) {
      this.port.clearLegals(s as Seat);
    }

    if (gameTiming.NEXT_HAND_DELAY_MS > 0) {
      const revealMs = this.pendingWinRevealMs;
      this.pendingWinRevealMs = 0;
      if (revealMs > 0) {
        await this.port.runResultTransition(
          "post_hand_reveal",
          revealMs,
          gameTiming.NEXT_HAND_DELAY_MS
        );
      }
      await this.port.runReadyCheck(gameTiming.NEXT_HAND_DELAY_MS, "next_hand");
    } else {
      this.pendingWinRevealMs = 0;
    }

    await this.beginNextHandAfterReady();
  }

  async beginNextHandAfterReady(): Promise<void> {
    const result = this.kernel.startNextHand(this.port.gameIndex());
    for (const ev of result.events) {
      await this.port.emitEngineEvent(ev);
      if (this.port.gameFinalized()) {
        return;
      }
    }
    await this.port.emitFuritenChanges(result.furitenChanges);
    if (
      this.kernel.currentState().phase === "match_ended" ||
      this.port.gameFinalized()
    ) {
      return;
    }
    await this.port.advanceTurn();
  }

  async resumeReadyContinuation(
    continuation: PlayingReadyCheckpoint["readyContinuation"]
  ): Promise<void> {
    if (continuation === "initial_hand") {
      await this.beginInitialHandAfterReady();
    } else {
      await this.beginNextHandAfterReady();
    }
  }

  async resumeResultTransition(
    transitionKind: PlayingResultTransitionCheckpoint["transitionKind"],
    nextReadyMs: number
  ): Promise<void> {
    if (transitionKind === "post_hand_reveal" && nextReadyMs > 0) {
      await this.port.runReadyCheck(nextReadyMs, "next_hand");
    }
    await this.beginNextHandAfterReady();
  }
}
