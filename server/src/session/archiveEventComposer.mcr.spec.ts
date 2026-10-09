import { describe, expect, it, vi } from "vitest";
import type { MatchStateView } from "./matchKernel";
import { ArchiveEventComposer } from "./archiveEventComposer";

describe("ArchiveEventComposer MCR wins", () => {
  it("does not run draw-ready wait analysis on a complete winning hand", () => {
    const handWaits = vi.fn(() => {
      throw new Error("wait analysis must not run for a win");
    });
    const composer = new ArchiveEventComposer({
      state: () => ({}) as MatchStateView,
      kernel: {
        drawQueuesForArchive: () => null,
        handWaits,
      },
    });
    const event = {
      type: "hand_end" as const,
      reason: "tsumo" as const,
      delta: [288, -96, -96, -96],
    };

    expect(composer.enrichForArchive(event)).toEqual(event);
    expect(handWaits).not.toHaveBeenCalled();
  });
});
