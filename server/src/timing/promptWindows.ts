import type { Seat } from "~/game/protocol/seat";
import {
  ActionWindowViewSchema,
  type ActionWindowView,
  type InputReceipt,
} from "~/game/protocol/timing";
import type { MatchRuntime } from "../runtime";
import type { LatencyProfile } from "../transport/latencyProfile";
import {
  DecisionWindowError,
  sameWindowReceipt,
  validateWindowReceipt,
} from "./windowReceipt";
import { latencyAllowanceMs } from "./latencyAllowancePolicy";
import type { TimingDiagnostics } from "./timingDiagnostics";
import {
  activeSeats,
  mapSeatValues,
  seatValues,
  type PlayerCount,
  type SeatValues,
} from "~/game/rules/seats";

export type PromptKind = "ready" | "session_vote";
type PromptTuple = SeatValues<ActionWindowView | null>;
export interface PromptSnapshot {
  nextWindow: number;
  windows: PromptTuple;
}
export interface PromptTimingService {
  open(kind: PromptKind, seats: readonly Seat[], durationMs: number): void;
  view(seat: Seat): ActionWindowView | null;
  deadline(kind: PromptKind): number | null;
  hasReserved(kind: PromptKind): boolean;
  reserve(seat: Seat, action: string, receipt: InputReceipt): void;
  resolve(seat: Seat): void;
  releaseVote(seat: Seat): void;
  releaseReservation(seat: Seat, receipt: InputReceipt): void;
  clear(kind: PromptKind): void;
  stamp(): { clockEpoch: string; serverNow: number };
  restore(saved: PromptSnapshot, savedAt: number, restoredAt?: number): void;
  restoreLegacy(
    kind: PromptKind,
    seats: readonly Seat[],
    remainingMs: number,
    restoredAt?: number
  ): void;
  addReadySeat(seat: Seat, baseEndsAt: number): void;
}

interface ReservedPrompt {
  action: string;
  receipt: InputReceipt;
}

export class PromptWindows implements PromptTimingService {
  private windows: PromptTuple;
  private nextWindow = 1;
  private readonly reservations = new Map<Seat, ReservedPrompt>();

  constructor(
    private readonly matchId: string,
    private readonly clockEpoch: string,
    private readonly runtime: Pick<MatchRuntime, "now">,
    private readonly connection: (seat: Seat) => {
      network: "direct" | "remote";
      profile: LatencyProfile | null;
    },
    private readonly diagnostics?: TimingDiagnostics,
    private readonly playerCount: PlayerCount = 4
  ) {
    this.windows = seatValues(playerCount, () => null);
  }

  stamp() {
    return { clockEpoch: this.clockEpoch, serverNow: this.runtime.now() };
  }

  open(kind: PromptKind, seats: readonly Seat[], durationMs: number): void {
    if (!Number.isSafeInteger(durationMs) || durationMs <= 0) {
      throw new RangeError("Invalid fixed-prompt budget");
    }

    this.windows = seatValues(this.playerCount, () => null);
    this.reservations.clear();
    const now = this.runtime.now();
    for (const seat of seats) {
      const allowanceMs = latencyAllowanceMs({
        ...this.connection(seat),
        infoSentAt: now,
        opensAt: now,
        now,
      });
      const generation = this.nextWindow++;
      this.windows[seat] = ActionWindowViewSchema.parse({
        id: `${this.matchId}:prompt:${seat}:${generation}`,
        clockEpoch: this.clockEpoch,
        timingVersion: 2,
        seat,
        kind,
        state: "open",
        infoSentAt: now,
        opensAt: now,
        baseEndsAt: now + durationMs,
        budgetEndsAt: now + durationMs,
        expiresAt: now + durationMs + allowanceMs,
        bankAtOpenMs: 0,
        allowanceMs,
        generation,
        legalActionIds: kind === "ready" ? ["ready"] : ["yes", "no"],
      });
      this.diagnostics?.record("opened", now, this.windows[seat]);
    }
  }

  addReadySeat(seat: Seat, baseEndsAt: number): void {
    const now = this.runtime.now();
    const base = Math.max(now, baseEndsAt);
    const allowanceMs =
      baseEndsAt <= now
        ? 0
        : latencyAllowanceMs({
            ...this.connection(seat),
            infoSentAt: now,
            opensAt: now,
            now,
          });
    const generation = this.nextWindow++;
    this.windows[seat] = ActionWindowViewSchema.parse({
      id: `${this.matchId}:prompt:${seat}:${generation}`,
      clockEpoch: this.clockEpoch,
      timingVersion: 2,
      seat,
      kind: "ready",
      state: "open",
      infoSentAt: now,
      opensAt: now,
      baseEndsAt: base,
      budgetEndsAt: base,
      expiresAt: base + allowanceMs,
      bankAtOpenMs: 0,
      allowanceMs,
      generation,
      legalActionIds: ["ready"],
    });
    this.reservations.delete(seat);
    this.diagnostics?.record("opened", now, this.windows[seat]);
  }

