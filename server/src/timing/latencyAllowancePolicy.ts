import {
  FALLBACK_LATENCY_ALLOWANCE_MS,
  MAX_LATENCY_ALLOWANCE_MS,
} from "~/game/protocol/timing";
import type { LatencyProfile } from "../transport/latencyProfile";

export interface AllowanceContext {
  network: "direct" | "remote";
  profile: LatencyProfile | null;
  infoSentAt: number;
  opensAt: number;
  now: number;
}

export function latencyAllowanceMs({
  network,
  profile,
  infoSentAt,
  opensAt,
  now,
}: AllowanceContext): number {
  if (network === "direct") {
    return 0;
  }
  if (
    profile === null ||
    profile.samples < 3 ||
    !Number.isFinite(profile.roundTripMs) ||
    !Number.isFinite(profile.jitterMs) ||
    profile.roundTripMs < 0 ||
    profile.jitterMs < 0 ||
    now < profile.measuredAt ||
    now - profile.measuredAt > 30_000
  ) {
    return FALLBACK_LATENCY_ALLOWANCE_MS;
  }
  const oneWayMs = profile.roundTripMs / 2;
  const deliveryLeadMs = Math.max(0, opensAt - infoSentAt);
  const outboundLateMs = Math.max(0, oneWayMs - deliveryLeadMs);
  return Math.min(
    MAX_LATENCY_ALLOWANCE_MS,
    Math.ceil(oneWayMs + outboundLateMs + profile.jitterMs / 2)
  );
}
