import type { LegalAction } from "~/game/protocol/messages";

const CALL_PROMPT_ACTION_TYPES: ReadonlySet<LegalAction["type"]> = new Set([
  "chi",
  "pon",
  "kan",
  "ron",
  "tsumo",
]);

function hasCallPrompt(actions: readonly LegalAction[]): boolean {
  return actions.some((action) => CALL_PROMPT_ACTION_TYPES.has(action.type));
}

function isAutoPassableCall(action: LegalAction): boolean {
  return (
    action.type === "chi" ||
    action.type === "pon" ||
    (action.type === "kan" && action.kanKind === "daiminkan")
  );
}

function hasAutoPassableCall(actions: readonly LegalAction[]): boolean {
  return actions.some(isAutoPassableCall);
}

function hasWin(actions: readonly LegalAction[]): boolean {
  return actions.some(
    (action) => action.type === "ron" || action.type === "tsumo"
  );
}

export function findNoCallAutoPass(
  actions: readonly LegalAction[],
  noCallEnabled: boolean
): LegalAction | undefined {
  if (!noCallEnabled || hasWin(actions) || !hasAutoPassableCall(actions)) {
    return undefined;
  }
  return actions.find((action) => action.type === "pass");
}

export function filterNoCallActionButtons(
  actions: readonly LegalAction[],
  noCallEnabled: boolean
): LegalAction[] {
  if (!noCallEnabled || !hasAutoPassableCall(actions)) {
    return [...actions];
  }
  const autoPass = findNoCallAutoPass(actions, noCallEnabled);
  return actions.filter(
    (action) =>
      !isAutoPassableCall(action) &&
      !(autoPass !== undefined && action.id === autoPass.id)
  );
}

export function shouldPlayCallPrompt(
  actions: readonly LegalAction[],
  noCallEnabled: boolean
): boolean {
  if (!hasCallPrompt(actions)) {
    return false;
  }
  if (!noCallEnabled) {
    return true;
  }
  return hasWin(actions) || !hasAutoPassableCall(actions);
}

export function shouldTriggerCallPrompt(
  previousActions: readonly LegalAction[],
  nextActions: readonly LegalAction[],
  noCallEnabled: boolean
): boolean {
  return (
    !shouldPlayCallPrompt(previousActions, noCallEnabled) &&
    shouldPlayCallPrompt(nextActions, noCallEnabled)
  );
}