export interface AuthorityClock {
  readonly epoch: string;
  now(): number;
  wallNow(): number;
}

interface AuthorityClockOptions {
  epoch?: string;
  wallNow?: () => number;
  monotonicNow?: () => number;
}

export function createAuthorityClock({
  epoch = globalThis.crypto.randomUUID(),
  wallNow = () => Date.now(),
  monotonicNow = () => performance.now(),
}: AuthorityClockOptions = {}): AuthorityClock {
  const wallOrigin = wallNow();
  const monotonicOrigin = monotonicNow();
  if (
    epoch.length === 0 ||
    !Number.isFinite(wallOrigin) ||
    !Number.isFinite(monotonicOrigin) ||
    wallOrigin < 0
  ) {
    throw new RangeError("Invalid authority clock origin");
  }
  let previous = monotonicOrigin;
  return {
    epoch,
    now: () => {
      const monotonic = monotonicNow();
      if (!Number.isFinite(monotonic) || monotonic < previous) {
        throw new RangeError(
          "Authority monotonic clock regressed or is invalid"
        );
      }
      previous = monotonic;
      return Math.floor(wallOrigin + monotonic - monotonicOrigin);
    },
    wallNow,
  };
}
