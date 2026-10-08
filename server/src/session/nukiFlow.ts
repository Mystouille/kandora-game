import type { KernelAction, MatchKernel, MatchStateView } from "./matchKernel";

export async function settleAutomaticNuki(
  kernel: MatchKernel,
  apply: (action: KernelAction) => Promise<MatchStateView>,
  opening = false
): Promise<void> {
  const nextAction = (): KernelAction | null =>
    kernel.currentState().phase === "awaiting_nuki_replacement"
      ? { type: "complete_nuki" }
      : kernel.automaticNuki(opening);
  for (let action = nextAction(); action !== null; action = nextAction()) {
    await apply(action);
  }
}
