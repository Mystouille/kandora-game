import type { MatchView } from "../../store";

export function resolveActionTimerState(
  view: Pick<MatchView, "readyCheck" | "actionDeadline" | "actionBufferMs">
): { deadline: number | null; bufferMs: number | null } {
  if (view.readyCheck !== null) {
    return { deadline: null, bufferMs: null };
  }
  return {
    deadline: view.actionDeadline,
    bufferMs: view.actionBufferMs,
  };
}

export function resolveTableHudState(
  view: Pick<
    MatchView,
    | "conn"
    | "drawsTaken"
    | "lastSeq"
    | "readyCheck"
    | "actionDeadline"
    | "actionBufferMs"
  >,
  showConnectionDiagnostics: boolean
): { diagnostics: string; deadline: number | null; bufferMs: number | null } {
  if (view.conn === "replay") {
    return { diagnostics: "", deadline: null, bufferMs: null };
  }
  const actionTimer = resolveActionTimerState(view);
  return {
    diagnostics: showConnectionDiagnostics
      ? `conn: ${view.conn}   wall: ${Math.max(0, 70 - view.drawsTaken)}   seq: ${
          view.lastSeq
        }`
      : "",
    ...actionTimer,
  };
}

export function actionTimerTickDecision(
  previousTotalSeconds: number | null,
  allocationSeconds: number,
  bufferSeconds: number
): { displayedTotalSeconds: number; play: boolean } {
  const displayedTotalSeconds = allocationSeconds + bufferSeconds;
  return {
    displayedTotalSeconds,
    play:
      displayedTotalSeconds > 0 &&
      displayedTotalSeconds < 5 &&
      displayedTotalSeconds !== previousTotalSeconds,
  };
}

export interface ActionTimerFrame {
  readonly text: string;
  readonly baseSeconds: number;
  readonly bufferSeconds: number;
  readonly displayedTotalSeconds: number;
  readonly style: "normal" | "warn" | "danger";
  readonly play: boolean;
}

export function projectActionTimer(
  deadline: number,
  bufferMs: number | null,
  now: number,
  previousTotalSeconds: number | null
): ActionTimerFrame {
  const baseRemainingMs = Math.max(0, deadline - now);
  const baseElapsedOverflowMs = Math.max(0, now - deadline);
  const bufferRemainingMs = Math.max(
    0,
    (bufferMs ?? 0) - baseElapsedOverflowMs
  );
  const baseSeconds = Math.ceil(baseRemainingMs / 1000);
  const bufferSeconds = Math.ceil(bufferRemainingMs / 1000);
  const decision = actionTimerTickDecision(
    previousTotalSeconds,
    baseSeconds,
    bufferSeconds
  );
  return {
    text:
      bufferMs === null
        ? `${baseSeconds}s`
        : `${baseSeconds} + ${bufferSeconds}`,
    baseSeconds,
    bufferSeconds,
    displayedTotalSeconds: decision.displayedTotalSeconds,
    style:
      decision.displayedTotalSeconds <= 5
        ? "danger"
        : baseSeconds === 0
          ? "warn"
          : "normal",
    play: decision.play,
  };
}
