export interface ClientTimingDiagnostic {
  kind: "clock-quality" | "late-presentation" | "epoch-mismatch";
  clockEpoch: string;
  windowId?: string;
  seq?: number;
  roundTripMs?: number;
  uncertaintyMs?: number;
  latenessMs?: number;
}

const observers = new Set<(event: Readonly<ClientTimingDiagnostic>) => void>();
const recent: ClientTimingDiagnostic[] = [];
const emitted = new Set<string>();

export function observeClientTiming(
  observer: (event: Readonly<ClientTimingDiagnostic>) => void
): () => void {
  observers.add(observer);
  return () => {
    observers.delete(observer);
  };
}

export function reportClientTiming(event: ClientTimingDiagnostic): void {
  const key = `${event.kind}:${event.clockEpoch}:${event.windowId ?? ""}:${event.seq ?? ""}`;
  if (emitted.has(key)) {
    return;
  }
  emitted.add(key);
  recent.push({ ...event });
  if (recent.length > 64) {
    const oldest = recent.shift();
    if (oldest) {
      emitted.delete(
        `${oldest.kind}:${oldest.clockEpoch}:${oldest.windowId ?? ""}:${oldest.seq ?? ""}`
      );
    }
  }
  console.debug("[game-client-timing]", JSON.stringify(event));
  for (const observer of observers) {
    try {
      observer(Object.freeze({ ...event }));
    } catch (error) {
      console.error("[game-client-timing] diagnostic observer failed", error);
    }
  }
}

export function reportClockQuality(quality: ClockQuality | null): void {
  if (quality && (quality.roundTripMs > 500 || quality.uncertaintyMs > 250)) {
    reportClientTiming({
      kind: "clock-quality",
      clockEpoch: quality.clockEpoch,
      roundTripMs: quality.roundTripMs,
      uncertaintyMs: quality.uncertaintyMs,
    });
  }
}

export function recentClientTiming(): ReadonlyArray<
  Readonly<ClientTimingDiagnostic>
> {
  return recent.map((event) => Object.freeze({ ...event }));
}
import type { ClockQuality } from "./serverClock";
