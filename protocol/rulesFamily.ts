import { z } from "zod";

export const MCR_CAPABILITY = "mcr-v1" as const;

export const RulesFamilySchema = z.enum(["riichi", "mcr"]);

export type RulesFamily = z.infer<typeof RulesFamilySchema>;

export const RulesFamilyMetadata = {
  rulesFamily: RulesFamilySchema.optional(),
};

export function resolvedRulesFamily(
  value: RulesFamily | undefined
): RulesFamily {
  return value ?? "riichi";
}
