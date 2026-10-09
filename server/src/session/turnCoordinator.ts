import type { Seat } from "~/game/protocol/messages";

import { MatchKernel } from "./matchKernel";

import type { TurnWorkflowPort } from "./workflowPorts";

import { gameTiming } from "./timingPolicy";
import { settleAutomaticReplacements } from "./replacementFlow";

export class TurnCoordinator {
  constructor(
    private readonly kernel: MatchKernel,
    private readonly windows: import("../timing/actionWindows").ActionWindowRegistry,
    private readonly port: TurnWorkflowPort
  ) {}

  async resumeNuki(opening: boolean): Promise<void> {
    await settleAutomaticReplacements(
      this.kernel,
      (action) => this.port.applyEngineAction(action),
      opening
    );
    await this.advanceTurn();
  }

  async advanceTurn(): Promise<void> {
    if (
      this.kernel.currentState().phase === "hand_ended" ||
      this.kernel.currentState().phase === "match_ended"
    ) {
      return;
    }
    await settleAutomaticReplacements(this.kernel, (action) =>
      this.port.applyEngineAction(action)
    );
    if (this.kernel.currentState().phase === "awaiting_chankan") {
      return;
    }
    if (this.kernel.currentState().phase === "awaiting_discard") {
      await this.continueDiscardTurn();
      return;
    }
    if (
      this.kernel.currentState().phase === "awaiting_ryuukyoku_declarations" ||
      this.kernel.currentState().phase === "awaiting_ryuukyoku_settlement"
    ) {
      await this.continueRyuukyokuDeclarations();
      return;
    }

    this.kernel.prepareDebugDraw();

    if (gameTiming.DELAY_AFTER_DISCARD_MS > 0) {
      await this.port.runUncheckpointableTransition(
        "turn_pacing",
        gameTiming.DELAY_AFTER_DISCARD_MS
      );
    }

    const drawRes = this.kernel.draw();
    for (const e of drawRes.events) {
      await this.port.emitEngineEvent(e);
    }
    await this.port.emitFuritenChanges(drawRes.furitenChanges);
    await settleAutomaticReplacements(this.kernel, (action) =>
      this.port.applyEngineAction(action)
    );

    const phase = this.kernel.view.phase;
    if (phase === "hand_ended" || phase === "match_ended") {
      await this.port.afterHandEnd();
      return;
    }

    if (
      phase === "awaiting_ryuukyoku_declarations" ||
      phase === "awaiting_ryuukyoku_settlement"
    ) {
      await this.continueRyuukyokuDeclarations();
      return;
    }

    await this.continueDiscardTurn();
  }

  async continueRyuukyokuDeclarations(): Promise<void> {
    if (this.kernel.currentState().phase === "awaiting_ryuukyoku_settlement") {
      if (gameTiming.RYUUKYOKU_RESULT_DELAY_MS > 0) {
        await this.port.runUncheckpointableTransition(
          "ryuukyoku_result_pacing",
          gameTiming.RYUUKYOKU_RESULT_DELAY_MS
        );
      }
      const completed = await this.port.applyEngineAction({
        type: "complete_ryuukyoku",
      });
      if (completed.phase !== "hand_ended") {
        throw new Error(
          "MatchProcess: ryuukyoku completion did not end the hand"
        );
      }
      await this.port.afterHandEnd();
      return;
    }
    if (
      this.kernel.currentState().phase !== "awaiting_ryuukyoku_declarations"
    ) {
      return;
    }
    const pending = this.kernel.currentState().pendingRyuukyoku;
    if (pending === null) {
      throw new Error(
        "MatchProcess: declaration phase has no pending ryuukyoku"
      );
    }
    const seat = this.kernel.currentState().turn;
    const actualTenpai = pending.actualTenpai[seat];
    const requiresHumanChoice =
      actualTenpai &&
      !this.kernel.currentState().riichiDeclared[seat] &&
      this.port.isHumanSeat(seat);
    if (requiresHumanChoice && gameTiming.RYUUKYOKU_DECLARATION_ACTION_MS > 0) {
      this.port.setSeatLegals(
        seat,
        [
          { id: "ryuukyoku:noten", type: "declare_noten" },
          { id: "ryuukyoku:tenpai", type: "declare_tenpai" },
        ],
        "ryuukyoku_declaration"
      );
      this.port.flushLegalsToSeat(seat);
      return;
    }

    if (gameTiming.RYUUKYOKU_AUTOMATIC_DECLARATION_DELAY_MS > 0) {
      await this.port.runUncheckpointableTransition(
        "ryuukyoku_declaration_pacing",
        gameTiming.RYUUKYOKU_AUTOMATIC_DECLARATION_DELAY_MS
      );
    }
    await this.port.applyEngineAction({
      type: "declare_ryuukyoku_status",
      seat,
      tenpai: actualTenpai,
    });
    await this.continueRyuukyokuDeclarations();
  }

