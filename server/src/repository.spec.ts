import { describe, expect, it } from "vitest";
import { MatchProcess } from "./match";
import { createMemoryMatchRepository } from "./repository";

describe("memory match checkpoint repository", () => {
    it("appends contiguous event batches idempotently and fences a final archive", async () => {
      const repository = createMemoryMatchRepository();
      await repository.createMatch({
        matchId: "journal-repository",
        seed: 1,
        ruleSet: "tenhou-hanchan",
        players: [],
        initialEventSeq: 5,
      });
      const events = [5, 6, 7, 8, 9].map((seq) => ({
        seq,
        emittedAt: 1_000 + seq,
        event: {
          type: "furiten" as const,
          seat: 0 as const,
          active: seq % 2 === 0,
        },
      }));

      await repository.appendMatchEvents({
        matchId: "journal-repository",
        events: events.slice(0, 2),
      });
      await repository.appendMatchEvents({
        matchId: "journal-repository",
        events: events.slice(0, 2),
      });
      expect(
        await repository.loadMatchEventJournalState("journal-repository")
      ).toEqual({ status: "playing", nextSeq: 7 });
      await expect(
        repository.appendMatchEvents({
          matchId: "journal-repository",
          events: events.slice(3, 4),
        })
      ).rejects.toThrow(/expected event seq 7, got 8/);

      await repository.archiveMatch({
        matchId: "journal-repository",
        events: events.slice(0, 4),
        finalScores: [],
      });
      await repository.appendMatchEvents({
        matchId: "journal-repository",
        events: events.slice(4),
      });
      expect(repository.inspectMatchEventJournal("journal-repository")).toEqual({
        status: "finished",
        nextSeq: 9,
        events: events.slice(0, 4),
      });
    });

  it("atomically records and commits a pending action", async () => {
    const repository = createMemoryMatchRepository();
    const match = new MatchProcess(
      "command-repository",
      3,
      [
        { userId: "alice", displayName: "Alice", isBot: false },
        { userId: "bot-1", displayName: "Bot 1", isBot: true },
        { userId: "bot-2", displayName: "Bot 2", isBot: true },
        { userId: "bot-3", displayName: "Bot 3", isBot: true },
      ],
      { repository }
    );
    await match.start();
    const checkpoint = match.createCheckpoint();
    if (
      checkpoint.status !== "playing" ||
      checkpoint.checkpointKind !== "action_window"
    ) {
      throw new Error("expected an action checkpoint");
    }
    const action = checkpoint.actionWindow.legalActions[0];

    await repository.saveCommandTransaction({
      matchId: match.matchId,
      checkpoint,
      command: {
        type: "act",
        seat: checkpoint.actionWindow.seat,
        actionId: action.id,
      },
    });

    expect(await repository.loadRecoveryRecord(match.matchId)).toEqual({
      checkpoint,
      pendingCommand: {
        type: "act",
        seat: checkpoint.actionWindow.seat,
        actionId: action.id,
      },
    });

    await repository.saveCheckpoint({ matchId: match.matchId, checkpoint });
    expect(await repository.loadRecoveryRecord(match.matchId)).toEqual({
      checkpoint,
      pendingCommand: null,
    });

    await expect(
      repository.saveCommandTransaction({
        matchId: match.matchId,
        checkpoint,
        command: {
          type: "act",
          seat: checkpoint.actionWindow.seat,
          actionId: "not-legal-in-this-window",
        },
      })
    ).rejects.toThrow(/must be legal in its checkpoint window/);

    await expect(
      repository.saveCommandTransaction({
        matchId: match.matchId,
        checkpoint,
        command: {
          type: "afk",
          seat: checkpoint.actionWindow.seat,
          afk: true,
          defaultActionId: "not-the-safe-default",
        },
      })
    ).rejects.toThrow(/wrong safe default action/);
  });

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
