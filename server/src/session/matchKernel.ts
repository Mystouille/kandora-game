import type { ReadonlySeatValues } from "~/game/protocol/seat";
import { type SeatValues } from "~/game/protocol/seat";
import { copySeatValues, type PlayerCount } from "~/game/rules/seats";
import { getPendingRobbery, nextAutomaticNuki } from "~/game/rules/nuki";
import { waitsForRules } from "~/game/rules/tileAvailability";
import type { MatchModeConfig } from "~/game/protocol/matchMode";
import type { LegalAction, MatchDebug, Seat } from "~/game/protocol/messages";
import {
  applyChipDelta,
  createInitialState,
  enumerateCalls,
  evaluateBuuEndOfGameChips,
  isDiscardForbiddenByKuikae,
  isFuritenForRon,
  resolveRuleSet,
  step,
  type CallOption,
  type DiscardSource,
  type EngineEvent,
  type FuritenChange,
  type MatchState,
  type RuleSetOverride,
  type Tile,
} from "~/game/rules";
import { chooseBotCall, chooseBotSelfKan } from "../bots/calls";
import { randomBotDiscard } from "../bots/random";
import {
  createMatchDriver,
  matchHandContext,
  type MatchDriver,
  type MatchDriverSnapshot,
} from "../match-drivers/matchDriver";
import type { MatchRuntime } from "../runtime";
import { buildDiscardLegals } from "./legalActionBuilder";

type DeepReadonly<T> = T extends readonly (infer Item)[]
  ? ReadonlyArray<DeepReadonly<Item>> & { readonly length: T["length"] }
  : { readonly [Key in keyof T]: DeepReadonly<T[Key]> };

export type MatchStateView = DeepReadonly<MatchState>;
export type KernelAction = Parameters<typeof step>[1];

export interface KernelTransition {
  readonly state: MatchStateView;
  readonly events: readonly EngineEvent[];
  readonly furitenChanges?: readonly FuritenChange[];
}

export interface KernelLedgers {
  readonly chips: ReadonlySeatValues<number>;
  readonly dabuken: ReadonlySeatValues<boolean>;
}

/** Mutates authoritative engine/driver state; callers publish returned effects in order. */
export class MatchKernel {
  private stateValue!: MatchState;
  private driver: MatchDriver;
  private humanDrawQueue: Tile[] = [];
  private leftDiscardQueue: Tile[] = [];

  constructor(
    mode: MatchModeConfig,
    private readonly presetId: string,
    private readonly runtime: MatchRuntime,
    readonly playerCount: PlayerCount = 4
  ) {
    this.driver = createMatchDriver(mode, presetId);
  }

  get view(): MatchStateView {
    return this.stateValue;
  }

  currentState(): MatchStateView {
    return this.stateValue;
  }

  get initialized(): boolean {
    return this.stateValue !== undefined;
  }

  get mode(): MatchModeConfig {
    return this.driver.mode;
  }

  driverSnapshot(): MatchDriverSnapshot {
    return this.driver.snapshot();
  }

  duplicateQueueCounts() {
    return this.driver.duplicateQueueCounts();
  }

  drawQueuesForArchive() {
    return this.driver.drawQueuesForArchive();
  }

  canSupplyReplacement(seat: Seat): boolean {
    return this.driver.canSupplyReplacement(seat);
  }

  initialize(
    seed: number,
    gameIndex: number,
    override?: RuleSetOverride,
    ledgers?: KernelLedgers
  ): void {
    const ruleSet = resolveRuleSet(override);
    if (ruleSet.playerCount !== this.playerCount) {
      throw new Error("MatchKernel: rules and participant count disagree");
    }
    const deal = this.driver.prepareHand(
      matchHandContext({
        gameIndex,
        roundWind: "E",
        roundNumber: 1,
        honba: 0,
        dealer: 0,
      }),
      ruleSet
    );
    this.stateValue = createInitialState(seed, { ruleSet, deal });
    if (ledgers !== undefined) {
      this.stateValue.chips = copySeatValues(ledgers.chips);
      this.stateValue.dabuken = copySeatValues(ledgers.dabuken);
    }
  }

  applyDebugSeed(debug: MatchDebug): void {
    if (debug === undefined) {
      return;
    }
    if (debug.humanHand && debug.humanHand.length === 13) {
      this.stateValue.hands[0] = [...debug.humanHand];
    }
    this.humanDrawQueue = debug.humanDraws ? [...debug.humanDraws] : [];
    this.leftDiscardQueue = debug.leftDiscards ? [...debug.leftDiscards] : [];
  }

