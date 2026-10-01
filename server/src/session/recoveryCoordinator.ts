import type { MatchCheckpoint } from "../checkpoint";
import type { MatchRepository } from "../repository";
import type { CommandCoordinator } from "./commandCoordinator";

export interface RecoveryPort {
  readonly matchId: string;
  readonly commands: Pick<
    CommandCoordinator,
    "transaction" | "watchBoundary" | "clearBoundary"
  >;
  readonly repository: Pick<MatchRepository, "saveCheckpoint">;
  capture(): MatchCheckpoint;
  cancelTimers(checkpoint: MatchCheckpoint): void;
  resume(checkpoint: MatchCheckpoint): void;
  flushJournal(): Promise<void> | null;
}

export class RecoveryCoordinator {
  private pausedCheckpoint: MatchCheckpoint | null = null;
  private savePromise: Promise<MatchCheckpoint> | null = null;

  constructor(private readonly port: RecoveryPort) {}

  get paused(): MatchCheckpoint | null {
    return this.pausedCheckpoint;
  }

  get saving(): Promise<MatchCheckpoint> | null {
    return this.savePromise;
  }

  clearPause(): void {
    this.pausedCheckpoint = null;
  }

  freeze(checkpoint: MatchCheckpoint): void {
    this.pausedCheckpoint = checkpoint;
    this.port.cancelTimers(checkpoint);
  }

  pause(): Promise<MatchCheckpoint> {
    if (this.savePromise !== null) {
      return this.savePromise;
    }
    if (this.pausedCheckpoint !== null) {
      return Promise.resolve(this.port.capture());
    }
    const active = this.port.commands.transaction;
    if (active === null) {
      const checkpoint = this.port.capture();
      this.freeze(checkpoint);
      const saving = this.persistAndClear(checkpoint);
      this.savePromise = saving;
      return saving;
    }
    const saving = this.pauseAfterCommand(active);
    this.savePromise = saving;
    return saving;
  }

  private async pauseAfterCommand(
    active: Promise<void>
  ): Promise<MatchCheckpoint> {
    try {
      const boundary = this.port.commands.watchBoundary();
      try {
        await Promise.race([active, boundary]);
      } finally {
        this.port.commands.clearBoundary(boundary);
      }
      const checkpoint = this.port.capture();
      this.freeze(checkpoint);
      return await this.persist(checkpoint);
    } finally {
      this.savePromise = null;
    }
  }

  private async persistAndClear(
    checkpoint: MatchCheckpoint
  ): Promise<MatchCheckpoint> {
    try {
      return await this.persist(checkpoint);
    } finally {
      this.savePromise = null;
    }
  }

  private async persist(checkpoint: MatchCheckpoint): Promise<MatchCheckpoint> {
    try {
      const flushing = this.port.flushJournal();
      if (flushing !== null) {
        await flushing;
      }
      await this.port.repository.saveCheckpoint({
        matchId: this.port.matchId,
        checkpoint,
      });
      return this.port.capture();
    } catch (error) {
      this.port.resume(checkpoint);
      throw error;
    }
  }
}
