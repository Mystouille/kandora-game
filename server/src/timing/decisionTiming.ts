import type { GameEvent, LegalAction, Seat } from "~/game/protocol/messages";
import type {
  ClockStamp,
  InputReceipt,
  TimingMode,
  ActionWindowView,
  PresentationContext,
} from "~/game/protocol/timing";
import type { MatchRuntime } from "../runtime";
import type { LatencyProfile } from "../transport/latencyProfile";
import { ActionWindowRegistry } from "./actionWindows";
import { TimeBank } from "./timeBank";
import { latencyAllowanceMs } from "./latencyAllowancePolicy";
import { PresentationPlanner } from "./presentationPlanner";
import type {
  LegacyActionWindowPolicy,
  ActionWindowKind,
} from "./actionWindows";
import { PromptWindows, type PromptSnapshot } from "./promptWindows";
import { TimingDiagnostics, type TimingObserver } from "./timingDiagnostics";

export class DecisionTiming {
  private readonly fixedPrompts: PromptWindows;
  readonly diagnostics: TimingDiagnostics;
  private mode: TimingMode;
  private nextWindow = 1;
  private readonly shadowWindows = new Map<Seat, ActionWindowView>();
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
    mode: TimingMode,
    options: { shadow?: boolean; observer?: TimingObserver } = {}
  ) {
    this.mode = mode;
    this.diagnostics = new TimingDiagnostics(
      matchId,
      clockEpoch,
      options.shadow,
      options.observer
    );
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
      this.diagnostics
    );
  }

  get promptTiming(): PromptWindows | undefined {
    return this.mode === "legacy" ? undefined : this.fixedPrompts;
  }

  get timingMode(): TimingMode {
    return this.mode;
  }

  useMode(mode: TimingMode): void {
    this.mode = mode;
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
    if (this.mode !== "legacy" || this.diagnostics.shadow) {
      this.planner.record(event, this.runtime.now(), seq);
    }
  }

  restoreEvent(event: GameEvent, seq: number, occurredAt: number): void {
    if (this.mode !== "legacy") {
      this.planner.record(event, occurredAt, seq);
    }
  }

  spectatorMetadata(
    sequence: number,
    wireSequence: number,
    offsetMs: number,
    external = false
  ): { clock?: ClockStamp; presentation?: PresentationContext } {
    if (this.mode === "legacy") {
      return {};
    }
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
    policy: LegacyActionWindowPolicy,
    disconnected: boolean,
    call = false
  ): boolean {
    if (
      (this.mode === "legacy" && !this.diagnostics.shadow) ||
      actions.length === 0
    ) {
      return false;
    }
    const now = this.runtime.now();
    const automated = disconnected && kind !== "ryuukyoku_declaration";
    let baseMs =
      kind === "ryuukyoku_declaration" ? policy.declarationMs : policy.baseMs;
    if (baseMs <= 0) {
      return false;
    }
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
    if (this.mode === "legacy") {
      const comparison: ActionWindowView = {
        ...timing,
        seat,
        state: "scheduled",
        generation: 0,
        legalActionIds: [],
      };
      this.shadowWindows.set(seat, comparison);
      this.diagnostics.record(
        "shadow",
        now,
        comparison,
        { legacyOpensAt: now },
        undefined,
        profile
      );
      return false;
    }
    const opened = this.windows.openTimed(seat, actions, timing);
    this.diagnostics.record("opened", now, opened, {}, undefined, profile);
    return true;
  }

  reserve(seat: Seat, actionId: string, receipt: InputReceipt): void {
    if (this.mode !== "legacy") {
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
    } else if (this.diagnostics.shadow) {
      this.diagnostics.record(
        "shadow",
        this.runtime.now(),
        this.shadowWindows.get(seat),
        {},
        receipt
      );
    }
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
    if (this.mode === "legacy") {
      return this.diagnostics.shadow ? { clock: this.stamp() } : {};
    }
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
    mode: TimingMode;
    nextWindow: number;
    windows: [
      ActionWindowView | null,
      ActionWindowView | null,
      ActionWindowView | null,
      ActionWindowView | null,
    ];
    prompts?: PromptSnapshot;
  } {
    return {
      mode: this.mode,
      nextWindow: this.nextWindow,
      windows: [
        this.windows.timedView(0),
        this.windows.timedView(1),
        this.windows.timedView(2),
        this.windows.timedView(3),
      ],
      prompts: this.fixedPrompts.capture(),
    };
  }

  restore(
    saved: ReturnType<DecisionTiming["capture"]>,
    savedAt: number,
    restoredAt = this.runtime.now()
  ): void {
    this.mode = saved.mode;
    this.nextWindow = saved.nextWindow;
    if (saved.prompts) {
      this.fixedPrompts.restore(saved.prompts, savedAt, restoredAt);
    }
    for (const seat of [0, 1, 2, 3] as const) {
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
