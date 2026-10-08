import type { LegalAction, Seat, Tile } from "~/game/protocol/messages";

import type { CallOption } from "~/game/rules";

import { MatchKernel } from "./matchKernel";

import { CallResolution } from "./callResolution";

import type { CallWorkflowPort } from "./workflowPorts";
import { seatDistance, seatValues } from "~/game/rules/seats";

import {
  buildCallLegals,
  callActionPriority,
  callOptionsMaxPriority,
  cloneCallOption,
  cloneLegalAction,
} from "./callActions";

export interface CallResolutionSnapshot {
  readonly callWindows: readonly (readonly CallOption[] | null)[];
  readonly pendingHumanCallActions: readonly (LegalAction | null)[];
  readonly pendingBotRons: readonly Seat[];
  readonly pendingBotCalls: readonly { seat: Seat; option: CallOption }[];
  readonly pendingChankanBotRons: readonly Seat[];
}

export class CallCoordinator {
  private callWindow: (CallOption[] | null)[];

  private pendingHumanCallActions: (LegalAction | null)[];

  private pendingBotRons: Seat[] = [];

  private pendingBotCalls: Array<{ seat: Seat; option: CallOption }> = [];

  private pendingChankanBotRons: Seat[] = [];

  private readonly resolution: CallResolution;
  constructor(
    private readonly kernel: MatchKernel,
    private readonly port: CallWorkflowPort
  ) {
    this.callWindow = seatValues(kernel.playerCount, () => null);
    this.pendingHumanCallActions = seatValues(kernel.playerCount, () => null);
    this.resolution = new CallResolution(kernel, port);
  }
  isOpen(seat: Seat): boolean {
    return this.callWindow[seat] !== null;
  }
  get hasOpen(): boolean {
    return this.callWindow.some((window) => window !== null);
  }
  snapshot(): CallResolutionSnapshot {
    return {
      callWindows: this.callWindow.map((options) =>
        options === null ? null : options.map(cloneCallOption)
      ),
      pendingHumanCallActions: this.pendingHumanCallActions.map((action) =>
        action === null ? null : cloneLegalAction(action)
      ),
      pendingBotRons: [...this.pendingBotRons],
      pendingBotCalls: this.pendingBotCalls.map(({ seat, option }) => ({
        seat,
        option: cloneCallOption(option),
      })),
      pendingChankanBotRons: [...this.pendingChankanBotRons],
    };
  }
  restore(snapshot: CallResolutionSnapshot): void {
    this.callWindow = snapshot.callWindows.map((options) =>
      options === null ? null : options.map(cloneCallOption)
    );
    this.pendingHumanCallActions = snapshot.pendingHumanCallActions.map(
      (action) => (action === null ? null : cloneLegalAction(action))
    );
    this.pendingBotRons = [...snapshot.pendingBotRons];
    this.pendingBotCalls = snapshot.pendingBotCalls.map(({ seat, option }) => ({
      seat,
      option: cloneCallOption(option),
    }));
    this.pendingChankanBotRons = [...snapshot.pendingChankanBotRons];
  }
  resetHand(): void {
    this.callWindow = seatValues(this.kernel.playerCount, () => null);
    this.pendingHumanCallActions = seatValues(
      this.kernel.playerCount,
      () => null
    );
    this.pendingBotRons = [];
    this.pendingBotCalls = [];
  }

  async afterDiscard(): Promise<void> {
    if (
      this.kernel.currentState().phase === "hand_ended" ||
      this.kernel.currentState().phase === "match_ended"
    ) {
      await this.port.afterHandEnd();
      return;
    }
    const calls = this.kernel
      .callOptions()
      .map((call) => ({
        ...call,
        options: call.options.filter(
          (option) =>
            option.kind !== "daiminkan" ||
            this.kernel.canSupplyReplacement(call.seat)
        ),
      }))
      .filter((call) => call.options.length > 0);

    const botRons: Seat[] = [];
    const botCalls: Array<{ seat: Seat; option: CallOption }> = [];
    for (const c of calls) {
      if (this.port.isHumanSeat(c.seat)) {
        continue;
      }
      if (c.options.some((o) => o.kind === "ron")) {
        botRons.push(c.seat);
        continue;
      }
      const chosen = this.kernel.botCall(c.seat, c.options);
      if (chosen !== null) {
        botCalls.push({ seat: c.seat, option: chosen });
      }
    }

    const eligibleHumans = calls.filter(
      (c) => this.port.isHumanSeat(c.seat) && c.options.length > 0
    );
    if (eligibleHumans.length > 0) {
      this.pendingBotRons = botRons;
      this.pendingBotCalls = botCalls;
      for (const human of eligibleHumans) {
        this.openCallWindow(human.seat, human.options);
      }
      return;
    }

    if (botRons.length > 0) {
      await this.resolution.resolveRons(botRons);
      return;
    }
    if (botCalls.length > 0) {
      await this.resolution.resolveBotCall(botCalls);
      return;
    }
    await this.port.advanceTurn();
  }

