import { describe, expect, it } from "vitest";
import { MatchProcess } from "./match";
import { createMemoryMatchRepository } from "./repository";

describe("memory match checkpoint repository", () => {
  it("tombstones a checkpoint and blocks stale resurrection", async () => {
    const repository = createMemoryMatchRepository();
    const room = MatchProcess.createWaitingRoom(
      "terminal-repository",
      1,
      { repository }
    );
    room.claimSeat("alice", "Alice");
    const checkpoint = room.createCheckpoint();
    await repository.saveCheckpoint({
      matchId: room.matchId,
      checkpoint,
    });
    expect(await repository.loadCheckpoint(room.matchId)).toEqual(checkpoint);

    await repository.markCheckpointTerminal({
      matchId: room.matchId,
      finishedAt: 123_456,
    });

    expect(await repository.loadCheckpoint(room.matchId)).toBeNull();
    await expect(
      repository.saveCheckpoint({ matchId: room.matchId, checkpoint })
    ).rejects.toThrow(/terminal match/);

    await repository.deleteCheckpoint(room.matchId);
    await expect(
      repository.saveCheckpoint({ matchId: room.matchId, checkpoint })
    ).resolves.toBeUndefined();
  });

  it("does not create a tombstone when no checkpoint exists", async () => {
    const repository = createMemoryMatchRepository();
    const room = MatchProcess.createWaitingRoom(
      "terminal-without-checkpoint",
      2,
      { repository }
    );
    const checkpoint = room.createCheckpoint();

    await repository.markCheckpointTerminal({
      matchId: room.matchId,
      finishedAt: 654_321,
    });

    await expect(
      repository.saveCheckpoint({ matchId: room.matchId, checkpoint })
    ).resolves.toBeUndefined();
  });
});