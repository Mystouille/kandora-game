import type { Seat } from "~/game/protocol/messages";

import type { CallOption } from "~/game/rules";

import { MatchKernel } from "./matchKernel";

import type { CallResolutionPort } from "./workflowPorts";

export class CallResolution {
  constructor(
    private readonly kernel: MatchKernel,
    private readonly port: CallResolutionPort
  ) {}

  async resolveRons(candidates: Seat[]): Promise<void> {
    const discarder = this.kernel.currentState().lastDiscard?.seat;
    if (discarder === undefined || candidates.length === 0) {
      await this.port.advanceTurn();
      return;
    }
    await this.port.waitForWinReaction("discard");
    const ordered = candidates
      .slice()
      .sort((a, b) => ((a - discarder + 3) % 4) - ((b - discarder + 3) % 4));
    const head = ordered[0];

    if (this.kernel.currentState().ruleSet.atamahane) {
      await this.port.applyEngineAction({ type: "ron", seat: head });
    } else if (
      candidates.length === 3 &&
      this.kernel.currentState().ruleSet.aborts.sanchahou
    ) {
      await this.port.applyEngineAction({
        type: "abort",
        seat: head,
        kind: "sanchahou",
      });
    } else {
      const additional = ordered.slice(1);
      await this.port.applyEngineAction({
        type: "ron",
        seat: head,
        ...(additional.length > 0 ? { additionalWinners: additional } : {}),
      });
    }
    if (
      this.kernel.currentState().phase === "hand_ended" ||
      this.kernel.currentState().phase === "match_ended"
    ) {
      await this.port.afterHandEnd();
    }
  }

  async resolveBotCall(
    candidates: Array<{ seat: Seat; option: CallOption }>
  ): Promise<void> {
    if (candidates.length === 0) {
      await this.port.advanceTurn();
      return;
    }
    const claimed = this.kernel.currentState().lastDiscard?.tile;
    if (claimed === undefined) {
      await this.port.advanceTurn();
      return;
    }
    const { seat, option } = candidates[0];
    if (option.kind === "pon") {
      const [a, b] = option.tiles;
      await this.port.applyEngineAction({
        type: "pon",
        seat,
        tiles: [a, b],
      });
    } else if (option.kind === "daiminkan") {
      await this.port.applyEngineAction({
        type: "kan",
        seat,
        kind: "daiminkan",
        tile: claimed,
      });
    } else {
      await this.port.advanceTurn();
      return;
    }
    await this.port.afterCall();
  }

  async dispatchChankanRons(candidates: Seat[]): Promise<void> {
    const declarer = this.kernel.currentState().pendingShouminkan?.seat;
    if (declarer === undefined || candidates.length === 0) {
      await this.completeShouminkanAndResume();
      return;
    }
    await this.port.waitForWinReaction("call");

    const ordered = candidates
      .slice()
      .sort((a, b) => ((a - declarer + 3) % 4) - ((b - declarer + 3) % 4));
    const head = ordered[0];
    const additional = ordered.slice(1);
    await this.port.applyEngineAction({
      type: "ron",
      seat: head,
      ...(additional.length > 0 ? { additionalWinners: additional } : {}),
    });
    if (
      this.kernel.currentState().phase === "hand_ended" ||
      this.kernel.currentState().phase === "match_ended"
    ) {
      await this.port.afterHandEnd();
    }
  }

  async completeShouminkanAndResume(): Promise<void> {
    await this.port.applyEngineAction({ type: "complete_shouminkan" });
    await this.port.afterCall();
  }
}
