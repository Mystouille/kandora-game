import type { Seat } from "~/game/protocol/messages";
import type { MatchCheckpoint } from "../checkpoint";
import type { PendingMatchCommand } from "../repository";
import { ActionWindowRegistry } from "../timing/actionWindows";
import { DecisionWindowError } from "../timing/windowReceipt";

export interface CommandFence {
  current(): boolean;
  onStale(): void;
}

export interface CommandExecutionPort {
  sequence(): number;
  status(): "waiting" | "playing" | "finished";
  isPaused(): boolean;
  pendingCheckpointSave(): Promise<MatchCheckpoint> | null;
  accept(command: PendingMatchCommand): boolean;
  execute(command: PendingMatchCommand): Promise<void>;
  decisionId?(command: PendingMatchCommand): string | null;
  afkDefaultAction(seat: Seat): string | null;
  persistRecovery(): Promise<void>;
}

function invalidCommandMessage(command: PendingMatchCommand): string {
  if (command.type === "act") {
    return `pending action ${command.actionId} is no longer legal for seat ${command.seat}`;
  }
  if (command.type === "ready") {
    return `pending ready is no longer valid for seat ${command.seat}`;
  }
  if (command.type === "afk") {
    return `pending AFK state is no longer valid for seat ${command.seat}`;
  }
  return `pending vote is no longer valid for seat ${command.seat}`;
}

/** Owns command/default serialization and the open-input pause/recovery handoffs. */
export class CommandCoordinator {
  private pendingTransaction: Promise<void> | null = null;
  private nextTransactionId = 1;
  private activeTransactionId: number | null = null;
  private replayingLegacyCommand = false;
  private needsRecovery = false;
  private failure: Error | null = null;
  private boundaryResolve: (() => void) | null = null;
  private boundaryPromise: Promise<void> | null = null;
  private boundaryHandoff: Promise<void> | null = null;
  private defaultInFlight = false;
  private pendingDefault: Promise<void> | null = null;
  private defaultHandoff: Promise<void> | null = null;
  private defaultHandoffResolve: (() => void) | null = null;

  constructor(
    private readonly windows: ActionWindowRegistry,
    private readonly port: CommandExecutionPort
  ) {}

  get transaction(): Promise<void> | null {
    return this.pendingTransaction;
  }

  get automatic(): Promise<void> | null {
    return this.pendingDefault;
  }

  get automaticInFlight(): boolean {
    return this.defaultInFlight;
  }

  get legacyRecoveryInProgress(): boolean {
    return this.replayingLegacyCommand;
  }

  get recoveryRequired(): boolean {
    return this.needsRecovery;
  }

  get recoveryError(): Error | null {
    return this.failure;
  }

  clearLegacyRecovery(): void {
    this.replayingLegacyCommand = false;
  }

  handleAct(seat: Seat, actionId: string, fence?: CommandFence): Promise<void> {
    return this.submit({ type: "act", seat, actionId }, fence);
  }

  handleReady(seat: Seat, fence?: CommandFence): Promise<void> {
    return this.submit({ type: "ready", seat }, fence);
  }

  handleAfk(seat: Seat, afk: boolean): Promise<void> {
    if (
      this.port.status() !== "playing" ||
      this.port.pendingCheckpointSave() !== null
    ) {
      return Promise.resolve();
    }
    return this.submit({
      type: "afk",
      seat,
      afk,
      defaultActionId: afk ? this.port.afkDefaultAction(seat) : null,
    });
  }

  handleVoteContinue(
    seat: Seat,
    vote: "yes" | "no",
    fence?: CommandFence
  ): Promise<void> {
    return this.submit({ type: "vote_continue", seat, vote }, fence);
  }

  async waitUntilConnectionReady(): Promise<boolean> {
    const active =
      this.port.pendingCheckpointSave() ??
      this.boundaryHandoff ??
      this.pendingTransaction;
    if (active !== null) {
      try {
        await active;
      } catch {
        // Recovery/paused authority, not the rejected promise, decides reconnect.
      }
    }
    return !this.port.isPaused();
  }

  watchBoundary(): Promise<void> {
    const boundary = new Promise<void>((resolve) => {
      this.boundaryResolve = resolve;
    });
    this.boundaryPromise = boundary;
    return boundary;
  }

  clearBoundary(boundary: Promise<void>): void {
    if (this.boundaryPromise === boundary) {
      this.boundaryPromise = null;
      this.boundaryResolve = null;
    }
  }

  async restorePendingCommand(command: PendingMatchCommand): Promise<void> {
    this.replayingLegacyCommand = true;
    const boundary = this.watchBoundary();
    const replaying = this.runCommand(command, true);
    this.pendingTransaction = replaying;
    const clearReplay = (): void => {
      if (this.pendingTransaction === replaying) {
        this.pendingTransaction = null;
      }
      this.clearBoundary(boundary);
    };
    void replaying.then(clearReplay, clearReplay);
    await Promise.race([replaying, boundary]);
  }

  commitOpenInputBoundary(): Promise<void> {
    const transactionId = this.activeTransactionId;
    if (this.pendingTransaction === null || transactionId === null) {
      if (this.defaultInFlight) {
        this.defaultInFlight = false;
        this.pendingDefault = null;
        this.releaseDefaultHandoff();
      }
      return Promise.resolve();
    }
    if (this.boundaryHandoff !== null) {
      return this.boundaryHandoff;
    }
    const handingOff = this.persistOpenInputBoundary(transactionId);
    this.boundaryHandoff = handingOff;
    return handingOff;
  }

