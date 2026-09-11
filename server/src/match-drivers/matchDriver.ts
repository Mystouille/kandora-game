import type {
  DuplicateMatchModeConfig,
  MatchModeConfig,
  NormalMatchModeConfig,
} from "~/game/protocol/matchMode";
import type { RuleSet } from "~/game/rules/ruleSet";
import type { Seat, Tile, Wind } from "~/game/rules/types";
import type { DealtMatch, WallOptions } from "~/game/rules/wall";
import {
  generateDuplicateHandPlan,
  type DuplicateHandKey,
  type DuplicateHandPlan,
} from "./duplicatePlan";

export type MatchHandContext = DuplicateHandKey;

export type MatchDrawDirective =
  | { kind: "standard" }
  | { kind: "tile"; tile: Tile }
  | { kind: "exhaustive" };

export interface NormalMatchDriverSnapshot {
  type: "normal";
}

export interface DuplicateMatchDriverSnapshot {
  type: "duplicate";
  activeHand: {
    key: DuplicateHandKey;
    cursors: [number, number, number, number];
  } | null;
}

export type MatchDriverSnapshot =
  | NormalMatchDriverSnapshot
  | DuplicateMatchDriverSnapshot;

export interface MatchDriver {
  readonly mode: MatchModeConfig;
  prepareHand(context: MatchHandContext, ruleSet: RuleSet): DealtMatch | undefined;
  peekDraw(seat: Seat): MatchDrawDirective;
  canSupplyReplacement(seat: Seat): boolean;
  commitDraw(seat: Seat, tile: Tile): void;
  snapshot(): MatchDriverSnapshot;
  drawQueuesForArchive(): [Tile[], Tile[], Tile[], Tile[]] | null;
}

function wallOptionsForRuleSet(ruleSet: RuleSet): WallOptions {
  return {
    redFives: {
      m: ruleSet.nbRedFiveManzu,
      p: ruleSet.nbRedFivePinzu,
      s: ruleSet.nbRedFiveSouzu,
    },
  };
}

function cloneDeal(deal: DealtMatch): DealtMatch {
  return {
    hands: deal.hands.map((hand) => [...hand]),
    liveWall: [...deal.liveWall],
    deadWall: [...deal.deadWall],
    doraIndicators: [...deal.doraIndicators],
  };
}

class StandardMatchDriver implements MatchDriver {
  readonly mode: NormalMatchModeConfig = { type: "normal" };

  prepareHand(): undefined {
    return undefined;
  }

  peekDraw(): MatchDrawDirective {
    return { kind: "standard" };
  }

  canSupplyReplacement(): boolean {
    return true;
  }

  commitDraw(): void {}

  snapshot(): NormalMatchDriverSnapshot {
    return { type: "normal" };
  }

  drawQueuesForArchive(): null {
    return null;
  }
}

class DuplicateMatchDriver implements MatchDriver {
  readonly mode: DuplicateMatchModeConfig;
  private activePlan: DuplicateHandPlan | null = null;
  private cursors: [number, number, number, number] = [0, 0, 0, 0];

  constructor(
    mode: DuplicateMatchModeConfig,
    private readonly presetId: string
  ) {
    this.mode = { ...mode };
  }

  prepareHand(context: MatchHandContext, ruleSet: RuleSet): DealtMatch {
    this.activePlan = generateDuplicateHandPlan(
      this.mode,
      this.presetId,
      context,
      wallOptionsForRuleSet(ruleSet)
    );
    this.cursors = [0, 0, 0, 0];
    return cloneDeal(this.activePlan.deal);
  }

  peekDraw(seat: Seat): MatchDrawDirective {
    const plan = this.requireActivePlan();
    const tile = plan.drawQueues[seat][this.cursors[seat]];
    return tile === undefined ? { kind: "exhaustive" } : { kind: "tile", tile };
  }

  canSupplyReplacement(seat: Seat): boolean {
    return this.peekDraw(seat).kind === "tile";
  }

  commitDraw(seat: Seat, tile: Tile): void {
    const expected = this.peekDraw(seat);
    if (expected.kind !== "tile" || expected.tile !== tile) {
      throw new Error(
        `DuplicateMatchDriver.commitDraw: expected ${
          expected.kind === "tile" ? expected.tile : expected.kind
        } for seat ${seat}, got ${tile}`
      );
    }
    this.cursors[seat] += 1;
  }

  snapshot(): DuplicateMatchDriverSnapshot {
    return {
      type: "duplicate",
      activeHand:
        this.activePlan === null
          ? null
          : {
              key: { ...this.activePlan.key },
              cursors: [...this.cursors],
            },
    };
  }

  drawQueuesForArchive(): [Tile[], Tile[], Tile[], Tile[]] | null {
    if (this.activePlan === null) {
      return null;
    }
    return this.activePlan.drawQueues.map((queue) => [...queue]) as [
      Tile[],
      Tile[],
      Tile[],
      Tile[],
    ];
  }

  restore(snapshot: DuplicateMatchDriverSnapshot, ruleSet: RuleSet): void {
    if (snapshot.activeHand === null) {
      this.activePlan = null;
      this.cursors = [0, 0, 0, 0];
      return;
    }
    const { key, cursors } = snapshot.activeHand;
    const plan = generateDuplicateHandPlan(
      this.mode,
      this.presetId,
      key,
      wallOptionsForRuleSet(ruleSet)
    );
    for (let seat = 0; seat < 4; seat++) {
      const cursor = cursors[seat];
      if (
        !Number.isInteger(cursor) ||
        cursor < 0 ||
        cursor > plan.drawQueues[seat].length
      ) {
        throw new Error(
          `DuplicateMatchDriver.restore: invalid cursor ${cursor} for seat ${seat}`
        );
      }
    }
    this.activePlan = plan;
    this.cursors = [...cursors];
  }

  private requireActivePlan(): DuplicateHandPlan {
    if (this.activePlan === null) {
      throw new Error("DuplicateMatchDriver: no active hand plan");
    }
    return this.activePlan;
  }
}

export function createMatchDriver(
  mode: MatchModeConfig,
  presetId: string,
  restore?: { snapshot: MatchDriverSnapshot; ruleSet: RuleSet }
): MatchDriver {
  if (mode.type === "normal") {
    if (restore && restore.snapshot.type !== "normal") {
      throw new Error("Match driver snapshot does not match normal mode");
    }
    return new StandardMatchDriver();
  }

  if (restore && restore.snapshot.type !== "duplicate") {
    throw new Error("Match driver snapshot does not match duplicate mode");
  }
  const driver = new DuplicateMatchDriver(mode, presetId);
  if (restore) {
    driver.restore(restore.snapshot as DuplicateMatchDriverSnapshot, restore.ruleSet);
  }
  return driver;
}

export function matchHandContext(input: {
  gameIndex: number;
  roundWind: Wind;
  roundNumber: number;
  honba: number;
  dealer: Seat;
}): MatchHandContext {
  return { ...input };
}