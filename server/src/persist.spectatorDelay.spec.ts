import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  updateMatch: vi.fn(),
}));

vi.mock("~/core/models/game/Match", () => ({
  MatchModel: { updateOne: mocks.updateMatch },
}));

import { createMatchDoc } from "./persist";

describe("persisted spectator delay", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.updateMatch.mockResolvedValue({ acknowledged: true });
  });

  it.each([0, 300_000] as const)(
    "stores the %i ms setting in the match document",
    async (spectatorDelayMs) => {
      await createMatchDoc({
        matchId: "delayed-match",
        seed: 42,
        ruleSet: "m-league",
        spectatorDelayMs,
        players: [],
        initialEventSeq: 0,
      });

      expect(mocks.updateMatch).toHaveBeenCalledWith(
        { _id: "delayed-match" },
        {
          $setOnInsert: expect.objectContaining({ spectatorDelayMs }),
        },
        { upsert: true }
      );
    }
  );

  it("preserves instant spectating for callers without the new setting", async () => {
    await createMatchDoc({
      matchId: "legacy-match",
      seed: 42,
      ruleSet: "m-league",
      players: [],
      initialEventSeq: 0,
    });

    expect(
      mocks.updateMatch.mock.calls[0][1].$setOnInsert.spectatorDelayMs
    ).toBe(0);
  });
});
