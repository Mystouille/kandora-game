export interface FairnessProfile {
  readonly name: string;
  readonly roundTripMs: number;
  readonly jitterMs: number;
  readonly asymmetryMs: number;
  readonly framesPerSecond: number;
  readonly stallMs?: number;
  readonly burstMs?: number;
}

export type TransportDirection = "upstream" | "downstream";

export const SUPPORTED_FAIRNESS_PROFILES: readonly FairnessProfile[] = [
  {
    name: "rtt-0-60fps",
    roundTripMs: 0,
    jitterMs: 0,
    asymmetryMs: 0,
    framesPerSecond: 60,
  },
  {
    name: "rtt-0-jitter-50-30fps",
    roundTripMs: 0,
    jitterMs: 50,
    asymmetryMs: 0,
    framesPerSecond: 30,
  },
  {
    name: "rtt-100-60fps",
    roundTripMs: 100,
    jitterMs: 0,
    asymmetryMs: 0,
    framesPerSecond: 60,
  },
  {
    name: "rtt-100-jitter-50-30fps",
    roundTripMs: 100,
    jitterMs: 50,
    asymmetryMs: 0,
    framesPerSecond: 30,
  },
  {
    name: "rtt-100-slow-uplink-30fps",
    roundTripMs: 100,
    jitterMs: 0,
    asymmetryMs: 50,
    framesPerSecond: 30,
  },
  {
    name: "rtt-100-slow-downlink-30fps",
    roundTripMs: 100,
    jitterMs: 0,
    asymmetryMs: -50,
    framesPerSecond: 30,
  },
  {
    name: "rtt-300-60fps",
    roundTripMs: 300,
    jitterMs: 0,
    asymmetryMs: 0,
    framesPerSecond: 60,
  },
  {
    name: "rtt-300-jitter-50-30fps",
    roundTripMs: 300,
    jitterMs: 50,
    asymmetryMs: 0,
    framesPerSecond: 30,
  },
  {
    name: "rtt-300-slow-uplink-30fps",
    roundTripMs: 300,
    jitterMs: 0,
    asymmetryMs: 50,
    framesPerSecond: 30,
  },
  {
    name: "rtt-300-slow-downlink-30fps",
    roundTripMs: 300,
    jitterMs: 0,
    asymmetryMs: -50,
    framesPerSecond: 30,
  },
  {
    name: "rtt-300-jitter-asymmetric-30fps",
    roundTripMs: 300,
    jitterMs: 50,
    asymmetryMs: 25,
    framesPerSecond: 30,
  },
];

export const DEGRADED_FAIRNESS_PROFILES: readonly FairnessProfile[] = [
  {
    name: "beyond-cap-downlink",
    roundTripMs: 1_400,
    jitterMs: 0,
    asymmetryMs: -400,
    framesPerSecond: 60,
  },
  {
    name: "15fps",
    roundTripMs: 100,
    jitterMs: 0,
    asymmetryMs: 0,
    framesPerSecond: 15,
  },
  {
    name: "5fps",
    roundTripMs: 100,
    jitterMs: 0,
    asymmetryMs: 0,
    framesPerSecond: 5,
  },
  {
    name: "main-thread-stall",
    roundTripMs: 100,
    jitterMs: 0,
    asymmetryMs: 0,
    framesPerSecond: 60,
    stallMs: 750,
  },
  {
    name: "burst-delivery",
    roundTripMs: 300,
    jitterMs: 0,
    asymmetryMs: 0,
    framesPerSecond: 30,
    burstMs: 800,
  },
];

export function transportDelayMs(
  profile: FairnessProfile,
  direction: TransportDirection,
  sequence: number
): number {
  if (
    !Number.isSafeInteger(sequence) ||
    sequence < 0 ||
    !Number.isFinite(profile.roundTripMs) ||
    !Number.isFinite(profile.asymmetryMs) ||
    !Number.isFinite(profile.jitterMs) ||
    profile.roundTripMs < Math.abs(profile.asymmetryMs) ||
    profile.jitterMs < 0
  ) {
    throw new RangeError("Invalid controlled transport profile");
  }
  const sign = direction === "upstream" ? 1 : -1;
  // Independent directions vary by at most 25 ms when RTT jitter is 50 ms.
  const jitter = ([0, 0.5, 1, 0.5][sequence % 4] * profile.jitterMs) / 2;
  const delay = (profile.roundTripMs + sign * profile.asymmetryMs) / 2 + jitter;
  return direction === "upstream" ? Math.floor(delay) : Math.ceil(delay);
}

export function degradedReasons(profile: FairnessProfile): string[] {
  const reasons: string[] = [];
  if (profile.roundTripMs > 300) {
    reasons.push("RTT exceeds the supported 300 ms profile");
  }
  if (profile.jitterMs > 50) {
    reasons.push("RTT jitter exceeds 50 ms");
  }
  if (Math.abs(profile.asymmetryMs) + profile.jitterMs / 2 > 50) {
    reasons.push("One-way asymmetry exceeds 50 ms");
  }
  if (profile.framesPerSecond < 30) {
    reasons.push("Rendering is below 30 FPS");
  }
  if ((profile.stallMs ?? 0) > 0) {
    reasons.push("The main thread is stalled");
  }
  if ((profile.burstMs ?? 0) > 50) {
    reasons.push("Burst delivery exceeds the supported jitter envelope");
  }
  return reasons;
}