  async runAutomaticDefault(operation: () => Promise<void>): Promise<void> {
    const handoff = new Promise<void>((resolve) => {
      this.defaultHandoffResolve = resolve;
    });
    this.defaultHandoff = handoff;
    this.defaultInFlight = true;
    const applying = operation();
    this.pendingDefault = applying;
    try {
      await applying;
    } finally {
      if (this.pendingDefault === applying) {
        this.pendingDefault = null;
        this.defaultInFlight = false;
      }
      if (this.defaultHandoff === handoff) {
        this.releaseDefaultHandoff();
      }
    }
  }

  private assertFence(fence?: CommandFence): void {
    if (fence && !fence.current()) {
      this.rejectFence(fence);
    }
  }

  private rejectFence(fence: CommandFence): never {
    fence.onStale();
    throw new DecisionWindowError(
      "The input belongs to a replaced owner or decision."
    );
  }

  private async submit(
    command: PendingMatchCommand,
    fence?: CommandFence
  ): Promise<void> {
    this.assertFence(fence);
    const receivedAtSeq = this.port.sequence();
    const receivedWindowId =
      this.port.decisionId?.(command) ??
      (command.type === "act"
        ? (this.windows.timedView(command.seat)?.id ?? null)
        : null);
    const requiresSameSequence =
      command.type === "act" || command.type === "ready";
    const sameDecision = (): boolean =>
      receivedWindowId !== null
        ? (this.port.decisionId?.(command) ??
            this.windows.timedView(command.seat)?.id) === receivedWindowId
        : !requiresSameSequence || this.port.sequence() === receivedAtSeq;
    if (
      this.port.pendingCheckpointSave() !== null ||
      (command.type === "afk" && this.port.status() !== "playing")
    ) {
      return;
    }
    const activeDefault = this.pendingDefault;
    if (activeDefault !== null) {
      if (!this.port.accept(command)) {
        return;
      }
      await (this.defaultHandoff ?? activeDefault);
      if (!this.port.isPaused() && sameDecision()) {
        await this.retry(command, fence);
      } else if (fence) {
        this.rejectFence(fence);
      }
      return;
    }
    const activeTransaction = this.pendingTransaction;
    if (activeTransaction !== null) {
      if (command.type !== "act" && !this.port.accept(command)) {
        return;
      }
      try {
        await (command.type === "act"
          ? activeTransaction
          : (this.boundaryHandoff ?? activeTransaction));
      } catch {
        // Failed execution has already placed authority in recovery-only mode.
      }
      if (this.pendingTransaction === activeTransaction) {
        this.pendingTransaction = null;
      }
      if (!this.port.isPaused() && sameDecision()) {
        await this.retry(command, fence);
      } else if (fence) {
        this.rejectFence(fence);
      }
      return;
    }
    if (
      this.port.isPaused() ||
      this.port.pendingCheckpointSave() !== null ||
      !this.port.accept(command)
    ) {
      return;
    }
    const transaction = this.runCommand(command, false, fence);
    this.pendingTransaction = transaction;
    try {
      await transaction;
    } finally {
      if (this.pendingTransaction === transaction) {
        this.pendingTransaction = null;
      }
    }
  }

  private retry(
    command: PendingMatchCommand,
    fence?: CommandFence
  ): Promise<void> {
    if (command.type === "afk") {
      return this.handleAfk(command.seat, command.afk);
    }
    return this.submit(command, fence);
  }

  private async runCommand(
    command: PendingMatchCommand,
    replaying = false,
    fence?: CommandFence
  ): Promise<void> {
    const transactionId = this.nextTransactionId++;
    this.activeTransactionId = transactionId;
    try {
      await Promise.resolve();
      this.assertFence(fence);
      if (
        command.type === "act" ||
        (command.type === "afk" && command.defaultActionId !== null)
      ) {
        this.windows.cancelTimer(command.seat);
      }
      await this.executeCommand(command);
      if (replaying) {
        await this.port.persistRecovery();
      }
    } finally {
      if (this.activeTransactionId === transactionId) {
        this.activeTransactionId = null;
      }
    }
  }

  private async executeCommand(command: PendingMatchCommand): Promise<void> {
    try {
      if (!this.port.accept(command)) {
        throw new Error(invalidCommandMessage(command));
      }
      await this.port.execute(command);
    } catch (error) {
      this.needsRecovery = true;
      const message = error instanceof Error ? error.message : String(error);
      const recoveryError = new Error(`MatchProcess: ${message}`, {
        cause: error,
      });
      this.failure = recoveryError;
      throw recoveryError;
    }
  }

  private async persistOpenInputBoundary(transactionId: number): Promise<void> {
    try {
      await this.port.persistRecovery();
    } finally {
      this.boundaryHandoff = null;
    }
    this.pendingTransaction = null;
    if (this.activeTransactionId === transactionId) {
      this.activeTransactionId = null;
    }
    const resolve = this.boundaryResolve;
    this.boundaryPromise = null;
    this.boundaryResolve = null;
    resolve?.();
  }

  private releaseDefaultHandoff(): void {
    const resolve = this.defaultHandoffResolve;
    this.defaultHandoff = null;
    this.defaultHandoffResolve = null;
    resolve?.();
  }
}
