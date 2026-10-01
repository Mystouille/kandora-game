import type { LegalAction, Seat } from "~/game/protocol/messages";
import type { MatchRuntime, MatchTimer } from "../runtime";
import { type LegacyBankPolicy, TimeBank } from "./timeBank";
import {
  ActionWindowViewSchema,
  type ActionWindowView,
  type InputReceipt,
} from "~/game/protocol/timing";

import {
  DecisionWindowError,
  sameWindowReceipt,
  validateWindowReceipt,
} from "./windowReceipt";
export { DecisionWindowError } from "./windowReceipt";

export type ActionWindowKind = "turn" | "ryuukyoku_declaration";

export interface LegacyActionWindowPolicy extends LegacyBankPolicy {
  readonly declarationMs: number;
  readonly automatedMs: number;
}

export interface LegacyActionWindowView {
  readonly kind: ActionWindowKind | null;
  readonly startedAt: number | null;
  readonly deadline: number | null;
  readonly timerPending: boolean;
  readonly generation: number;
}

export interface RestoredActionWindow {
  readonly kind: ActionWindowKind;
  readonly legalActions: readonly LegalAction[];
  readonly elapsedMs: number;
  readonly visibleRemainingMs: number;
  readonly expiryRemainingMs: number;
}

interface SeatActionWindow {
  actions: LegalAction[];
  kind: ActionWindowKind | null;
  startedAt: number | null;
  deadline: number | null;
  timer: MatchTimer | null;
  generation: number;
  timing: ActionWindowView | null;
  reservation: InputReceipt | null;
  reservedActionId: string | null;
  debited: boolean;
}

function emptyWindow(): SeatActionWindow {
  return {
    actions: [],
    kind: null,
    startedAt: null,
    deadline: null,
    timer: null,
    generation: 0,
    timing: null,
    reservation: null,
    reservedActionId: null,
    debited: false,
  };
}

function cloneAction(action: LegalAction): LegalAction {
  return {
    ...action,
    ...(action.tiles ? { tiles: [...action.tiles] } : {}),
  };
}

/** Sole owner of the legacy legal/deadline/start/timer generation for each seat. */
export class ActionWindowRegistry {
  private readonly windows: [
    SeatActionWindow,
    SeatActionWindow,
    SeatActionWindow,
    SeatActionWindow,
  ] = [emptyWindow(), emptyWindow(), emptyWindow(), emptyWindow()];

  constructor(
    private readonly runtime: MatchRuntime,
    private readonly onExpiry: (seat: Seat) => void,
    private readonly isPaused: () => boolean
  ) {}

  view(seat: Seat): LegacyActionWindowView {
    const window = this.windows[seat];
    return {
      kind: window.kind,
      startedAt: window.timing?.opensAt ?? window.startedAt,
      deadline: window.timing?.baseEndsAt ?? window.deadline,
      timerPending: window.timer !== null,
      generation: window.generation,
    };
  }

  legals(seat: Seat): LegalAction[] {
    return this.windows[seat].actions.map(cloneAction);
  }

  allLegals(): LegalAction[][] {
    return this.windows.map((window) => window.actions.map(cloneAction));
  }

  get hasTimers(): boolean {
    return this.windows.some((window) => window.timer !== null);
  }

  hasReservedInput(seat: Seat): boolean {
    return this.windows[seat].reservation !== null;
  }

  open(
    seat: Seat,
    actions: readonly LegalAction[],
    kind: ActionWindowKind,
    policy: LegacyActionWindowPolicy,
    bankMs: number,
    disconnected: boolean
  ): void {
    const window = this.windows[seat];
    this.cancelTimer(seat);
    window.timing = null;
    window.reservation = null;
    window.reservedActionId = null;
    window.debited = false;
    window.actions = actions.map(cloneAction);
    window.kind = actions.length > 0 ? kind : null;
    const visibleDurationMs =
      kind === "ryuukyoku_declaration" ? policy.declarationMs : policy.baseMs;
    if (actions.length === 0 || visibleDurationMs <= 0) {
      window.startedAt = null;
      window.deadline = null;
      window.timing = null;
      window.reservation = null;
      window.reservedActionId = null;
      window.debited = false;
      return;
    }
    const now = this.runtime.now();
    window.startedAt = now;
    window.deadline = now + visibleDurationMs;
    const expiryMs =
      kind === "ryuukyoku_declaration"
        ? visibleDurationMs
        : disconnected
          ? policy.automatedMs
          : policy.baseMs + bankMs + policy.graceMs;
    this.schedule(seat, expiryMs);
  }

  cancelTimer(seat: Seat): void {
    const window = this.windows[seat];
    window.timer?.cancel();
    window.timer = null;
    window.generation += 1;
  }

  cancelAllTimers(): void {
    for (const seat of [0, 1, 2, 3] as const) {
      this.cancelTimer(seat);
    }
  }

  resetForRestore(): void {
    for (const seat of [0, 1, 2, 3] as const) {
      this.cancelTimer(seat);
      const window = this.windows[seat];
      window.actions = [];
      window.kind = null;
      window.startedAt = null;
      window.deadline = null;
      window.timing = null;
      window.reservation = null;
      window.reservedActionId = null;
      window.debited = false;
    }
  }

