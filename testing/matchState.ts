import { MatchStateSchema, type MatchState } from "~/game/rules/state";
import type { MatchProcess } from "~/game/server/src/match";

/** Plant a fixture through the kernel restore boundary, not a private facade alias. */
export function editMatchState(
  match: MatchProcess,
  edit: (state: MatchState) => void
): void {
  const kernel = match.owners.kernel;
  const state = MatchStateSchema.parse(kernel.view);
  edit(state);
  kernel.restore(state, kernel.driverSnapshot());
}
