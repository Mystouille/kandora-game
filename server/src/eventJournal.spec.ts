import { describe, expect, it, vi } from "vitest";
import type { GameEvent } from "~/game/protocol/messages";
import { MatchEventJournal, type EventJournalTimer } from "./eventJournal";
import type {
  MatchEventJournalStore,
  PersistedMatchEvent,
} from "./repository";

function deferred(): {
  promise: Promise<void>;
  resolve(): void;
  reject(error: unknown): void;
} {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function event(seq: number): PersistedMatchEvent {
  return {
    seq,
    emittedAt: 1_000 + seq,
    event: { type: "furiten", seat: 0, active: seq % 2 === 0 },
  };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("MatchEventJournal", () => {
  it("batches contiguous events and permits only one write in flight", async () => {
    const events = [event(0), event(1), event(2), event(3), event(4)];
    const first = deferred();
    const second = deferred();
    const writes: PersistedMatchEvent[][] = [];
    const store: MatchEventJournalStore = {
      appendMatchEvents: vi.fn(async ({ events: batch }) => {
        writes.push(batch);
        await (writes.length === 1 ? first.promise : second.promise);
      }),
      loadMatchEventJournalState: async () => null,
    };
    const journal = new MatchEventJournal({
      matchId: "batched",
      initialNextSeq: 0,
      store,
      readEvents: (fromSeq, toSeq) => events.slice(fromSeq, toSeq),
    });

    journal.record(0);
    journal.record(1);
    journal.record(2);
    await settle();
    expect(writes.map((batch) => batch.map((entry) => entry.seq))).toEqual([
      [0, 1, 2],
    ]);

    journal.record(3);
    journal.record(4);
    await settle();
    expect(writes).toHaveLength(1);

    first.resolve();
    await settle();
    expect(writes.map((batch) => batch.map((entry) => entry.seq))).toEqual([
      [0, 1, 2],
      [3, 4],
    ]);
    second.resolve();
    await journal.flush();
    expect(journal.durableThroughSeq).toBe(5);
    expect(journal.lag).toBe(0);
  });

  it("retains a failed suffix and retries without rejecting record", async () => {
    const events = [event(0)];
    const scheduled: Array<{ callback: () => void; delayMs: number }> = [];
    const failure = new Error("storage unavailable");
    let attempts = 0;
    const store: MatchEventJournalStore = {
      appendMatchEvents: async () => {
        attempts += 1;
        if (attempts === 1) {
          throw failure;
        }
      },
      loadMatchEventJournalState: async () => null,
    };
    const errors = vi.fn();
    const journal = new MatchEventJournal({
      matchId: "retry",
      initialNextSeq: 0,
      store,
      readEvents: (fromSeq, toSeq) => events.slice(fromSeq, toSeq),
      scheduleRetry: (callback, delayMs): EventJournalTimer => {
        scheduled.push({ callback, delayMs });
        return { cancel: () => undefined };
      },
      onError: errors,
    });

    expect(() => journal.record(0)).not.toThrow();
    await settle();
    expect(journal.lag).toBe(1);
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].delayMs).toBe(250);
    expect(errors).toHaveBeenCalledWith(
      expect.objectContaining({ error: failure, retryAttempt: 1 })
    );

    scheduled[0].callback();
    await settle();
    await journal.flush();
    expect(attempts).toBe(2);
    expect(journal.lag).toBe(0);
  });

  it("surfaces an active write failure to an explicit flush", async () => {
    const failure = new Error("cannot flush");
    const store: MatchEventJournalStore = {
      appendMatchEvents: async () => {
        throw failure;
      },
      loadMatchEventJournalState: async () => null,
    };
    const journal = new MatchEventJournal({
      matchId: "flush-failure",
      initialNextSeq: 0,
      store,
      readEvents: () => [event(0)],
      scheduleRetry: () => ({ cancel: () => undefined }),
    });

    journal.record(0);
    await expect(journal.flush()).rejects.toBe(failure);
    expect(journal.lag).toBe(1);
  });

  it("waits for an active write and cancels its unstarted suffix", async () => {
    const events = [event(0), event(1)];
    const active = deferred();
    const writes: number[][] = [];
    const store: MatchEventJournalStore = {
      appendMatchEvents: async ({ events: batch }) => {
        writes.push(batch.map((entry) => entry.seq));
        await active.promise;
      },
      loadMatchEventJournalState: async () => null,
    };
    const journal = new MatchEventJournal({
      matchId: "supersede",
      initialNextSeq: 0,
      store,
      readEvents: (fromSeq, toSeq) => events.slice(fromSeq, toSeq),
      batchSize: 1,
    });

    journal.record(0);
    await settle();
    journal.record(1);
    let superseded = false;
    const superseding = journal.supersede().then(() => {
      superseded = true;
    });
    await settle();
    expect(superseded).toBe(false);
    expect(writes).toEqual([[0]]);

    active.resolve();
    await superseding;
    expect(writes).toEqual([[0]]);
    expect(() => journal.record(1)).toThrow(/sealed/);
  });
});