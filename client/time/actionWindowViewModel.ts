import type {
  ActionWindowView,
  ActionIntentContext,
} from "~/game/protocol/timing";

export interface ActionTimerView {
  ready: boolean;
  baseRemainingMs: number;
  bankRemainingMs: number;
  baseSeconds: number;
  bankSeconds: number;
}

export function actionTimerView(
  window: ActionWindowView,
  serverNow: number
): ActionTimerView {
  if (!Number.isFinite(serverNow)) {
    throw new RangeError("Invalid synchronized time");
  }
  const active = window.state === "scheduled" || window.state === "open";
  const ready =
    active && serverNow >= window.opensAt && serverNow <= window.budgetEndsAt;
  const baseRemainingMs = Math.max(
    0,
    window.baseEndsAt - Math.max(serverNow, window.opensAt)
  );
  const bankRemainingMs = Math.max(
    0,
    window.bankAtOpenMs - Math.max(0, serverNow - window.baseEndsAt)
  );
  return {
    ready,
    baseRemainingMs,
    bankRemainingMs,
    baseSeconds: Math.ceil(baseRemainingMs / 1_000),
    bankSeconds: Math.ceil(bankRemainingMs / 1_000),
  };
}

export function intentForWindow(
  window: ActionWindowView,
  stateSeq: number
): ActionIntentContext {
  return { windowId: window.id, clockEpoch: window.clockEpoch, stateSeq };
}
