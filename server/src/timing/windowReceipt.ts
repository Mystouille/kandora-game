import type { ActionWindowView, InputReceipt } from "~/game/protocol/timing";

export class DecisionWindowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DecisionWindowError";
  }
}

export function sameWindowReceipt(
  left: InputReceipt | null | undefined,
  right: InputReceipt
): boolean {
  return (
    left !== null &&
    left !== undefined &&
    left.receivedAt === right.receivedAt &&
    left.windowId === right.windowId &&
    left.clockEpoch === right.clockEpoch &&
    left.ownerGeneration === right.ownerGeneration
  );
}

export function validateWindowReceipt(
  window: ActionWindowView,
  action: string,
  receipt: InputReceipt
): void {
  if (window.state === "resolved" || window.state === "cancelled") {
    throw new DecisionWindowError(
      "This decision is no longer accepting replies"
    );
  }
  if (
    receipt.windowId !== window.id ||
    receipt.clockEpoch !== window.clockEpoch
  ) {
    throw new DecisionWindowError("Stale decision window or authority epoch");
  }
  if (
    !Number.isSafeInteger(receipt.receivedAt) ||
    receipt.receivedAt < window.opensAt
  ) {
    throw new DecisionWindowError("Decision window is not open");
  }
  if (
    receipt.receivedAt > window.expiresAt ||
    !window.legalActionIds.includes(action)
  ) {
    throw new DecisionWindowError(
      "Decision window expired or action is no longer legal"
    );
  }
}
