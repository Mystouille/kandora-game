import { z } from "zod";

export const FIVE_MINUTE_SPECTATOR_DELAY_MS = 300_000;

export const SpectatorDelayMsSchema = z.union([
  z.literal(0),
  z.literal(FIVE_MINUTE_SPECTATOR_DELAY_MS),
]);
export type SpectatorDelayMs = z.infer<typeof SpectatorDelayMsSchema>;

export const SpectatorDelayFormValueSchema = z
  .enum(["0", "300000"])
  .transform((value): SpectatorDelayMs =>
    value === "0" ? 0 : FIVE_MINUTE_SPECTATOR_DELAY_MS
  );

export const SPECTATOR_DELAY_OPTIONS = [
  { value: 0, label: "Instant" },
  { value: FIVE_MINUTE_SPECTATOR_DELAY_MS, label: "5 min" },
] as const;

export function spectatorDelayLabel(delayMs: SpectatorDelayMs): string {
  return delayMs === 0 ? "Instant" : "5 min";
}
