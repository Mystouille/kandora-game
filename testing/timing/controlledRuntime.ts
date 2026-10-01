import { createPRNG } from "~/game/rules";
import type { MatchRuntime, MatchTimer } from "~/game/server/src/runtime";

interface ScheduledTask {
  at: number;
  order: number;
  callback: () => void;
  cancelled: boolean;
}

export interface ControlledRuntime extends MatchRuntime {
  advanceBy(ms: number): Promise<void>;
  pendingDelays(): number[];
}

export function createControlledRuntime(
  initialNow = 1_000_000,
  seed = 42
): ControlledRuntime {
  let now = initialNow;
  let order = 0;
  const random = createPRNG(seed);
  const tasks: ScheduledTask[] = [];
  const schedule = (callback: () => void, delayMs: number): MatchTimer => {
    if (!Number.isFinite(delayMs) || delayMs < 0) {
      throw new RangeError("Invalid controlled timer delay");
    }
    const task: ScheduledTask = {
      at: now + delayMs,
      order: order++,
      callback,
      cancelled: false,
    };
    tasks.push(task);
    return {
      cancel: () => {
        task.cancelled = true;
      },
    };
  };
  return {
    now: () => now,
    random: () => random.next(),
    captureRandomState: () => random.getState(),
    restoreRandomState: (state) => random.setState(state),
    schedule,
    sleep: (delayMs) =>
      new Promise((resolve) => {
        schedule(resolve, delayMs);
      }),
    advanceBy: async (ms) => {
      if (!Number.isFinite(ms) || ms < 0) {
        throw new RangeError("Controlled time cannot regress");
      }
      const target = now + ms;
      let iterations = 0;
      const nextTask = () =>
        tasks
          .filter((task) => !task.cancelled && task.at <= target)
          .sort((a, b) => a.at - b.at || a.order - b.order)[0];
      let next = nextTask();
      while (next !== undefined) {
        if (++iterations > 10_000) {
          throw new Error("Controlled timer loop exceeded its bound");
        }
        next.cancelled = true;
        now = next.at;
        next.callback();
        await Promise.resolve();
        await Promise.resolve();
        next = nextTask();
      }
      now = target;
      await Promise.resolve();
    },
    pendingDelays: () =>
      tasks
        .filter((task) => !task.cancelled)
        .map((task) => task.at - now)
        .sort((a, b) => a - b),
  };
}
