import type {
  ActionIntentContext,
  ActionWindowView,
} from "~/game/protocol/timing";
import { useMatchStore } from "../store";
import { intentForWindow, actionTimerView } from "./actionWindowViewModel";
import { liveServerNow } from "./liveClock";

let pending: ReturnType<typeof setTimeout> | null = null;

export function displayedActionIntent(
  actionId: string,
  window: ActionWindowView | null | undefined,
  stateSeq: number
): ActionIntentContext | undefined {
  if (!window) {
    return undefined;
  }

  const now = liveServerNow();
  if (
    now === null ||
    !actionTimerView(window, now).ready ||
    !window.legalActionIds.includes(actionId)
  ) {
    throw new Error(
      "The displayed decision is not ready or the action is stale"
    );
  }
  return intentForWindow(window, stateSeq);
}

export function decisionIsReady(
  window: ActionWindowView | null | undefined
): boolean {
  if (!window) {
    return true;
  }
  const now = liveServerNow();
  return now !== null && actionTimerView(window, now).ready;
}

export function refreshScheduledWindow(): void {
  if (pending !== null) {
    clearTimeout(pending);
    pending = null;
  }
  const store = useMatchStore.getState();
  const window = store.actionWindow;
  const now = liveServerNow();
  if (!window || now === null || window.state !== "scheduled") {
    return;
  }
  const remaining = window.opensAt - now;
  if (remaining <= 0) {
    store.setTimingMetadata({ actionWindow: { ...window, state: "open" } });
    store.setLegalActions([...store.legalActions]);
    return;
  }
  pending = setTimeout(() => {
    pending = null;
    if (useMatchStore.getState().actionWindow?.id === window.id) {
      refreshScheduledWindow();
    }
  }, remaining);
}

export function clearScheduledWindow(): void {
  if (pending !== null) {
    clearTimeout(pending);
    pending = null;
  }
}
