import { z } from "zod";
import { SanmaTypeSchema } from "./seat";

export const SANMA_CAPABILITY = "sanma-v1" as const;

export const SanmaWallStateSchema = z
  .object({
    sanmaType: SanmaTypeSchema,
    mode: z.enum(["standard", "duplicate"]),
    replacementsTaken: z.number().int().min(0).max(8),
    kanCount: z.number().int().min(0).max(4),
  })
  .strict()
  .refine(
    (wall) =>
      wall.replacementsTaken >= wall.kanCount &&
      wall.replacementsTaken - wall.kanCount <= 4,
    "Replacement counts must represent at most four kans and four nuki"
  );
