const EPOCH_MILLISECONDS_THRESHOLD = 100_000_000_000;
const EPOCH_MICROSECONDS_THRESHOLD = 100_000_000_000_000;

/** Normalize epoch seconds, milliseconds, or microseconds to milliseconds. */
export function normalizeEpochMilliseconds(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }
  if (value < EPOCH_MILLISECONDS_THRESHOLD) {
    return Math.trunc(value * 1000);
  }
  if (value >= EPOCH_MICROSECONDS_THRESHOLD) {
    return Math.trunc(value / 1000);
  }
  return Math.trunc(value);
}
