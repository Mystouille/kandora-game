import { activeSeats } from "~/game/rules/seats";
import type {
  GameEvent,
  MatchDebug,
  Seat,
  ServerMessage,
  ViewerPresence,
} from "~/game/protocol/messages";
import {
  normalMatchMode,
  type MatchModeConfig,
} from "~/game/protocol/matchMode";
import type { SpectatorDelayMs } from "~/game/protocol/spectatorDelay";
import type { InputReceipt } from "~/game/protocol/timing";
import type { RuleSetOverride } from "~/game/rules";
import { parseMatchCheckpoint, type MatchCheckpoint } from "./checkpoint";
import { MatchComposition } from "./composition/matchComposition";
import type { MatchProcessDependencies } from "./composition/dependencies";
import { restoreSavedMatch } from "./recovery/matchRecovery";
import type { CallResolutionSnapshot } from "./session/callCoordinator";
import type { CommandFence } from "./session/commandCoordinator";
import {
  type Send,
  type HumanConnectionOptions,
  type HumanAttachResult,
} from "./session/playerConnections";
import type { MatchPlayerInit } from "./session/roomRoster";
import { waitingRoomSeatPermutation } from "./session/seating";
import type { SessionSnapshot } from "./session/sessionCoordinator";
import type { DelayedSpectatorSession } from "./session/spectatorStreams";
import { DecisionWindowError } from "./timing/actionWindows";
import type { LatencyProfile } from "./transport/latencyProfile";

export type { MatchProcessDependencies } from "./composition/dependencies";
export type { AutomaticActionContext } from "./session/sessionTypes";
export type { MatchPlayerInit } from "./session/roomRoster";
export type { DelayedSpectatorSession } from "./session/spectatorStreams";
export {
  HumanSessionTakeoverRequiredError,
  type HumanConnectionOptions,
  type HumanAttachResult,
} from "./session/playerConnections";
export {
  setNextHandDelayMs,
  setContinueVoteMs,
  setMatchEndDisplayMs,
  setDelayAfterDiscardMs,
  setExhaustiveDrawDelayMs,
  setRyuukyokuDeclarationTimingMs,
  setActionTimeoutMs,
  setActionTimingMs,
  setReadyCheckMs,
  remainingWinReactionDelayMs,
  winResultRevealDurationMs,
} from "./session/timingPolicy";
export { waitingRoomSeatPermutation } from "./session/seating";
export { compactRyuukyokuDeclarationsForReplay } from "./session/replayEvents";

/** Public compatibility facade; composition exposes the actual state owners. */
export class MatchProcess {
  readonly owners: MatchComposition;

  constructor(
    readonly matchId: string,
    readonly seed: number,
    players: MatchPlayerInit[],
    dependencies: MatchProcessDependencies,
    debug?: MatchDebug,
    ruleSetOverride?: RuleSetOverride,
    presetId = "tenhou-hanchan",
    mode: MatchModeConfig = normalMatchMode,
    spectatorDelayMs: SpectatorDelayMs = 0
  ) {
    this.owners = new MatchComposition(
      {
        matchId,
        seed,
        debug,
        ruleSetOverride,
        presetId,
        mode,
        spectatorDelayMs,
      },
      players,
      dependencies
    );
  }

  get status(): "waiting" | "playing" | "finished" {
    return this.owners.lifecycle.session.snapshot().status;
  }

  get isRelay(): boolean {
    return this.owners.relay.isRelay;
  }

  get spectatorDelayMs(): SpectatorDelayMs {
    return this.owners.relay.spectatorDelayMs;
  }

  spectatorDispatchDelayMs(requestedDelayMs: number): number {
    return this.owners.relay.spectatorDispatchDelayMs(requestedDelayMs);
  }

  get hasPendingFinalization(): boolean {
    return this.owners.lifecycle.session.hasPendingFinalization;
  }

  get isPaused(): boolean {
    return this.owners.isPaused;
  }

