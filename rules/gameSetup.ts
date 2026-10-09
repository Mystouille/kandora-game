import { z } from "zod";
import { GameVariantSchema } from "../protocol/seat";
import { RulesFamilySchema } from "../protocol/rulesFamily";
import { MatchModeConfigSchema, normalMatchMode } from "../protocol/matchMode";
import { SpectatorDelayMsSchema } from "../protocol/spectatorDelay";
import { getPreset, listPresetIds, presetToRuleSet } from "./presets";
import { resolveRuleSet, type RuleSet } from "./ruleSet";

export const GameSetupSchema = z
  .object({
    preset: z
      .string()
      .refine((id) => listPresetIds().includes(id), "Unknown rule preset"),
    ...GameVariantSchema.shape,
    rulesFamily: RulesFamilySchema.default("riichi"),
    mode: MatchModeConfigSchema.default(() => normalMatchMode),
    spectatorDelayMs: SpectatorDelayMsSchema.default(0),
  })
  .strict()
  .superRefine((setup, context) => {
    if (
      setup.rulesFamily === "mcr" &&
      (setup.playerCount !== 4 || setup.preset !== "mcr-ema")
    ) {
      context.addIssue({
        code: "custom",
        path: ["preset"],
        message: "MCR requires the fixed EMA MCR preset and four players",
      });
    }
    if (setup.rulesFamily === "riichi" && setup.preset === "mcr-ema") {
      context.addIssue({
        code: "custom",
        path: ["preset"],
        message: "The EMA MCR preset requires MCR rules",
      });
    }
    if (setup.playerCount === 3 && setup.preset !== "m-league") {
      context.addIssue({
        code: "custom",
        path: ["preset"],
        message: "Sanma requires the M-League base preset and cannot use Buu",
      });
    }
  });

export type GameSetup = z.infer<typeof GameSetupSchema>;

export function gameSetupRules(setup: GameSetup): RuleSet {
  const validated = GameSetupSchema.parse(setup);
  if (validated.rulesFamily === "mcr") {
    return presetToRuleSet(getPreset("mcr-ema"));
  }
  if (validated.playerCount === 3) {
    return resolveRuleSet({
      playerCount: 3,
      sanmaType: validated.sanmaType,
    });
  }
  return presetToRuleSet(getPreset(validated.preset));
}