  async openChankanWindow(): Promise<void> {
    const pending = this.kernel.pendingRobbery();
    if (pending === null) {
      await this.port.advanceTurn();
      return;
    }
    const declarer = pending.seat;
    const botCandidates: Seat[] = [];
    const humanCandidates: Seat[] = [];
    for (let s = 0; s < this.kernel.playerCount; s++) {
      const seat = s as Seat;
      if (seat === declarer) {
        continue;
      }
      if (!this.kernel.canChankanRon(seat)) {
        continue;
      }
      if (this.port.isHumanSeat(seat)) {
        humanCandidates.push(seat);
      } else {
        botCandidates.push(seat);
      }
    }
    if (humanCandidates.length > 0) {
      this.pendingChankanBotRons = botCandidates;
      for (const seat of humanCandidates) {
        this.openCallWindow(seat, [{ kind: "ron" }]);
      }
      return;
    }
    if (botCandidates.length > 0) {
      await this.resolution.dispatchChankanRons(botCandidates);
      return;
    }
    await this.resolution.completeRobberyAndResume();
  }

  openCallWindow(seat: Seat, options: CallOption[]): void {
    this.callWindow[seat] = options;
    this.port.setSeatLegals(seat, buildCallLegals(options));
    this.port.flushLegalsToSeat(seat);
  }

  async resolveCallWindow(seat: Seat, action: LegalAction): Promise<void> {
    if (this.callWindow[seat] === null) {
      return;
    }
    this.pendingHumanCallActions[seat] = action;
    this.callWindow[seat] = null;
    this.port.setSeatLegals(seat, []);

    this.port.flushLegalsToSeat(seat);

    const submittedPrio = callActionPriority(action);
    if (submittedPrio > 0) {
      for (let s = 0; s < this.kernel.playerCount; s++) {
        const seatIdx = s as Seat;
        const opts = this.callWindow[seatIdx];
        if (opts === null) {
          continue;
        }
        const bestPrio = callOptionsMaxPriority(opts);
        if (bestPrio < submittedPrio) {
          this.pendingHumanCallActions[seatIdx] = { id: "pass", type: "pass" };
          this.callWindow[seatIdx] = null;
          this.port.setSeatLegals(seatIdx, []);
          this.port.flushLegalsToSeat(seatIdx);
        }
      }
    }

    if (action.type === "ron" && this.kernel.currentState().ruleSet.atamahane) {
      const discarder = this.kernel.currentState().lastDiscard?.seat;
      if (discarder !== undefined) {
        const submittedHb = seatDistance(
          discarder,
          seat,
          this.kernel.playerCount
        );
        for (let s = 0; s < this.kernel.playerCount; s++) {
          const seatIdx = s as Seat;
          if (this.callWindow[seatIdx] === null) {
            continue;
          }
          const hb = seatDistance(discarder, seatIdx, this.kernel.playerCount);
          if (hb > submittedHb) {
            this.pendingHumanCallActions[seatIdx] = {
              id: "pass",
              type: "pass",
            };
            this.callWindow[seatIdx] = null;
            this.port.setSeatLegals(seatIdx, []);
            this.port.flushLegalsToSeat(seatIdx);
          }
        }
      }
    }

    for (let s = 0; s < this.kernel.playerCount; s++) {
      if (this.callWindow[s as Seat] !== null) {
        return;
      }
    }
    await this.finalizeCallWindow();
  }