  get pendingCommandRecoveryError(): Error | null {
    return this.owners.commands.recoveryError;
  }

  sessionSnapshot(): SessionSnapshot {
    return this.owners.lifecycle.session.snapshot();
  }

  callResolutionSnapshot(): CallResolutionSnapshot {
    return this.owners.gameplay.calls.snapshot();
  }

  summary() {
    return this.owners.roomViews.summary();
  }

  authorityNow(): number {
    return this.owners.runtime.now();
  }

  actionReceipt(seat: Seat, receivedAt: number): InputReceipt {
    const window = this.owners.actionWindows.timedView(seat);
    return {
      receivedAt,
      ...(window ? { windowId: window.id, clockEpoch: window.clockEpoch } : {}),
    };
  }

  private directActionReceipt(seat: Seat): InputReceipt {
    const now = this.authorityNow();
    const opensAt = this.owners.actionWindows.timedView(seat)?.opensAt ?? now;
    return this.actionReceipt(seat, Math.max(now, opensAt));
  }

  promptReceipt(seat: Seat, receivedAt: number): InputReceipt {
    const window = this.owners.timing.promptTiming?.view(seat);
    return {
      receivedAt,
      ...(window ? { windowId: window.id, clockEpoch: window.clockEpoch } : {}),
    };
  }

  reservePrompt(
    seat: Seat,
    reply: "ready" | "yes" | "no",
    receipt: InputReceipt
  ): void {
    if (this.isPaused || this.owners.recovery.coordinator.saving !== null) {
      throw new DecisionWindowError("The decision is paused for recovery.");
    }
    this.stampReceiptOwner(seat, receipt, (stale) => {
      if (reply === "ready") {
        this.owners.lifecycle.ready.releaseReceipt(seat, stale);
      } else {
        this.owners.lifecycle.votes.releaseReceipt(seat, stale);
      }
    });
    if (reply === "ready") {
      this.owners.lifecycle.ready.reserve(seat, receipt);
    } else {
      this.owners.lifecycle.votes.reserve(seat, reply, receipt);
    }
  }

  reserveAction(seat: Seat, actionId: string, receipt: InputReceipt): void {
    if (this.isPaused || this.owners.recovery.coordinator.saving !== null) {
      throw new DecisionWindowError("The decision is paused for recovery.");
    }
    this.stampReceiptOwner(seat, receipt, (stale) =>
      this.owners.actionWindows.releaseReservation(seat, stale)
    );
    this.owners.timing.reserve(seat, actionId, receipt);
  }

  private stampReceiptOwner(
    seat: Seat,
    receipt: InputReceipt,
    onStale: (receipt: InputReceipt) => void
  ): void {
    const generation = this.owners.connections.view(seat).generation;
    if (receipt.ownerGeneration === undefined) {
      receipt.ownerGeneration = generation;
    }
    if (receipt.ownerGeneration !== generation) {
      onStale(receipt);
      throw new DecisionWindowError(
        "The input belongs to a replaced owner or decision."
      );
    }
  }

  private receiptFence(
    seat: Seat,
    receipt: InputReceipt,
    windowId: () => string | null,
    release: (receipt: InputReceipt) => void
  ): CommandFence {
    const token = Object.freeze({ ...receipt });
    return {
      current: () =>
        this.owners.connections.view(seat).generation ===
          token.ownerGeneration && windowId() === token.windowId,
      onStale: () => release(token),
    };
  }

  configurePlayerTiming(
    seat: Seat,
    network: "direct" | "remote",
    profile: () => LatencyProfile | null
  ): void {
    this.owners.timing.connection(seat, network, profile);
  }

  async waitUntilConnectionReady(): Promise<boolean> {
    const ready = await this.owners.commands.waitUntilConnectionReady();
    if (ready) {
      await this.owners.recovery.resumeAutomaticWork();
    }
    return ready;
  }

