import { TimingModeSchema, type TimingMode } from "~/game/protocol/timing";
import type { TimingObserver } from "./timingDiagnostics";

export interface TimingConfiguration {
  timingMode: TimingMode;
  timingShadow: boolean;
  onTimingDiagnostic?: TimingObserver;
}

export function timingConfiguration(env: {
  GAME_TIMING_MODE?: string;
  GAME_TIMING_SHADOW?: string;
  GAME_TIMING_DIAGNOSTICS?: string;
}): TimingConfiguration {
  const timingMode = TimingModeSchema.parse(env.GAME_TIMING_MODE ?? "legacy");
  const flag = (name: string, value?: string): boolean => {
    if (value !== undefined && value !== "true" && value !== "false") {
      throw new Error(`${name} must be true or false`);
    }
    return value === "true";
  };
  const timingShadow = flag("GAME_TIMING_SHADOW", env.GAME_TIMING_SHADOW);
  const diagnostics = flag(
    "GAME_TIMING_DIAGNOSTICS",
    env.GAME_TIMING_DIAGNOSTICS
  );
  if (timingShadow && timingMode !== "legacy") {
    throw new Error("Shadow comparison requires whole-match legacy timing");
  }
  return {
    timingMode,
    timingShadow,
    ...(diagnostics || timingShadow
      ? {
          onTimingDiagnostic: (event) =>
            console.info("[game-timing]", JSON.stringify(event)),
        }
      : {}),
  };
}
