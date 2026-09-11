import type { LegalAction } from "~/game/protocol/messages";
import type { MatchView } from "./store";

export type NoCallAutoPassState = Pick<
  MatchView,
  "matchId" | "lastSeq" | "conn" | "legalActions"
>;

export interface NoCallAutoPassController {
  evaluate(state: NoCallAutoPassState): boolean;
}

export interface NoCallAutoPassControllerOptions {
  isEnabled: () => boolean;
  send: (actionId: string) => boolean;
  onSent?: (actionId: string, state: NoCallAutoPassState) => void;
}

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

export function createNoCallAutoPassController(
  options: NoCallAutoPassControllerOptions
): NoCallAutoPassController {
  let sentWindowKey: string | null = null;

  return {
    evaluate(state): boolean {
      if (state.conn !== "open") {
        sentWindowKey = null;
        return false;
      }
      if (state.legalActions.length === 0) {
        sentWindowKey = null;
        return false;
      }
      const pass = findNoCallAutoPass(
        state.legalActions,
        options.isEnabled()
      );
      if (!pass) {
        return false;
      }
      const windowKey = `${state.matchId ?? ""}:${state.lastSeq}:${pass.id}`;
      if (sentWindowKey === windowKey || !options.send(pass.id)) {
        return false;
      }
      sentWindowKey = windowKey;
      options.onSent?.(pass.id, state);
      return true;
    },
  };
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