  static createWaitingRoom(
    matchId: string,
    seed: number,
    dependencies: MatchProcessDependencies,
    debug?: MatchDebug,
    ruleSetOverride?: RuleSetOverride,
    presetId = "tenhou-hanchan",
    mode: MatchModeConfig = normalMatchMode,
    spectatorDelayMs: SpectatorDelayMs = 0
  ): MatchProcess {
    const players = activeSeats(ruleSetOverride?.playerCount ?? 4).map(
      (seat) => ({
        userId: `__empty__:${seat}`,
        displayName: "",
        isBot: true,
      })
    );
    const match = new MatchProcess(
      matchId,
      seed,
      players,
      dependencies,
      debug,
      ruleSetOverride,
      presetId,
      mode,
      spectatorDelayMs
    );
    match.owners.roster.empty();
    return match;
  }

  static createRelayMatch(
    matchId: string,
    sourceGameId: string | null,
    dependencies: MatchProcessDependencies,
    ruleSet = "tenhou-default"
  ): MatchProcess {
    const players = [0, 1, 2, 3].map((seat) => ({
      userId: `__relay__:${seat}`,
      displayName: "",
      isBot: true,
    }));
    const match = new MatchProcess(
      matchId,
      0,
      players,
      dependencies,
      undefined,
      undefined,
      "tenhou-hanchan"
    );
    match.owners.relay.start(sourceGameId, ruleSet);
    return match;
  }

  setRelayReplayIdentity(
    sourceGameId: string,
    sourceGameIdAliases: string[] = []
  ): void {
    this.owners.relay.setReplayIdentity(sourceGameId, sourceGameIdAliases);
  }

  createCheckpoint(): MatchCheckpoint {
    return this.owners.recovery.createCheckpoint();
  }

  pauseAndSaveCheckpoint(): Promise<MatchCheckpoint> {
    return this.owners.recovery.coordinator.pause();
  }

  static restoreCheckpoint(
    input: unknown,
    dependencies: MatchProcessDependencies
  ): MatchProcess {
    const checkpoint = parseMatchCheckpoint(input);
    const match =
      checkpoint.status === "waiting"
        ? MatchProcess.createWaitingRoom(
            checkpoint.matchId,
            checkpoint.seed,
            dependencies,
            checkpoint.debug,
            checkpoint.ruleSet,
            checkpoint.presetId,
            checkpoint.mode,
            checkpoint.spectatorDelayMs
          )
        : new MatchProcess(
            checkpoint.matchId,
            checkpoint.seed,
            checkpoint.seats.map((player) => ({ ...player })),
            dependencies,
            undefined,
            checkpoint.state.ruleSet,
            checkpoint.presetId,
            checkpoint.mode,
            checkpoint.spectatorDelayMs
          );
    match.owners.recovery.restoreCheckpoint(checkpoint);
    return match;
  }

  static async restoreSavedCheckpoint(
    matchId: string,
    dependencies: MatchProcessDependencies
  ): Promise<MatchProcess | null> {
    return restoreSavedMatch(
      matchId,
      dependencies,
      (checkpoint, restoredDependencies) =>
        MatchProcess.restoreCheckpoint(checkpoint, restoredDependencies)
    );
  }

  async flushEventJournal(): Promise<void> {
    return this.owners.publisher.flushEventJournal();
  }

  async deleteSavedCheckpoint(): Promise<void> {
    await this.owners.repository.deleteCheckpoint(this.matchId);
  }

  async start(): Promise<void> {
    return this.owners.lifecycle.session.start();
  }

  async handleReady(seat: Seat, receipt?: InputReceipt): Promise<void> {
    const acceptedReceipt =
      receipt ?? this.promptReceipt(seat, this.authorityNow());
    this.reservePrompt(seat, "ready", acceptedReceipt);
    const fence = this.receiptFence(
      seat,
      acceptedReceipt,
      () => this.owners.timing.promptTiming?.view(seat)?.id ?? null,
      (stale) => this.owners.lifecycle.ready.releaseReceipt(seat, stale)
    );
    try {
      await this.owners.commands.handleReady(seat, fence);
    } finally {
      fence.onStale();
    }
  }

