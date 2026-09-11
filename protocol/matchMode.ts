import { z } from "zod";

export const DUPLICATE_GENERATION_VERSION = 1 as const;
export const MAX_DUPLICATE_SEED_LENGTH = 128;

export const NormalMatchModeConfigSchema = z
  .object({
    type: z.literal("normal"),
  })
  .strict();

export const DuplicateMatchModeConfigSchema = z
  .object({
    type: z.literal("duplicate"),
    seed: z.string().trim().min(1).max(MAX_DUPLICATE_SEED_LENGTH),
    generationVersion: z.literal(DUPLICATE_GENERATION_VERSION),
  })
  .strict();

export const MatchModeConfigSchema = z.discriminatedUnion("type", [
  NormalMatchModeConfigSchema,
  DuplicateMatchModeConfigSchema,
]);

export type NormalMatchModeConfig = z.infer<
  typeof NormalMatchModeConfigSchema
>;
export type DuplicateMatchModeConfig = z.infer<
  typeof DuplicateMatchModeConfigSchema
>;
export type MatchModeConfig = z.infer<typeof MatchModeConfigSchema>;

export const normalMatchMode: NormalMatchModeConfig = { type: "normal" };