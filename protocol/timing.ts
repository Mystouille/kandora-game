import { z } from "zod";
import { SeatSchema } from "./seat";

export const TIMING_CAPABILITY = "clock-window-v2" as const;
export const TIMING_VERSION = 2 as const;
export const MAX_LATENCY_ALLOWANCE_MS = 500;
export const FALLBACK_LATENCY_ALLOWANCE_MS = 200;

const TimestampSchema = z.number().int().nonnegative();
export const TimingModeSchema = z.enum(["legacy", "windows-v2"]);
export type TimingMode = z.infer<typeof TimingModeSchema>;

export const ClockStampSchema = z.object({
  clockEpoch: z.string().min(1).max(128),
  serverNow: TimestampSchema,
});
export type ClockStamp = z.infer<typeof ClockStampSchema>;

export const ClockProbeSchema = z.object({
  type: z.literal("clock_probe"),
  matchId: z.string(),
  probeId: z.string().min(1).max(128),
});
export type ClockProbe = z.infer<typeof ClockProbeSchema>;

export const LatencyProbeSchema = z.object({
  type: z.literal("latency_probe"),
  probeId: z.string().min(1).max(128),
});

export const LatencyReplySchema = z.object({
  type: z.literal("latency_reply"),
  matchId: z.string(),
  probeId: z.string().min(1).max(128),
});

export const ClockSampleSchema = z
  .object({
    type: z.literal("clock_sample"),
    probeId: z.string().min(1).max(128),
    clockEpoch: z.string().min(1).max(128),
    serverReceivedAt: TimestampSchema,
    serverSentAt: TimestampSchema,
  })
  .refine((sample) => sample.serverSentAt >= sample.serverReceivedAt, {
    message: "Clock sample timestamps are reversed",
  });
export type ClockSample = z.infer<typeof ClockSampleSchema>;

export const ActionWindowKindSchema = z.enum([
  "turn",
  "call",
  "ryuukyoku_declaration",
  "ready",
  "session_vote",
]);
export type ActionWindowKind = z.infer<typeof ActionWindowKindSchema>;

export const ActionWindowViewSchema = z
  .object({
    id: z.string().min(1).max(256),
    clockEpoch: z.string().min(1).max(128),
    timingVersion: z.literal(TIMING_VERSION),
    seat: SeatSchema.nullable(),
    kind: ActionWindowKindSchema,
    state: z.enum(["scheduled", "open", "resolved", "expired", "cancelled"]),
    infoSentAt: TimestampSchema,
    opensAt: TimestampSchema,
    baseEndsAt: TimestampSchema,
    budgetEndsAt: TimestampSchema,
    expiresAt: TimestampSchema,
    bankAtOpenMs: z.number().int().nonnegative(),
    allowanceMs: z.number().int().min(0).max(MAX_LATENCY_ALLOWANCE_MS),
    generation: z.number().int().nonnegative(),
    legalActionIds: z.array(z.string()),
  })
  .superRefine((window, context) => {
    if (
      window.infoSentAt > window.opensAt ||
      window.opensAt > window.baseEndsAt ||
      window.baseEndsAt + window.bankAtOpenMs !== window.budgetEndsAt ||
      window.budgetEndsAt + window.allowanceMs !== window.expiresAt
    ) {
      context.addIssue({
        code: "custom",
        message: "Inconsistent decision-window times or budget",
      });
    }
  });
export type ActionWindowView = z.infer<typeof ActionWindowViewSchema>;

export const PresentationEventSchema = z
  .object({
    seq: z.number().int().nonnegative(),
    kind: z.enum(["draw", "discard", "call", "hand_start", "hand_end", "win"]),
    occurredAt: TimestampSchema,
    startsAt: TimestampSchema,
    readyAt: TimestampSchema,
  })
  .refine(
    (event) =>
      event.occurredAt <= event.startsAt && event.startsAt <= event.readyAt,
    { message: "Inconsistent presentation times" }
  );
export type PresentationEvent = z.infer<typeof PresentationEventSchema>;

export const PresentationContextSchema = z.object({
  offsetMs: z.number().int().nonnegative(),
  source: z.enum(["player", "native-spectator", "external-relay", "local"]),
  events: z.array(PresentationEventSchema),
});
export type PresentationContext = z.infer<typeof PresentationContextSchema>;

export interface ActionIntentContext {
  windowId: string;
  clockEpoch: string;
  stateSeq: number;
}

export interface InputReceipt {
  receivedAt: number;
  windowId?: string;
  clockEpoch?: string;
  stateSeq?: number;
  clientSessionId?: string;
}