  attachHuman(
    seat: Seat,
    send: Send,
    livenessProbe?: () => Promise<boolean>,
    connection?: HumanConnectionOptions
  ): HumanAttachResult {
    const result = this.owners.connections.attach(
      seat,
      send,
      livenessProbe,
      connection
    );
    if (this.owners.lifecycle.ready.snapshot().deadline !== null) {
      this.owners.lifecycle.ready.broadcastReadyCheck();
    }
    this.owners.broadcast.broadcastRoomState();
    this.owners.broadcast.broadcastViewerState();
    return result;
  }

  isHumanAttached(seat: Seat, send: Send): boolean {
    return this.owners.connections.isAttached(seat, send);
  }

  humanSeatForUser(userId: string): Seat | null {
    return this.owners.roster.humanSeatForUser(userId);
  }

  isHumanConnected(seat: Seat): boolean {
    return this.owners.connections.isConnected(seat);
  }

  humanSeatFor(send: Send): Seat | null {
    return this.owners.connections.seatFor(send);
  }

  detachHuman(seat: Seat, expectedSend?: Send): boolean {
    if (
      !this.owners.connections.detach(
        seat,
        expectedSend,
        this.isPaused,
        this.status === "playing"
      )
    ) {
      return false;
    }
    if (
      !this.isPaused &&
      this.status === "playing" &&
      this.owners.actionWindows.legals(seat).length > 0 &&
      this.owners.actionWindows.view(seat).kind !== "ryuukyoku_declaration"
    ) {
      void this.owners.gameplay.decisions.handleDeadlineExpiry(seat);
    }
    this.owners.broadcast.broadcastRoomState();
    this.owners.broadcast.broadcastViewerState();
    return true;
  }

  hasConnectedHumanPlayers(): boolean {
    return this.owners.roster
      .humanSeats()
      .some((seat) => this.owners.connections.sender(seat) !== null);
  }

  hasSeatedHumans(): boolean {
    return this.owners.roster.humanSeats().length > 0;
  }

  async abortAbandoned(): Promise<void> {
    return this.owners.lifecycle.session.abortAbandoned();
  }

  async handleAfk(seat: Seat, afk: boolean): Promise<void> {
    return this.owners.commands.handleAfk(seat, afk);
  }

  attachSpectator(send: Send, viewer?: ViewerPresence): void {
    this.owners.spectators.attachSpectator(send, viewer);
  }

  detachSpectator(send: Send): void {
    this.owners.spectators.detachSpectator(send);
  }

  attachDelayedSpectator(
    send: Send,
    delayMs: number,
    viewer?: ViewerPresence
  ): DelayedSpectatorSession {
    return this.owners.spectators.attachDelayedSpectator(send, delayMs, viewer);
  }

  detachDelayedSpectator(session: DelayedSpectatorSession): void {
    this.owners.spectators.detachDelayedSpectator(session);
  }

  replayDelayedSpectatorBuffer(
    fromSeq: number,
    delayMs: number,
    now: number = this.owners.runtime.now()
  ): Array<{ seq: number; event: GameEvent }> {
    return this.owners.spectators.replayDelayedSpectatorBuffer(
      fromSeq,
      delayMs,
      now
    );
  }

  claimSeat(userId: string, displayName: string): Seat | null {
    return this.owners.roster.claimSeat(userId, displayName);
  }

  releaseSeat(seat: Seat): void {
    this.owners.roster.releaseSeat(seat);
  }

  setWaitingRoomReady(seat: Seat, ready: boolean): void {
    this.owners.roster.setReady(seat, ready);
  }

  canStartWaitingRoom(requestedBy: Seat): boolean {
    return this.owners.roster.canStart(requestedBy);
  }

  async startWaitingRoom(requestedBy: Seat): Promise<void> {
    await this.owners.roster.startWaitingRoom(
      requestedBy,
      waitingRoomSeatPermutation(this.seed, this.owners.roster.playerCount)
    );
  }

