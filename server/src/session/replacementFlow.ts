import type { KernelAction, MatchKernel, MatchStateView } from "./matchKernel";
import { settleAutomaticNuki } from "./nukiFlow";

export async function settleAutomaticReplacements(
  kernel: MatchKernel,
  apply: (action: KernelAction) => Promise<MatchStateView>,
  opening = false
): Promise<void> {
  await settleAutomaticNuki(kernel, apply, opening);
  while (kernel.currentState().phase === "awaiting_flower_replacement") {
    await apply({ type: "complete_flower" });
  }
}