  async continueDiscardTurn(): Promise<void> {
    await settleAutomaticReplacements(this.kernel, (action) =>
      this.port.applyEngineAction(action)
    );
    if (
      this.kernel.currentState().phase === "awaiting_ryuukyoku_declarations" ||
      this.kernel.currentState().phase === "awaiting_ryuukyoku_settlement"
    ) {
      await this.continueRyuukyokuDeclarations();
      return;
    }
    if (this.kernel.currentState().phase !== "awaiting_discard") {
      return;
    }
    if (await this.openHumanDiscardWindow(this.kernel.currentState().turn)) {
      return;
    }

    const seat = this.kernel.currentState().turn;

    if (gameTiming.DRAW_TO_DISCARD_DELAY_MS > 0) {
      await this.port.runUncheckpointableTransition(
        "bot_discard_pacing",
        gameTiming.DRAW_TO_DISCARD_DELAY_MS
      );
    }

    if (await this.openHumanDiscardWindow(seat)) {
      return;
    }

    if (!this.kernel.hasForcedBotDiscard(seat)) {
      if (
        this.kernel.currentState().ruleSet.playerCount === 3 ||
        this.kernel.currentState().ruleSet.rulesFamily === "mcr"
      ) {
        if (this.kernel.canTsumo(seat)) {
          await this.port.waitForWinReaction("draw");
          await this.port.applyEngineAction({ type: "tsumo", seat });
          await this.port.afterHandEnd();
          return;
        }
        const legals = this.kernel.discardLegals(seat);
        const flower = legals.find((action) => action.type === "flower");
        if (flower?.tile) {
          await this.port.applyEngineAction({
            type: "flower",
            seat,
            tile: flower.tile,
          });
          await this.afterCall();
          return;
        }
        const nuki = legals.find((action) => action.type === "nuki");
        if (nuki?.tile) {
          await this.port.applyEngineAction({
            type: "nuki",
            seat,
            tile: nuki.tile,
          });
          await this.port.openChankanWindow();
          return;
        }
      }
      const selfKan = this.kernel.botSelfKan(seat);
      if (selfKan !== null) {
        if (selfKan.kind === "ankan") {
          await this.port.applyEngineAction({
            type: "kan",
            seat,
            kind: "ankan",
            tile: selfKan.tile,
          });
          await this.afterCall();
          return;
        }

        await this.port.applyEngineAction({
          type: "kan",
          seat,
          kind: "shouminkan",
          tile: selfKan.tile,
        });
        await this.port.openChankanWindow();
        return;
      }
    }
    const { tile, discardSource } = this.kernel.botDiscard(seat);
    await this.port.applyDiscard(seat, tile, discardSource);
    await this.port.afterDiscard();
  }

  async openHumanDiscardWindow(seat: Seat): Promise<boolean> {
    if (!this.port.isHumanSeat(seat)) {
      return false;
    }
    this.port.setSeatLegals(seat, this.kernel.discardLegals(seat));
    if (await this.maybeAutoRiichiDiscard()) {
      return true;
    }
    this.port.flushLegalsToSeat(seat);
    return true;
  }

  async afterCall(): Promise<void> {
    await settleAutomaticReplacements(this.kernel, (action) =>
      this.port.applyEngineAction(action)
    );
    if (
      this.kernel.currentState().phase === "awaiting_ryuukyoku_declarations" ||
      this.kernel.currentState().phase === "awaiting_ryuukyoku_settlement"
    ) {
      await this.continueRyuukyokuDeclarations();
      return;
    }
    if (
      this.kernel.currentState().phase === "hand_ended" ||
      this.kernel.currentState().phase === "match_ended"
    ) {
      await this.port.afterHandEnd();
      return;
    }

    if (
      this.port.isHumanSeat(this.kernel.currentState().turn) &&
      this.kernel.currentState().phase === "awaiting_discard"
    ) {
      const turnSeat = this.kernel.currentState().turn;
      this.port.setSeatLegals(turnSeat, this.kernel.discardLegals(turnSeat));
      if (await this.maybeAutoRiichiDiscard()) {
        return;
      }
      this.port.flushLegalsToSeat(turnSeat);
      return;
    }

    await this.advanceTurn();
  }

  async maybeAutoRiichiDiscard(): Promise<boolean> {
    const seat = this.kernel.currentState().turn;
    const legals = this.windows.legals(seat);
    if (
      this.port.isHumanSeat(seat) &&
      this.kernel.currentState().riichiDeclared[seat] &&
      legals.length === 1 &&
      legals[0].type === "discard" &&
      legals[0].tile
    ) {
      const tile = legals[0].tile;

      if (gameTiming.DRAW_TO_DISCARD_DELAY_MS > 0) {
        await this.port.runUncheckpointableTransition(
          "auto_riichi_pacing",
          gameTiming.DRAW_TO_DISCARD_DELAY_MS
        );
      }
      await this.port.applyDiscard(seat, tile, legals[0].discardSource);
      await this.port.afterDiscard();
      return true;
    }
    return false;
  }
}
