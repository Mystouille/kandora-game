import { z } from "zod";
import { mapSeatValues } from "../rules/seats";

export const SeatSchema = z.union([
  z.literal(0),
  z.literal(1),
  z.literal(2),
  z.literal(3),
]);
export type Seat = z.infer<typeof SeatSchema>;

export const PlayerCountSchema = z.union([z.literal(3), z.literal(4)]);
export type PlayerCount = z.infer<typeof PlayerCountSchema>;

export const SanmaTypeSchema = z.enum(["online", "kansai"]);
export type SanmaType = z.infer<typeof SanmaTypeSchema>;

export const GameVariantSchema = z
  .object({
    playerCount: PlayerCountSchema.default(4),
    sanmaType: SanmaTypeSchema.default("online"),
  })
  .strict();
export type GameVariant = z.infer<typeof GameVariantSchema>;

export const GameVariantMetadata = {
  playerCount: PlayerCountSchema.optional(),
  sanmaType: SanmaTypeSchema.optional(),
};

export type SeatValues<T> = T[] & { length: PlayerCount };
export type ReadonlySeatValues<T> = readonly T[] & {
  readonly length: PlayerCount;
};

export function seatValuesSchema<T extends z.ZodType>(
  item: T
): z.ZodType<SeatValues<z.output<T>>> {
  return z
    .array(item)
    .min(3)
    .max(4)
    .transform((values) => mapSeatValues(values, (value) => value));
}