  debugQueues(): { humanDraws: Tile[]; leftDiscards: Tile[] } {
    return {
      humanDraws: [...this.humanDrawQueue],
      leftDiscards: [...this.leftDiscardQueue],
    };
  }

  restoreDebugQueues(
    humanDraws: readonly Tile[],
    leftDiscards: readonly Tile[]
  ): void {
    this.humanDrawQueue = [...humanDraws];
    this.leftDiscardQueue = [...leftDiscards];
  }

  restore(state: MatchState, driver: MatchDriverSnapshot): void {
    this.stateValue = state;
    this.restoreDriver(driver, state.ruleSet);
  }

  restoreDriver(
    driver: MatchDriverSnapshot,
    ruleSet: MatchState["ruleSet"]
  ): void {
    this.driver = createMatchDriver(this.mode, this.presetId, {
      snapshot: driver,
      ruleSet,
    });
  }

  prepareDebugDraw(): void {
    if (this.stateValue.turn === 0 && this.humanDrawQueue.length > 0) {
      const tile = this.humanDrawQueue.shift();
      if (tile === undefined) {
        throw new Error("MatchKernel: forced draw queue is incomplete");
      }
      this.stateValue.liveWall.unshift(tile);
    }
  }

  draw(): KernelTransition {
    const seat = this.stateValue.turn;
    const directive = this.driver.peekDraw(seat);
    const result = step(
      this.stateValue,
      directive.kind === "tile"
        ? { type: "draw", seat, tile: directive.tile }
        : directive.kind === "exhaustive"
          ? { type: "draw", seat, forceExhaustive: true }
          : { type: "draw", seat }
    );
    if (directive.kind === "tile") {
      const emitted = result.events.find(
        (event) => event.type === "draw" && event.seat === seat
      );
      if (emitted?.type !== "draw" || emitted.tile !== directive.tile) {
        throw new Error(
          "MatchProcess.advanceTurn: duplicate draw was rejected"
        );
      }
      this.driver.commitDraw(seat, emitted.tile);
    }
    this.stateValue = result.state;
    return result;
  }

  applyAction(action: KernelAction): KernelTransition {
    let drivenAction = action;
    let suppliedDraw: { seat: Seat; tile: Tile } | null = null;
    if (action.type === "kan" || action.type === "nuki") {
      const directive = this.driver.peekDraw(action.seat);
      if (
        directive.kind === "exhaustive" &&
        !(
          action.type === "nuki" &&
          this.stateValue.ruleSet.sanmaType === "kansai"
        )
      ) {
        throw new Error(
          `applyEngineAction: no replacement tile for seat ${action.seat}`
        );
      }
      if (directive.kind === "tile") {
        drivenAction = { ...action, replacementTile: directive.tile };
        if (action.type === "kan" && action.kind !== "shouminkan") {
          suppliedDraw = { seat: action.seat, tile: directive.tile };
        }
      }
    } else if (
      action.type === "complete_shouminkan" ||
      action.type === "complete_nuki"
    ) {
      const seat =
        action.type === "complete_nuki"
          ? this.stateValue.pendingNuki?.seat
          : this.stateValue.pendingShouminkan?.seat;
      if (seat === undefined) {
        throw new Error(
          "applyEngineAction: complete_shouminkan has no declarer"
        );
      }
      const directive = this.driver.peekDraw(seat);
      if (directive.kind === "exhaustive") {
        if (
          action.type === "complete_nuki" &&
          this.stateValue.ruleSet.sanmaType === "kansai"
        ) {
          drivenAction = { ...action, forceExhaustive: true };
        } else {
          throw new Error(
            `applyEngineAction: no replacement tile for seat ${seat}`
          );
        }
      }
      if (directive.kind === "tile") {
        drivenAction = { ...action, replacementTile: directive.tile };
        suppliedDraw = { seat, tile: directive.tile };
      }
    }
    const result = step(this.stateValue, drivenAction);
    if (result.events.length === 0 && result.state === this.stateValue) {
      throw new Error(
        `applyEngineAction: engine rejected ${action.type} for seat ${
          "seat" in action ? action.seat : "?"
        }`
      );
    }
    if (suppliedDraw !== null) {
      const emitted = result.events.find(
        (event) => event.type === "draw" && event.seat === suppliedDraw.seat
      );
      if (emitted?.type !== "draw" || emitted.tile !== suppliedDraw.tile) {
        throw new Error(
          "applyEngineAction: supplied replacement draw was not emitted"
        );
      }
      this.driver.commitDraw(suppliedDraw.seat, suppliedDraw.tile);
    }
    this.stateValue = result.state;
    return result;
  }

