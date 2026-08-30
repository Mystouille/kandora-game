import type {
  MatchEventJournalStore,
  PersistedMatchEvent,
} from "./repository";

const DEFAULT_BATCH_SIZE = 64;
const DEFAULT_RETRY_BASE_MS = 250;
const DEFAULT_RETRY_MAX_MS = 5_000;

export interface EventJournalTimer {
  cancel(): void;
}

export interface EventJournalErrorContext {
  matchId: string;
  durableNextSeq: number;
  targetNextSeq: number;
  retryAttempt: number;
  error: unknown;
}

export interface MatchEventJournalOptions {
  matchId: string;
  initialNextSeq: number;
  store: MatchEventJournalStore;
  readEvents: (fromSeq: number, toSeq: number) => PersistedMatchEvent[];
  batchSize?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  scheduleRetry?: (callback: () => void, delayMs: number) => EventJournalTimer;
  onError?: (context: EventJournalErrorContext) => void;
}

interface FlushWaiter {
  targetNextSeq: number;
  resolve(): void;
  reject(error: unknown): void;
}

function defaultScheduleRetry(
  callback: () => void,
  delayMs: number
): EventJournalTimer {
  const handle = globalThis.setTimeout(callback, delayMs);
  (handle as unknown as { unref?: () => void }).unref?.();
  return {
    cancel: () => globalThis.clearTimeout(handle),
  };
}

/**
 * Serializes best-effort event journal writes without putting storage latency
 * on the game loop. The queue owns only sequence cursors; the MatchProcess
 * event log remains the single in-memory owner of unsaved event payloads.
 */
export class MatchEventJournal {
  private readonly matchId: string;
  private readonly store: MatchEventJournalStore;
  private readonly readEvents: MatchEventJournalOptions["readEvents"];
  private readonly batchSize: number;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;
  private readonly scheduleRetry: NonNullable<
    MatchEventJournalOptions["scheduleRetry"]
  >;
  private readonly onError: NonNullable<MatchEventJournalOptions["onError"]>;
  private readonly flushWaiters = new Set<FlushWaiter>();
  private durableNextSeq: number;
  private targetNextSeq: number;
  private retryAttempt = 0;
  private retryTimer: EventJournalTimer | null = null;
  private writeInFlight: Promise<void> | null = null;
  private drainScheduled = false;
  private state: "open" | "superseding" | "closed" = "open";

  constructor(options: MatchEventJournalOptions) {
    if (!Number.isInteger(options.initialNextSeq) || options.initialNextSeq < 0) {
      throw new Error("MatchEventJournal initialNextSeq must be nonnegative");
    }
    this.matchId = options.matchId;
    this.store = options.store;
    this.readEvents = options.readEvents;
    this.batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    this.retryBaseMs = options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;
    this.retryMaxMs = options.retryMaxMs ?? DEFAULT_RETRY_MAX_MS;
    this.scheduleRetry = options.scheduleRetry ?? defaultScheduleRetry;
    this.onError = options.onError ?? (() => undefined);
    this.durableNextSeq = options.initialNextSeq;
    this.targetNextSeq = options.initialNextSeq;

    if (!Number.isInteger(this.batchSize) || this.batchSize < 1) {
      throw new Error("MatchEventJournal batchSize must be positive");
    }
    if (this.retryBaseMs < 0 || this.retryMaxMs < this.retryBaseMs) {
      throw new Error("MatchEventJournal retry delays are invalid");
    }
  }

  get durableThroughSeq(): number {
    return this.durableNextSeq;
  }

  get targetThroughSeq(): number {
    return this.targetNextSeq;
  }

  get lag(): number {
    return this.targetNextSeq - this.durableNextSeq;
  }

  record(seq: number): void {
    if (this.state !== "open") {
      throw new Error(`MatchEventJournal ${this.matchId} is sealed`);
    }
    if (seq !== this.targetNextSeq) {
      throw new Error(
        `MatchEventJournal ${this.matchId} expected seq ${this.targetNextSeq}, got ${seq}`
      );
    }
    this.targetNextSeq = seq + 1;
    this.scheduleDrain();
  }

