import { ClockSampleSchema, type ClockSample } from "~/game/protocol/timing";

export interface ClockQuality {
  clockEpoch: string;
  roundTripMs: number;
  uncertaintyMs: number;
  sampledAt: number;
}

interface OffsetSample extends ClockQuality {
  offsetMs: number;
}

type SampleResult =
  | { accepted: true }
  | {
      accepted: false;
      reason: "unknown-probe" | "invalid-sample" | "invalid-clock";
    };

const SAMPLE_LIMIT = 16;
const PROBE_LIMIT = 32;
const SAMPLE_TTL_MS = 30_000;

export class ServerClock {
  private readonly monotonicNow: () => number;
  private readonly probes = new Map<string, number>();
  private samples: OffsetSample[] = [];
  private epoch: string | null = null;
  private lastEstimate: number | null = null;

  constructor(options: { monotonicNow?: () => number } = {}) {
    this.monotonicNow = options.monotonicNow ?? (() => performance.now());
  }

  createProbe(probeId: string): { probeId: string } {
    const now = this.monotonicNow();
    if (!probeId || this.probes.has(probeId) || !Number.isFinite(now)) {
      throw new RangeError("Invalid or duplicate clock probe");
    }
    if (this.probes.size >= PROBE_LIMIT) {
      const first = this.probes.keys().next().value;
      if (first !== undefined) {
        this.probes.delete(first);
      }
    }
    this.probes.set(probeId, now);
    return { probeId };
  }

  observe(input: ClockSample): SampleResult {
    const parsed = ClockSampleSchema.safeParse(input);
    if (!parsed.success) {
      return { accepted: false, reason: "invalid-sample" };
    }
    const sentAt = this.probes.get(parsed.data.probeId);
    if (sentAt === undefined) {
      return { accepted: false, reason: "unknown-probe" };
    }
    this.probes.delete(parsed.data.probeId);
    const receivedAt = this.monotonicNow();
    const processingMs =
      parsed.data.serverSentAt - parsed.data.serverReceivedAt;
    const roundTripMs = receivedAt - sentAt - processingMs;
    if (!Number.isFinite(receivedAt) || roundTripMs < 0) {
      return { accepted: false, reason: "invalid-clock" };
    }
    if (this.epoch !== parsed.data.clockEpoch) {
      if (this.epoch !== null) {
        this.probes.clear();
      }
      this.samples = [];
      this.epoch = parsed.data.clockEpoch;
      this.lastEstimate = null;
    }
    this.samples.push({
      clockEpoch: parsed.data.clockEpoch,
      roundTripMs,
      uncertaintyMs: roundTripMs / 2,
      sampledAt: receivedAt,
      offsetMs:
        (parsed.data.serverReceivedAt +
          parsed.data.serverSentAt -
          sentAt -
          receivedAt) /
        2,
    });
    this.samples = this.samples.slice(-SAMPLE_LIMIT);
    return { accepted: true };
  }

  now(): number | null {
    const now = this.monotonicNow();
    const sample = this.bestSample(now);
    if (sample === null) {
      return null;
    }
    this.lastEstimate = Math.max(
      this.lastEstimate ?? 0,
      Math.floor(now + sample.offsetMs)
    );
    return this.lastEstimate;
  }

  quality(): ClockQuality | null {
    const sample = this.bestSample(this.monotonicNow());
    if (sample === null) {
      return null;
    }
    return {
      clockEpoch: sample.clockEpoch,
      roundTripMs: sample.roundTripMs,
      uncertaintyMs: sample.uncertaintyMs,
      sampledAt: sample.sampledAt,
    };
  }

  invalidate(): void {
    this.probes.clear();
    this.samples = [];
    this.epoch = null;
    this.lastEstimate = null;
  }

  private bestSample(now: number): OffsetSample | null {
    if (!Number.isFinite(now)) {
      throw new RangeError("Invalid client monotonic clock");
    }
    const valid = this.samples.filter(
      (sample) =>
        now >= sample.sampledAt && now - sample.sampledAt <= SAMPLE_TTL_MS
    );
    return valid.reduce<OffsetSample | null>(
      (best, sample) =>
        best === null || sample.roundTripMs < best.roundTripMs ? sample : best,
      null
    );
  }
}
