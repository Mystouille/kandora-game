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

export class DecisionTiming {
  private mode: TimingMode;
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
    mode: TimingMode
  ) {
    this.mode = mode;
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
    if (this.mode !== "legacy") {
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
    if (this.mode === "legacy" || actions.length === 0) {
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
    const allowanceMs = automated
      ? 0
      : latencyAllowanceMs({
          network: connection?.network ?? "remote",
          profile: connection?.profile() ?? null,
          infoSentAt: now,
          opensAt,
          now,
        });
    const bankMs =
      kind === "ryuukyoku_declaration" || automated
        ? 0
        : this.bank.balance(seat);
    this.windows.openTimed(seat, actions, {
      id: `${this.matchId}:${seat}:${this.nextWindow++}`,
      clockEpoch: this.clockEpoch,
      timingVersion: 2,
      kind: kind === "ryuukyoku_declaration" ? kind : call ? "call" : "turn",
      infoSentAt: now,
      opensAt,
      baseEndsAt: opensAt + baseMs,
      budgetEndsAt: opensAt + baseMs + bankMs,
      expiresAt: opensAt + baseMs + bankMs + allowanceMs,
      bankAtOpenMs: bankMs,
      allowanceMs,
    });
    return true;
  }

  reserve(seat: Seat, actionId: string, receipt: InputReceipt): void {
    if (this.mode !== "legacy") {
      this.windows.reserve(seat, actionId, receipt);
    }
  }

  consume(seat: Seat): boolean {
    if (this.windows.timedView(seat) === null) {
      return false;
    }
    this.windows.consumeTimedBuffer(seat, this.bank);
    return true;
  }

  metadata(
    seat: Seat,
    seq: number
  ): {
    clock?: ClockStamp;
    actionWindow?: ActionWindowView | null;
    presentation?: PresentationContext;
  } {
    if (this.mode === "legacy") {
      return {};
    }
    return {
      clock: this.stamp(),
      actionWindow: this.windows.timedView(seat),
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
    };
  }

  restore(saved: ReturnType<DecisionTiming["capture"]>, savedAt: number): void {
    this.mode = saved.mode;
    this.nextWindow = saved.nextWindow;
    for (const seat of [0, 1, 2, 3] as const) {
      const window = saved.windows[seat];
      if (window !== null) {
        this.windows.restoreTimed(
          seat,
          this.windows.legals(seat),
          window,
          savedAt,
          this.clockEpoch
        );
      }
    }
  }
}
