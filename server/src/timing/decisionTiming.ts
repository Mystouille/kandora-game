import { activeSeats, seatValues, type SeatValues } from "~/game/rules/seats";
import type { GameEvent, LegalAction, Seat } from "~/game/protocol/messages";
import type {
  ClockStamp,
  InputReceipt,
  ActionWindowView,
  PresentationContext,
} from "~/game/protocol/timing";
import type { MatchRuntime } from "../runtime";
import type { LatencyProfile } from "../transport/latencyProfile";
import { ActionWindowRegistry } from "./actionWindows";
import { TimeBank } from "./timeBank";
import { latencyAllowanceMs } from "./latencyAllowancePolicy";
import { PresentationPlanner } from "./presentationPlanner";
import type { ActionWindowPolicy, ActionWindowKind } from "./actionWindows";
import { PromptWindows, type PromptSnapshot } from "./promptWindows";
import { TimingDiagnostics, type TimingObserver } from "./timingDiagnostics";

export class DecisionTiming {
  private readonly fixedPrompts: PromptWindows;
  readonly diagnostics: TimingDiagnostics;
  private nextWindow = 1;
  private readonly planner = new PresentationPlanner();
  private readonly profiles = new Map<
    Seat,
    {
      network: "direct" | "remote";
      profile: () => LatencyProfile | null;
    }
  >();

  constructor(
    readonly clockEpoch: string,
    private readonly matchId: string,
    private readonly runtime: MatchRuntime,
    private readonly windows: ActionWindowRegistry,
    private readonly bank: TimeBank,
    observer?: TimingObserver
  ) {
    this.diagnostics = new TimingDiagnostics(matchId, clockEpoch, observer);
    this.fixedPrompts = new PromptWindows(
      matchId,
      clockEpoch,
      runtime,
      (seat) => {
        const connection = this.profiles.get(seat);
        return {
          network: connection?.network ?? "remote",
          profile: connection?.profile() ?? null,
        };
      },
      this.diagnostics,
      this.windows.playerCount
    );
  }

  get promptTiming(): PromptWindows {
    return this.fixedPrompts;
  }

  connection(
    seat: Seat,
    network: "direct" | "remote",
    profile: () => LatencyProfile | null
  ): void {
    this.profiles.set(seat, { network, profile });
  }

  stamp(): ClockStamp {
    return { clockEpoch: this.clockEpoch, serverNow: this.runtime.now() };
  }

  record(event: GameEvent, seq: number): void {
    this.planner.record(event, this.runtime.now(), seq);
  }

  restoreEvent(event: GameEvent, seq: number, occurredAt: number): void {
    this.planner.record(event, occurredAt, seq);
  }

  spectatorMetadata(
    sequence: number,
    wireSequence: number,
    offsetMs: number,
    external = false
  ): { clock?: ClockStamp; presentation?: PresentationContext } {
    return {
      clock: this.stamp(),
      presentation: {
        offsetMs: external ? 0 : offsetMs,
        source: external ? "external-relay" : "native-spectator",
        events: this.planner.recordedEvent(sequence, wireSequence),
      },
    };
  }

