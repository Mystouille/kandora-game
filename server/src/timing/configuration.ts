import type { TimingObserver } from "./timingDiagnostics";

export interface TimingConfiguration {
  onTimingDiagnostic?: TimingObserver;
}

export function timingConfiguration(env: {
  GAME_TIMING_DIAGNOSTICS?: string;
}): TimingConfiguration {
  const flag = (name: string, value?: string): boolean => {
    if (value !== undefined && value !== "true" && value !== "false") {
      throw new Error(`${name} must be true or false`);
    }
    return value === "true";
  };
  const diagnostics = flag(
    "GAME_TIMING_DIAGNOSTICS",
    env.GAME_TIMING_DIAGNOSTICS
  );
  return diagnostics
    ? {
        onTimingDiagnostic: (event) =>
          console.info("[game-timing]", JSON.stringify(event)),
      }
    : {};
}
