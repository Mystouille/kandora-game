import { z } from "zod";

export const ActiveMatchSummarySchema = z
  .object({
    matchId: z.string().min(1),
    status: z.literal("playing"),
    connected: z.boolean(),
  })
  .strict();

export const ActiveMatchResponseSchema = z
  .object({
    activeMatch: ActiveMatchSummarySchema.nullable(),
  })
  .strict();

export type ActiveMatchSummary = z.infer<typeof ActiveMatchSummarySchema>;
export type ActiveMatchResponse = z.infer<typeof ActiveMatchResponseSchema>;
