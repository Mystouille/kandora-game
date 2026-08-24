import { createPRNG } from "~/game/rules";

export interface MatchTimer {
  cancel(): void;
}

export interface MatchTimerOptions {
  unref?: boolean;
}

export interface MatchRuntime {
  now(): number;
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

export function createSystemMatchRuntime(seed: number): MatchRuntime {
  const random = createPRNG(seed);
  return {
    now: () => Date.now(),
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