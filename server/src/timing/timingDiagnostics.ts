import type { Seat } from "~/game/protocol/messages";
import type { ActionWindowView, InputReceipt } from "~/game/protocol/timing";
import type { LatencyProfile } from "../transport/latencyProfile";

export type TimingOutcome =
  | "opened"
  | "reserved"
  | "resolved"
  | "expired"
  | "cancelled"
  | "restored"
  | "rejected"
  | "shadow";
export interface TimingDiagnostic {
  matchId: string;
  clockEpoch: string;
  at: number;
  outcome: TimingOutcome;
  windowId?: string;
  seat?: Seat | null;
  kind?: ActionWindowView["kind"];
  opensAt?: number;
  baseEndsAt?: number;
  expiresAt?: number;
  allowanceMs?: number;
  receivedAt?: number;
  connectionGeneration?: number;
  debitMs?: number;
  legacyOpensAt?: number;
  roundTripMs?: number;
  jitterMs?: number;
  samples?: number;
}
export type TimingObserver = (event: Readonly<TimingDiagnostic>) => void;

export class TimingDiagnostics {
  private readonly events: TimingDiagnostic[] = [];

  constructor(
    private readonly matchId: string,
    private readonly clockEpoch: string,
    readonly shadow: boolean = false,
    private readonly observer?: TimingObserver
  ) {}

  record(
    outcome: TimingOutcome,
    at: number,
    window?: ActionWindowView | null,
    extra: Pick<TimingDiagnostic, "debitMs" | "legacyOpensAt"> = {},
    receipt?: InputReceipt,
    profile?: LatencyProfile | null
  ): void {
    const event: TimingDiagnostic = {
      matchId: this.matchId,
      clockEpoch: window?.clockEpoch ?? this.clockEpoch,
      at,
      outcome,
      ...(window
        ? {
            windowId: window.id,
            seat: window.seat,
            kind: window.kind,
            opensAt: window.opensAt,
            baseEndsAt: window.baseEndsAt,
            expiresAt: window.expiresAt,
            allowanceMs: window.allowanceMs,
          }
        : {}),
      ...(receipt
        ? {
            receivedAt: receipt.receivedAt,
            ...(receipt.ownerGeneration === undefined
              ? {}
              : { connectionGeneration: receipt.ownerGeneration }),
          }
        : {}),
      ...(profile
        ? {
            roundTripMs: profile.roundTripMs,
            jitterMs: profile.jitterMs,
            samples: profile.samples,
          }
        : {}),
      ...extra,
    };
    this.events.push(event);
    if (this.events.length > 64) {
      this.events.shift();
    }
    if (this.observer) {
      try {
        this.observer(Object.freeze({ ...event }));
      } catch (error) {
        console.error("[game-timing] diagnostic observer failed", error);
      }
    }
  }

  recent(): ReadonlyArray<Readonly<TimingDiagnostic>> {
    return this.events.map((event) => Object.freeze({ ...event }));
  }
}