  addWaitingRoomBot(requestedBy: Seat): Seat {
    return this.owners.roster.addBot(requestedBy);
  }

  kickWaitingRoomSeat(requestedBy: Seat, target: Seat): void {
    this.owners.roster.kickSeat(requestedBy, target);
  }

  fillBots(): void {
    this.owners.roster.fillBots();
  }

  async fillBotsAndStart(): Promise<void> {
    await this.owners.roster.fillBotsAndStart(
      waitingRoomSeatPermutation(this.seed, this.owners.roster.playerCount)
    );
  }

  buildRoomState(
    forSeat: Seat | null
  ): Extract<ServerMessage, { type: "room_state" }> {
    return this.owners.roomViews.buildRoomState(forSeat);
  }

  broadcastRoomState(): void {
    this.owners.broadcast.broadcastRoomState();
  }

  buildViewerState(): Extract<ServerMessage, { type: "viewer_state" }> {
    return this.owners.presence.build(this.owners.roster.players());
  }

  humanSeats(): Seat[] {
    return this.owners.roster.humanSeats();
  }

  humanUserIds(): string[] {
    return this.owners.roster.humanUserIds();
  }

  isHumanSeat(seat: Seat): boolean {
    return this.owners.roster.isHumanSeat(seat);
  }

  replayFromBuffer(
    fromSeq: number,
    recipient: Seat = 0
  ): Array<{ seq: number; event: GameEvent }> {
    return this.owners.broadcast.replayFromBuffer(fromSeq, recipient);
  }

  buildSnapshotForSeat(
    seat: Seat
  ): Extract<ServerMessage, { type: "snapshot" }> {
    return this.owners.snapshots.buildSnapshotForSeat(seat);
  }

  buildSpectatorSnapshot(): ServerMessage {
    return {
      ...this.owners.snapshots.buildSpectatorSnapshot(),
      ...this.owners.timing.spectatorMetadata(
        this.owners.publisher.nextSequence - 1,
        this.owners.publisher.spectatorSequence - 1,
        0,
        this.isRelay
      ),
    };
  }

  replaySpectatorBuffer(
    fromSeq: number
  ): Array<{ seq: number; event: GameEvent }> {
    return this.owners.spectators.replaySpectatorBuffer(fromSeq);
  }

  async handleAct(
    seat: Seat,
    actionId: string,
    receipt?: InputReceipt
  ): Promise<void> {
    const acceptedReceipt = receipt ?? this.directActionReceipt(seat);
    this.reserveAction(seat, actionId, acceptedReceipt);
    const fence = this.receiptFence(
      seat,
      acceptedReceipt,
      () => this.owners.actionWindows.timedView(seat)?.id ?? null,
      (stale) => this.owners.actionWindows.releaseReservation(seat, stale)
    );
    try {
      await this.owners.commands.handleAct(seat, actionId, fence);
    } finally {
      fence.onStale();
    }
  }

  async handleVoteContinue(
    seat: Seat,
    vote: "yes" | "no",
    receipt?: InputReceipt
  ): Promise<void> {
    const acceptedReceipt =
      receipt ?? this.promptReceipt(seat, this.authorityNow());
    this.reservePrompt(seat, vote, acceptedReceipt);
    const fence = this.receiptFence(
      seat,
      acceptedReceipt,
      () => this.owners.timing.promptTiming?.view(seat)?.id ?? null,
      (stale) => this.owners.lifecycle.votes.releaseReceipt(seat, stale)
    );
    try {
      await this.owners.commands.handleVoteContinue(seat, vote, fence);
    } finally {
      fence.onStale();
    }
  }

  async retryPendingFinalization(): Promise<boolean> {
    return this.owners.lifecycle.session.retryPendingFinalization();
  }

  injectRelayEvent(event: GameEvent): void {
    this.owners.relay.injectEvent(event);
  }

  async closeRelay(): Promise<void> {
    return this.owners.relay.close();
  }
}