  restore(
    seat: Seat,
    saved: RestoredActionWindow,
    restoredAt = this.runtime.now()
  ): void {
    this.cancelTimer(seat);
    const window = this.windows[seat];
    window.actions = saved.legalActions.map(cloneAction);
    window.timing = null;
    window.reservation = null;
    window.reservedActionId = null;
    window.debited = false;
    window.kind = saved.kind;
    window.startedAt = restoredAt - saved.elapsedMs;
    window.deadline = restoredAt + saved.visibleRemainingMs;
    this.schedule(
      seat,
      Math.max(0, restoredAt + saved.expiryRemainingMs - this.runtime.now())
    );
  }

  consumeLegacyBuffer(
    seat: Seat,
    bank: TimeBank,
    policy: LegacyBankPolicy
  ): void {
    const window = this.windows[seat];
    if (window.startedAt === null) {
      return;
    }
    if (window.kind !== "ryuukyoku_declaration") {
      bank.consumeLegacyElapsed(
        seat,
        this.runtime.now() - window.startedAt,
        policy
      );
    }
    window.startedAt = null;
  }

  openTimed(
    seat: Seat,
    actions: readonly LegalAction[],
    timing: Omit<
      ActionWindowView,
      "seat" | "legalActionIds" | "generation" | "state"
    >
  ): ActionWindowView {
    this.cancelTimer(seat);
    const window = this.windows[seat];
    const view = ActionWindowViewSchema.parse({
      ...timing,
      seat,
      generation: window.generation,
      state: this.runtime.now() < timing.opensAt ? "scheduled" : "open",
      legalActionIds: actions.map((action) => action.id),
    });
    window.actions = actions.map(cloneAction);
    window.kind =
      timing.kind === "ryuukyoku_declaration"
        ? "ryuukyoku_declaration"
        : "turn";
    window.startedAt = null;
    window.deadline = null;
    window.timing = view;
    window.reservation = null;
    window.reservedActionId = null;
    window.debited = false;
    this.schedule(seat, Math.max(0, view.expiresAt - this.runtime.now()));
    return view;
  }

  timedView(seat: Seat): ActionWindowView | null {
    const timing = this.windows[seat].timing;
    if (timing === null) {
      return null;
    }
    return {
      ...timing,
      legalActionIds: [...timing.legalActionIds],
      state:
        timing.state === "scheduled" && this.runtime.now() >= timing.opensAt
          ? "open"
          : timing.state,
    };
  }

  reserve(seat: Seat, actionId: string, receipt: InputReceipt): void {
    const window = this.windows[seat];
    const timing = window.timing;
    if (timing === null) {
      throw new DecisionWindowError("No explicit decision window");
    }
    validateWindowReceipt(timing, actionId, receipt);
    if (window.reservation !== null) {
      if (
        sameWindowReceipt(window.reservation, receipt) &&
        window.reservedActionId === actionId
      ) {
        return;
      }
      throw new DecisionWindowError("Decision input is already reserved");
    }
    window.reservation = { ...receipt };
    window.reservedActionId = actionId;
    window.timer?.cancel();
    window.timer = null;
  }

  consumeTimedBuffer(seat: Seat, bank: TimeBank): void {
    const window = this.windows[seat];
    const timing = window.timing;
    if (
      timing === null ||
      window.debited ||
      timing.state === "resolved" ||
      timing.state === "cancelled"
    ) {
      return;
    }

    const receivedAt = window.reservation?.receivedAt ?? this.runtime.now();
    const effectiveAt = Math.max(
      timing.opensAt,
      receivedAt - timing.allowanceMs
    );
    const baseMs = timing.baseEndsAt - timing.opensAt;
    if (timing.bankAtOpenMs > 0) {
      bank.debitExact(
        seat,
        Math.max(0, Math.floor(effectiveAt - timing.opensAt - baseMs))
      );
    }
    window.debited = true;
    timing.state = "resolved";
  }

  releaseReservation(seat: Seat, receipt: InputReceipt): void {
    const window = this.windows[seat];
    if (
      sameWindowReceipt(window.reservation, receipt) &&
      window.timing?.id === receipt.windowId
    ) {
      window.reservation = null;
      window.reservedActionId = null;
      if (window.timing && !window.debited) {
        this.schedule(
          seat,
          Math.max(0, window.timing.expiresAt - this.runtime.now())
        );
      }
    }
  }

  restoreTimed(
    seat: Seat,
    actions: readonly LegalAction[],
    timing: ActionWindowView,
    savedAt: number,
    clockEpoch: string,
    restoredAt = this.runtime.now()
  ): void {
    const shift = restoredAt - savedAt;
    this.openTimed(seat, actions, {
      ...timing,
      clockEpoch,
      infoSentAt: timing.infoSentAt + shift,
      opensAt: timing.opensAt + shift,
      baseEndsAt: timing.baseEndsAt + shift,
      budgetEndsAt: timing.budgetEndsAt + shift,
      expiresAt: timing.expiresAt + shift,
    });
    const restored = this.windows[seat];
    if (restored.timing) {
      restored.timing.generation = timing.generation;
      restored.timing.state = timing.state;
    }
    if (timing.state === "resolved" || timing.state === "cancelled") {
      this.cancelTimer(seat);
      restored.debited = true;
      restored.actions = [];
      restored.kind = null;
    }
  }

  private schedule(seat: Seat, delayMs: number): void {
    const window = this.windows[seat];
    const generation = window.generation;
    window.timer = this.runtime.schedule(
      () => {
        if (
          window.generation !== generation ||
          this.isPaused() ||
          window.reservation !== null
        ) {
          return;
        }
        if (window.timing !== null) {
          window.timing.state = "expired";
        }
        this.onExpiry(seat);
      },
      delayMs,
      { unref: true }
    );
  }
}