  async finalizeCallWindow(): Promise<void> {
    const humanActions = this.pendingHumanCallActions;
    this.pendingHumanCallActions = seatValues(
      this.kernel.playerCount,
      () => null
    );
    const pendingBotRons = this.pendingBotRons;
    const pendingBotCalls = this.pendingBotCalls;
    const pendingChankanBotRons = this.pendingChankanBotRons;
    this.pendingBotRons = [];
    this.pendingBotCalls = [];
    this.pendingChankanBotRons = [];

    if (this.kernel.currentState().phase === "awaiting_chankan") {
      const candidates: Seat[] = [...pendingChankanBotRons];
      for (let s = 0; s < this.kernel.playerCount; s++) {
        const a = humanActions[s];
        if (a && a.type === "ron") {
          candidates.push(s as Seat);
        }
      }
      if (candidates.length > 0) {
        await this.resolution.dispatchChankanRons(candidates);
      } else {
        await this.resolution.completeRobberyAndResume();
      }
      return;
    }

    const ronCandidates: Seat[] = [...pendingBotRons];
    for (let s = 0; s < this.kernel.playerCount; s++) {
      const a = humanActions[s];
      if (a && a.type === "ron") {
        ronCandidates.push(s as Seat);
      }
    }
    if (ronCandidates.length > 0) {
      await this.resolution.resolveRons(ronCandidates);
      return;
    }

    const discarder = this.kernel.currentState().lastDiscard?.seat;
    const claimed = this.kernel.currentState().lastDiscard?.tile;
    if (discarder === undefined || claimed === undefined) {
      await this.port.advanceTurn();
      return;
    }
    const headBump = (a: Seat, b: Seat): number =>
      seatDistance(discarder, a, this.kernel.playerCount) -
      seatDistance(discarder, b, this.kernel.playerCount);

    type CallClaim =
      | { kind: "chi"; seat: Seat; tiles: [Tile, Tile] }
      | { kind: "pon"; seat: Seat; tiles: [Tile, Tile] }
      | { kind: "daiminkan"; seat: Seat };

    const claims: CallClaim[] = [];
    for (let s = 0; s < this.kernel.playerCount; s++) {
      const a = humanActions[s];
      if (!a) {
        continue;
      }
      if (a.type === "chi" && a.tiles) {
        claims.push({
          kind: "chi",
          seat: s as Seat,
          tiles: [a.tiles[0], a.tiles[1]],
        });
      } else if (a.type === "pon" && a.tiles) {
        claims.push({
          kind: "pon",
          seat: s as Seat,
          tiles: [a.tiles[0], a.tiles[1]],
        });
      } else if (a.type === "kan" && a.kanKind === "daiminkan") {
        claims.push({ kind: "daiminkan", seat: s as Seat });
      }
    }
    for (const bc of pendingBotCalls) {
      if (bc.option.kind === "pon") {
        claims.push({
          kind: "pon",
          seat: bc.seat,
          tiles: [bc.option.tiles[0], bc.option.tiles[1]],
        });
      } else if (bc.option.kind === "daiminkan") {
        claims.push({ kind: "daiminkan", seat: bc.seat });
      } else if (bc.option.kind === "chi") {
        claims.push({
          kind: "chi",
          seat: bc.seat,
          tiles: [bc.option.tiles[0], bc.option.tiles[1]],
        });
      }
    }

    if (claims.length === 0) {
      await this.port.advanceTurn();
      return;
    }

    const ponOrKan = claims.filter(
      (c) => c.kind === "pon" || c.kind === "daiminkan"
    );
    const winners = ponOrKan.length > 0 ? ponOrKan : claims;
    winners.sort((a, b) => headBump(a.seat, b.seat));
    const winner = winners[0];

    if (winner.kind === "chi") {
      await this.port.applyEngineAction({
        type: "chi",
        seat: winner.seat,
        tiles: winner.tiles,
      });
    } else if (winner.kind === "pon") {
      await this.port.applyEngineAction({
        type: "pon",
        seat: winner.seat,
        tiles: winner.tiles,
      });
    } else {
      await this.port.applyEngineAction({
        type: "kan",
        seat: winner.seat,
        kind: "daiminkan",
        tile: claimed,
      });
    }
    await this.port.afterCall();
  }
}
