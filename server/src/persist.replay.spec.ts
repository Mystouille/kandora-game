import mongoose from "mongoose";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  updateReplayLog: vi.fn(),
}));

vi.mock("~/core/models/game/ReplayLog", () => ({
  ReplayLogModel: { updateOne: mocks.updateReplayLog },
}));

vi.mock("~/core/models/game/Match", () => ({
  MatchModel: {},
}));

import { archiveReplayLog } from "./persist";

describe("archiveReplayLog seat identity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.updateReplayLog.mockResolvedValue({ acknowledged: true });
  });

  it("persists valid user ids as ObjectIds and omits synthetic ids", async () => {
    const userId = "507f1f77bcf86cd799439011";

    await archiveReplayLog({
      matchId: "match-1",
      startedAt: new Date(100),
      endedAt: new Date(200),
      ruleSet: "m-league",
      events: [],
      seats: [
        {
          seat: 0,
          userDbId: userId,
          displayName: "Alice",
          finalScore: 30_000,
          place: 1,
        },
        {
          seat: 1,
          userDbId: "__relay__:1",
          displayName: "External player",
          finalScore: 25_000,
          place: 2,
        },
      ],
    });

    const update = mocks.updateReplayLog.mock.calls[0][1];
    expect(update.$set.seats[0].userDbId).toBeInstanceOf(
      mongoose.Types.ObjectId
    );
    expect(String(update.$set.seats[0].userDbId)).toBe(userId);
    expect(update.$set.seats[1]).not.toHaveProperty("userDbId");
  });

  it("does not overwrite a completed replay when archiving a live relay", async () => {
    await archiveReplayLog({
      matchId: "relay-1",
      source: "tenhou",
      sourceGameId: "2026081004gm-0009-11017-9b9f92d7",
      sourceGameIdAliases: ["167FAFE2"],
      insertOnly: true,
      startedAt: new Date(100),
      endedAt: new Date(200),
      ruleSet: "tenhou-default",
      events: [],
      seats: [],
    });

    expect(mocks.updateReplayLog).toHaveBeenCalledTimes(2);
    expect(mocks.updateReplayLog.mock.calls[0][1]).toEqual({
      $setOnInsert: expect.objectContaining({
        source: "tenhou",
        sourceGameId: "2026081004gm-0009-11017-9b9f92d7",
        ruleSet: "tenhou-default",
      }),
    });
    expect(mocks.updateReplayLog.mock.calls[0][1]).not.toHaveProperty("$set");
    expect(mocks.updateReplayLog.mock.calls[1]).toEqual([
      {
        source: "tenhou",
        sourceGameId: "2026081004gm-0009-11017-9b9f92d7",
      },
      {
        $addToSet: {
          sourceGameIdAliases: { $each: ["167FAFE2"] },
        },
      },
    ]);
  });
});
