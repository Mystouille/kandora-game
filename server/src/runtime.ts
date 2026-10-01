import { createPRNG } from "~/game/rules";
import type { AuthorityClock } from "./timing/authorityClock";

export interface MatchTimer {
  cancel(): void;
}

export interface MatchTimerOptions {
  unref?: boolean;
}

export interface MatchRuntime {
  readonly clockEpoch?: string;
  now(): number;
  wallNow?(): number;
  random(): number;
  captureRandomState(): number;
  restoreRandomState(state: number): void;
  schedule(
    callback: () => void,
    delayMs: number,
    options?: MatchTimerOptions
  ): MatchTimer;
  sleep(delayMs: number): Promise<void>;
}

export function createSystemMatchRuntime(
  seed: number,
  clock?: AuthorityClock
): MatchRuntime {
  const random = createPRNG(seed);
  return {
    now: () => clock?.now() ?? Date.now(),
    wallNow: () => clock?.wallNow() ?? Date.now(),
    ...(clock ? { clockEpoch: clock.epoch } : {}),
    random: () => random.next(),
    captureRandomState: () => random.getState(),
    restoreRandomState: (state) => random.setState(state),
    schedule(callback, delayMs, options) {
      const handle = globalThis.setTimeout(callback, delayMs);
      if (options?.unref) {
        (handle as unknown as { unref?: () => void }).unref?.();
      }

      return {
        cancel: () => globalThis.clearTimeout(handle),
      };
    },
    sleep(delayMs) {
      return new Promise((resolve) => {
        globalThis.setTimeout(resolve, delayMs);
      });
    },
  };
}

export function runtimeCalendarNow(
  runtime: Pick<MatchRuntime, "now" | "wallNow">
): number {
  return runtime.wallNow?.() ?? runtime.now();
}
