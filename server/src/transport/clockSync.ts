import { ClockProbeSchema, type ClockSample } from "../../../protocol/timing";
import type { AuthorityClock } from "../timing/authorityClock";

export function clockSampleForProbe(
  input: unknown,
  expectedMatchId: string,
  clock: AuthorityClock,
  receivedAt: number
): ClockSample {
  const probe = ClockProbeSchema.parse(input);
  if (probe.matchId !== expectedMatchId) {
    throw new Error("Clock probe targets a different match");
  }
  return {
    type: "clock_sample",
    probeId: probe.probeId,
    clockEpoch: clock.epoch,
    serverReceivedAt: receivedAt,
    serverSentAt: clock.now(),
  };
}