  view(seat: Seat): ActionWindowView | null {
    const window = this.windows[seat];
    return window === null
      ? null
      : { ...window, legalActionIds: [...window.legalActionIds] };
  }

  deadline(kind: PromptKind): number | null {
    const active = this.windows.filter(
      (window) =>
        window?.kind === kind &&
        (window.state === "open" || window.state === "scheduled")
    );
    return active.length === 0
      ? null
      : Math.max(...active.map((window) => window?.expiresAt ?? 0));
  }

  hasReserved(kind: PromptKind): boolean {
    return [...this.reservations.keys()].some(
      (seat) => this.windows[seat]?.kind === kind
    );
  }

  reserve(seat: Seat, action: string, receipt: InputReceipt): void {
    const window = this.windows[seat];
    if (!window || window.state !== "open") {
      throw new DecisionWindowError(
        "This prompt is no longer accepting replies"
      );
    }
    validateWindowReceipt(window, action, receipt);
    const existing = this.reservations.get(seat);
    if (existing) {
      if (
        existing.action === action &&
        sameWindowReceipt(existing.receipt, receipt)
      ) {
        return;
      }
      throw new DecisionWindowError("A prompt reply is already pending");
    }
    this.reservations.set(seat, { action, receipt: { ...receipt } });
    this.diagnostics?.record(
      "reserved",
      this.runtime.now(),
      window,
      {},
      receipt
    );
  }

  resolve(seat: Seat): void {
    const window = this.windows[seat];
    if (window) {
      window.state = "resolved";
    }
    this.reservations.delete(seat);
    this.diagnostics?.record("resolved", this.runtime.now(), window);
  }

  releaseVote(seat: Seat): void {
    this.reservations.delete(seat);
  }

  releaseReservation(seat: Seat, receipt: InputReceipt): void {
    if (
      sameWindowReceipt(this.reservations.get(seat)?.receipt, receipt) &&
      this.windows[seat]?.id === receipt.windowId
    ) {
      this.reservations.delete(seat);
    }
  }

  clear(kind: PromptKind): void {
    for (const seat of activeSeats(this.playerCount)) {
      if (this.windows[seat]?.kind === kind) {
        const window = this.windows[seat];
        const now = this.runtime.now();
        this.diagnostics?.record(
          window?.state === "resolved"
            ? "resolved"
            : now >= (window?.expiresAt ?? Infinity)
              ? "expired"
              : "cancelled",
          now,
          window
        );
        this.windows[seat] = null;
        this.reservations.delete(seat);
      }
    }
  }

  capture(): PromptSnapshot {
    if (this.reservations.size !== 0) {
      throw new Error("Cannot capture a fixed prompt with a pending reply");
    }
    return {
      nextWindow: this.nextWindow,
      windows: seatValues(this.playerCount, (seat) => this.view(seat)),
    };
  }

  restore(
    saved: PromptSnapshot,
    savedAt: number,
    restoredAt = this.runtime.now()
  ): void {
    if (saved.windows.length !== this.playerCount) {
      throw new Error(
        "PromptWindows: restored participant count does not match"
      );
    }
    this.reservations.clear();
    this.nextWindow = saved.nextWindow;
    const shift = restoredAt - savedAt;
    const rebase = (window: ActionWindowView | null) =>
      window === null
        ? null
        : ActionWindowViewSchema.parse({
            ...window,
            clockEpoch: this.clockEpoch,
            infoSentAt: window.infoSentAt + shift,
            opensAt: window.opensAt + shift,
            baseEndsAt: window.baseEndsAt + shift,
            budgetEndsAt: window.budgetEndsAt + shift,
            expiresAt: window.expiresAt + shift,
          });
    this.windows = mapSeatValues(saved.windows, rebase);
    this.diagnostics?.record("restored", restoredAt);
  }

  restoreLegacy(
    kind: PromptKind,
    seats: readonly Seat[],
    remainingMs: number,
    restoredAt = this.runtime.now()
  ): void {
    if (!Number.isSafeInteger(remainingMs) || remainingMs < 0) {
      throw new RangeError("Invalid legacy prompt remaining time");
    }
    this.windows = seatValues(this.playerCount, () => null);
    this.reservations.clear();
    const now = restoredAt;
    for (const seat of seats) {
      const generation = this.nextWindow++;
      this.windows[seat] = ActionWindowViewSchema.parse({
        id: `${this.matchId}:migrated-${kind}:${seat}:${generation}`,
        clockEpoch: this.clockEpoch,
        timingVersion: 2,
        seat,
        kind,
        state: "open",
        infoSentAt: now,
        opensAt: now,
        baseEndsAt: now + remainingMs,
        budgetEndsAt: now + remainingMs,
        expiresAt: now + remainingMs,
        bankAtOpenMs: 0,
        allowanceMs: 0,
        generation,
        legalActionIds: kind === "ready" ? ["ready"] : ["yes", "no"],
      });
    }
    this.diagnostics?.record("restored", now);
  }
}