  open(
    seat: Seat,
    actions: LegalAction[],
    kind: ActionWindowKind,
    policy: ActionWindowPolicy,
    disconnected: boolean,
    call = false
  ): boolean {
    if (actions.length === 0) {
      this.windows.clear(seat);
      return false;
    }
    const now = this.runtime.now();
    const automated = disconnected && kind !== "ryuukyoku_declaration";
    let baseMs =
      kind === "ryuukyoku_declaration" ? policy.declarationMs : policy.baseMs;
    const opensAt = automated
      ? Math.min(this.planner.decisionReadyAt(now), now + policy.automatedMs)
      : this.planner.decisionReadyAt(now);
    if (automated) {
      baseMs = Math.max(0, now + policy.automatedMs - opensAt);
    }
    const connection = this.profiles.get(seat);
    const profile = connection?.profile() ?? null;
    const allowanceMs = automated
      ? 0
      : latencyAllowanceMs({
          network: connection?.network ?? "remote",
          profile,
          infoSentAt: now,
          opensAt,
          now,
        });
    const bankMs =
      kind === "ryuukyoku_declaration" || automated
        ? 0
        : this.bank.balance(seat);
    const timing = {
      id: `${this.matchId}:${seat}:${this.nextWindow++}`,
      clockEpoch: this.clockEpoch,
      timingVersion: 2 as const,
      kind:
        kind === "ryuukyoku_declaration"
          ? kind
          : call
            ? ("call" as const)
            : ("turn" as const),
      infoSentAt: now,
      opensAt,
      baseEndsAt: opensAt + baseMs,
      budgetEndsAt: opensAt + baseMs + bankMs,
      expiresAt: opensAt + baseMs + bankMs + allowanceMs,
      bankAtOpenMs: bankMs,
      allowanceMs,
    };
    const opened = this.windows.openTimed(seat, actions, timing);
    this.diagnostics.record("opened", now, opened, {}, undefined, profile);
    return true;
  }

  reserve(seat: Seat, actionId: string, receipt: InputReceipt): void {
    const window = this.windows.timedView(seat);
    try {
      this.windows.reserve(seat, actionId, receipt);
    } catch (error) {
      this.diagnostics.record(
        "rejected",
        this.runtime.now(),
        window,
        {},
        receipt
      );
      throw error;
    }
    this.diagnostics.record(
      "reserved",
      this.runtime.now(),
      window,
      {},
      receipt
    );
  }

  consume(seat: Seat): boolean {
    const window = this.windows.timedView(seat);
    if (window === null) {
      return false;
    }
    if (window.state === "resolved" || window.state === "cancelled") {
      return true;
    }
    if (window.state === "expired") {
      this.diagnostics.record("expired", this.runtime.now(), window);
    }
    const balance = this.bank.balance(seat);
    this.windows.consumeTimedBuffer(seat, this.bank);
    this.diagnostics.record(
      "resolved",
      this.runtime.now(),
      this.windows.timedView(seat),
      { debitMs: balance - this.bank.balance(seat) }
    );
    return true;
  }

  metadata(
    seat: Seat,
    seq: number
  ): {
    clock?: ClockStamp;
    actionWindow?: ActionWindowView | null;
    presentation?: PresentationContext;
    promptWindow?: ActionWindowView | null;
  } {
    return {
      clock: this.stamp(),
      actionWindow: this.windows.timedView(seat),
      promptWindow: this.fixedPrompts.view(seat),
      presentation: {
        offsetMs: 0,
        source: "player",
        events: this.planner.eventForSequence(seq),
      },
    };
  }

  capture(): {
    nextWindow: number;
    windows: SeatValues<ActionWindowView | null>;
    prompts?: PromptSnapshot;
  } {
    return {
      nextWindow: this.nextWindow,
      windows: seatValues(this.windows.playerCount, (seat) =>
        this.windows.timedView(seat)
      ),
      prompts: this.fixedPrompts.capture(),
    };
  }

  restore(
    saved: ReturnType<DecisionTiming["capture"]>,
    savedAt: number,
    restoredAt = this.runtime.now()
  ): void {
    if (saved.windows.length !== this.windows.playerCount) {
      throw new Error(
        "DecisionTiming: restored participant count does not match"
      );
    }
    this.nextWindow = saved.nextWindow;
    if (saved.prompts) {
      this.fixedPrompts.restore(saved.prompts, savedAt, restoredAt);
    }
    for (const seat of activeSeats(this.windows.playerCount)) {
      const window = saved.windows[seat];
      if (window !== null) {
        this.windows.restoreTimed(
          seat,
          this.windows.legals(seat),
          window,
          savedAt,
          this.clockEpoch,
          restoredAt
        );
      }
    }
    this.diagnostics.record("restored", restoredAt);
  }
}
