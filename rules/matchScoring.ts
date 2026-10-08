import { z } from "zod";
import type { RuleSet } from "./ruleSet";

const UmaSchema = z
  .tuple([z.number(), z.number(), z.number(), z.number()])
  .refine(
    (row) => Math.abs(row.reduce((sum, value) => sum + value, 0)) < 1e-9,
    "UMA placement bonuses must sum to zero"
  );

export const UmaTableSchema = z.array(UmaSchema).length(5);
export type Uma = z.infer<typeof UmaSchema>;

export function zeroUma(): Uma[] {
  return Array.from({ length: 5 }, () => [0, 0, 0, 0]);
}

/** Input order is seat order; fewer than four entries also support legacy listings. */
export function calculateMatchPoints(
  scores: readonly number[],
  rules: Pick<
    RuleSet,
    | "startingScore"
    | "returnScore"
    | "uma"
    | "roundFinalScores"
    | "splitTiedUma"
  > &
    Partial<Pick<RuleSet, "playerCount">>
): number[] {
  if (rules.playerCount === 3) {
    throw new Error(
      "Sanma uses raw match scores; tournament UMA settlement is not supported"
    );
  }
  if (scores.length > 4 || scores.some((score) => !Number.isFinite(score))) {
    throw new Error("Match scoring requires at most four finite table scores");
  }
  const table = UmaTableSchema.parse(rules.uma);
  const below = scores.filter((score) => score < rules.returnScore).length;
  const uma = table[below];
  const oka = (4 * (rules.returnScore - rules.startingScore)) / 1000;
  const ordered = scores
    .map((score, seat) => ({ score, seat }))
    .sort((a, b) => b.score - a.score || a.seat - b.seat);
  const points = new Array<number>(scores.length);
  let index = 0;
  while (index < ordered.length) {
    let end = index + 1;
    if (rules.splitTiedUma) {
      while (
        end < ordered.length &&
        ordered[end].score === ordered[index].score
      ) {
        end++;
      }
    }
    let bonus = 0;
    for (let place = index; place < end; place++) {
      bonus += uma[place] + (place === 0 ? oka : 0);
    }
    bonus /= end - index;
    for (let place = index; place < end; place++) {
      const value = (ordered[place].score - rules.returnScore) / 1000 + bonus;
      const rounded = rules.roundFinalScores
        ? Math.sign(value) * Math.round(Math.abs(value))
        : Number(value.toFixed(1));
      points[ordered[place].seat] = rounded === 0 ? 0 : rounded;
    }
    index = end;
  }
  return points;
}