  flush(): Promise<void> {
    if (this.state !== "open") {
      return Promise.reject(
        new Error(`MatchEventJournal ${this.matchId} is sealed`)
      );
    }
    const targetNextSeq = this.targetNextSeq;
    if (this.durableNextSeq >= targetNextSeq) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      this.flushWaiters.add({ targetNextSeq, resolve, reject });
      this.cancelRetry();
      this.startNextWrite();
    });
  }

  async supersede(): Promise<void> {
    if (this.state === "closed") {
      return;
    }
    this.state = "superseding";
    this.cancelRetry();
    this.rejectFlushWaiters(
      new Error(`MatchEventJournal ${this.matchId} was superseded`)
    );
    const activeWrite = this.writeInFlight;
    if (activeWrite !== null) {
      try {
        await activeWrite;
      } catch {
        // The complete archive that follows supersedes this partial batch.
      }
    }
    this.targetNextSeq = this.durableNextSeq;
    this.state = "closed";
  }

  private scheduleDrain(): void {
    if (
      this.state !== "open" ||
      this.drainScheduled ||
      this.writeInFlight !== null ||
      this.retryTimer !== null
    ) {
      return;
    }
    this.drainScheduled = true;
    queueMicrotask(() => {
      this.drainScheduled = false;
      this.startNextWrite();
    });
  }

  private startNextWrite(): void {
    if (
      this.state !== "open" ||
      this.writeInFlight !== null ||
      this.durableNextSeq >= this.targetNextSeq
    ) {
      return;
    }
    const fromSeq = this.durableNextSeq;
    const toSeq = Math.min(this.targetNextSeq, fromSeq + this.batchSize);
    let events: PersistedMatchEvent[];
    try {
      events = this.readEvents(fromSeq, toSeq);
      this.assertContiguous(events, fromSeq, toSeq);
    } catch (error) {
      this.handleWriteFailure(error);
      return;
    }

    let storageWrite: Promise<void>;
    try {
      storageWrite = this.store.appendMatchEvents({
        matchId: this.matchId,
        events,
      });
    } catch (error) {
      this.handleWriteFailure(error);
      return;
    }

    const trackedWrite = storageWrite.then(
      () => {
        this.durableNextSeq = toSeq;
        this.retryAttempt = 0;
        this.resolveFlushWaiters();
      },
      (error: unknown) => {
        this.handleWriteFailure(error);
      }
    );
    this.writeInFlight = trackedWrite;
    void trackedWrite.then(() => {
      if (this.writeInFlight === trackedWrite) {
        this.writeInFlight = null;
      }
      if (this.state === "open" && this.retryTimer === null) {
        this.startNextWrite();
      }
    });
  }

  private assertContiguous(
    events: PersistedMatchEvent[],
    fromSeq: number,
    toSeq: number
  ): void {
    if (events.length !== toSeq - fromSeq) {
      throw new Error(
        `MatchEventJournal ${this.matchId} source returned ${events.length} events for [${fromSeq}, ${toSeq})`
      );
    }
    for (let index = 0; index < events.length; index += 1) {
      if (events[index].seq !== fromSeq + index) {
        throw new Error(
          `MatchEventJournal ${this.matchId} source is not contiguous at seq ${fromSeq + index}`
        );
      }
    }
  }

  private handleWriteFailure(error: unknown): void {
    this.retryAttempt += 1;
    this.onError({
      matchId: this.matchId,
      durableNextSeq: this.durableNextSeq,
      targetNextSeq: this.targetNextSeq,
      retryAttempt: this.retryAttempt,
      error,
    });
    this.rejectFlushWaiters(error);
    if (this.state !== "open" || this.retryTimer !== null) {
      return;
    }
    const delayMs = Math.min(
      this.retryMaxMs,
      this.retryBaseMs * 2 ** Math.max(0, this.retryAttempt - 1)
    );
    this.retryTimer = this.scheduleRetry(() => {
      this.retryTimer = null;
      this.startNextWrite();
    }, delayMs);
  }

  private resolveFlushWaiters(): void {
    for (const waiter of this.flushWaiters) {
      if (this.durableNextSeq >= waiter.targetNextSeq) {
        this.flushWaiters.delete(waiter);
        waiter.resolve();
      }
    }
  }

  private rejectFlushWaiters(error: unknown): void {
    for (const waiter of this.flushWaiters) {
      this.flushWaiters.delete(waiter);
      waiter.reject(error);
    }
  }

  private cancelRetry(): void {
    this.retryTimer?.cancel();
    this.retryTimer = null;
  }
}