  discard(
    seat: Seat,
    tile: Tile,
    discardSource?: DiscardSource
  ): KernelTransition {
    const result = step(this.stateValue, {
      type: "discard",
      seat,
      tile,
      discardSource,
    });
    if (result.events.length === 0) {
      throw new Error(
        `applyDiscard: engine rejected discard ${tile} for seat ${seat}`
      );
    }
    this.stateValue = result.state;
    return result;
  }

  startNextHand(gameIndex: number): KernelTransition {
    const preview = step(this.stateValue, { type: "start_next_hand" });
    const handStart = preview.events.find(
      (event) => event.type === "hand_start"
    );
    const deal =
      handStart?.type === "hand_start"
        ? this.driver.prepareHand(
            matchHandContext({
              gameIndex,
              roundWind: handStart.roundWind,
              roundNumber: handStart.roundNumber,
              honba: handStart.honba,
              dealer: handStart.dealer,
            }),
            this.stateValue.ruleSet
          )
        : undefined;
    const result =
      deal === undefined
        ? preview
        : step(this.stateValue, { type: "start_next_hand", deal });
    this.stateValue = result.state;
    return result;
  }

  discardLegals(seat: Seat): LegalAction[] {
    return buildDiscardLegals(this.stateValue, this.driver, seat);
  }

  callOptions() {
    return enumerateCalls(this.stateValue);
  }

  botCall(seat: Seat, options: readonly CallOption[]): CallOption | null {
    return chooseBotCall(this.stateValue, seat, options);
  }

  botSelfKan(seat: Seat) {
    return this.driver.canSupplyReplacement(seat)
      ? chooseBotSelfKan(this.stateValue, seat)
      : null;
  }

  hasForcedBotDiscard(seat: Seat): boolean {
    return seat === 3 && this.leftDiscardQueue.length > 0;
  }

  botDiscard(seat: Seat): { tile: Tile; discardSource: DiscardSource } {
    if (this.hasForcedBotDiscard(seat)) {
      const tile = this.leftDiscardQueue.shift();
      if (tile === undefined) {
        throw new Error("MatchKernel: forced discard queue is incomplete");
      }
      const state = this.stateValue;
      const handIndex = state.hands[seat].lastIndexOf(tile);
      if (handIndex < 0) {
        const drawn = state.lastDrawn[seat];
        const drawnIndex =
          drawn !== null ? state.hands[seat].lastIndexOf(drawn) : -1;
        state.hands[seat][drawnIndex >= 0 ? drawnIndex : 0] = tile;
        state.lastDrawn[seat] = tile;
        return { tile, discardSource: "draw" };
      }
      return {
        tile,
        discardSource:
          state.lastDrawn[seat] !== null &&
          handIndex === state.hands[seat].length - 1
            ? "draw"
            : "hand",
      };
    }
    return randomBotDiscard({
      hand: this.stateValue.hands[seat],
      drawn: this.stateValue.lastDrawn[seat],
      random: () => this.runtime.random(),
      isDiscardAllowed: (discard) =>
        !isDiscardForbiddenByKuikae(this.stateValue, seat, discard.tile),
    });
  }

  isFuriten(seat: Seat): boolean {
    return isFuritenForRon(this.stateValue, seat);
  }

  handWaits(seat: Seat): Tile[] {
    return waitsForRules(
      this.stateValue.hands[seat],
      this.stateValue.melds[seat].length,
      this.stateValue.ruleSet
    );
  }

  pendingRobbery() {
    return getPendingRobbery(this.stateValue);
  }

  automaticNuki(opening = false) {
    return nextAutomaticNuki(this.stateValue, opening);
  }

  canChankanRon(seat: Seat): boolean {
    return step(this.stateValue, { type: "ron", seat }).events.some(
      (event) => event.type === "win"
    );
  }

  canTsumo(seat: Seat): boolean {
    return step(this.stateValue, { type: "tsumo", seat }).events.some(
      (event) => event.type === "win"
    );
  }

  settleBuuGame(): SeatValues<number> {
    const settlement = evaluateBuuEndOfGameChips(this.stateValue);
    applyChipDelta(this.stateValue.chips, settlement.chipDelta);
    this.stateValue.dabuken = [false, false, false, false];
    if (settlement.awardedDabuken) {
      this.stateValue.dabuken[settlement.winner] = true;
    }
    return copySeatValues(settlement.chipDelta);
  }
}
