export interface LatencyProfile {
  roundTripMs: number;
  jitterMs: number;
  measuredAt: number;
  samples: number;
}

const SAMPLE_LIMIT = 16;
const PROFILE_TTL_MS = 30_000;
const MAX_SAMPLE_MS = 10_000;

export class LatencySampler {
  private readonly pending = new Map<string, number>();
  private samples: Array<{ roundTripMs: number; at: number }> = [];

  constructor(private readonly now: () => number) {}

  sent(probeId: string): void {
    if (!probeId || this.pending.has(probeId)) {
      throw new Error("Duplicate or empty latency probe");
    }
    if (this.pending.size >= SAMPLE_LIMIT) {
      const first = this.pending.keys().next().value;
      if (first !== undefined) {
        this.pending.delete(first);
      }
    }
    this.pending.set(probeId, this.now());
  }

  received(probeId: string): boolean {
    const sentAt = this.pending.get(probeId);
    if (sentAt === undefined) {
      return false;
    }
    this.pending.delete(probeId);
    const at = this.now();
    const roundTripMs = at - sentAt;
    if (roundTripMs < 0 || roundTripMs > MAX_SAMPLE_MS) {
      return false;
    }
    this.samples.push({ roundTripMs, at });
    this.samples = this.samples.slice(-SAMPLE_LIMIT);
    return true;
  }

  profile(): LatencyProfile | null {
    const now = this.now();
    const recent = this.samples.filter(
      (sample) => now >= sample.at && now - sample.at <= PROFILE_TTL_MS
    );
    const baseline = Math.min(...recent.map((sample) => sample.roundTripMs));
    const valid = recent.filter(
      (sample) => sample.roundTripMs <= baseline + Math.max(50, baseline * 0.25)
    );
    if (valid.length < 3) {
      return null;
    }
    const sorted = valid
      .map((sample) => sample.roundTripMs)
      .sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const upper = sorted[Math.ceil(0.9 * sorted.length) - 1];
    return {
      roundTripMs: median,
      jitterMs: Math.max(0, upper - median),
      measuredAt: Math.max(...valid.map((sample) => sample.at)),
      samples: valid.length,
    };
  }

  reset(): void {
    this.pending.clear();
    this.samples = [];
  }
}
