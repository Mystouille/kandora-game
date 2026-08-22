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

function hasAutoPassableCall(actions: readonly LegalAction[]): boolean {
  return actions.some(
    (action) =>
      action.type === "chi" ||
      action.type === "pon" ||
      (action.type === "kan" && action.kanKind === "daiminkan")
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
  const hasWin = actions.some(
    (action) => action.type === "ron" || action.type === "tsumo"
  );
  return hasWin || !hasAutoPassableCall(actions);
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