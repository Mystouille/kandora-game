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

export type CallPromptPresentationKind = "draw" | "discard";
export type CallPromptSoundDecision = "none" | "play" | "defer";

export interface CallPromptPresentation {
  kind: CallPromptPresentationKind;
  seq: number;
}

export interface CallPromptSoundSequencer {
  notePresentation(
    kind: CallPromptPresentationKind,
    seq: number,
    shouldDefer: boolean
  ): void;
  updateActions(
    previousActions: readonly LegalAction[],
    nextActions: readonly LegalAction[],
    noCallEnabled: boolean
  ): CallPromptSoundDecision;
  presentationLanded(kind: CallPromptPresentationKind, seq: number): boolean;
  reset(): void;
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
      const pass = findNoCallAutoPass(state.legalActions, options.isEnabled());
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

export function createCallPromptSoundSequencer(): CallPromptSoundSequencer {
  let pendingPresentation: CallPromptPresentation | null = null;
  let deferredPrompt: CallPromptPresentation | null = null;

  return {
    notePresentation(kind, seq, shouldDefer): void {
      pendingPresentation = shouldDefer ? { kind, seq } : null;
    },

    updateActions(
      previousActions,
      nextActions,
      noCallEnabled
    ): CallPromptSoundDecision {
      const presentation = pendingPresentation;

      if (!shouldPlayCallPrompt(nextActions, noCallEnabled)) {
        deferredPrompt = null;
        // The discard frame arrives before its same-sequence call actions.
        // Keep the presentation pending across that intermediate empty update.
        return "none";
      }
      if (
        !shouldTriggerCallPrompt(previousActions, nextActions, noCallEnabled)
      ) {
        return "none";
      }
      if (presentation !== null) {
        deferredPrompt = presentation;
        return "defer";
      }

      deferredPrompt = null;
      return "play";
    },

    presentationLanded(kind, seq): boolean {
      if (
        pendingPresentation?.kind === kind &&
        pendingPresentation.seq === seq
      ) {
        pendingPresentation = null;
      }
      if (deferredPrompt?.kind !== kind || deferredPrompt.seq !== seq) {
        return false;
      }
      deferredPrompt = null;
      return true;
    },

    reset(): void {
      pendingPresentation = null;
      deferredPrompt = null;
    },
  };
}
