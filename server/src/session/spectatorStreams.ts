import type {
  GameEvent,
  ServerMessage,
  ViewerPresence,
} from "~/game/protocol/messages";
import type { SpectatorDelayMs } from "~/game/protocol/spectatorDelay";
import type { PersistedMatchEvent } from "../repository";
import type { MatchRuntime, MatchTimer } from "../runtime";
import { projectPublicEvent } from "../projection";
import type { DecisionTiming } from "../timing/decisionTiming";
import { replayProjectedEvents } from "./eventReplay";
import type { Send } from "./playerConnections";
import type { MatchViewerPresence } from "./viewerPresence";

/** Opaque connection handle returned on attach and consumed on detach. */
export interface DelayedSpectatorSession {
  send: Send;
  delayMs: number;
  nextCursor: number;
  seq: number;
  timer: MatchTimer | null;
  closed: boolean;
}

export interface SpectatorStreamPort {
  readonly matchId: string;
  readonly runtime: Pick<MatchRuntime, "now" | "schedule">;
  readonly timing: Pick<
    DecisionTiming,
    "timingMode" | "stamp" | "spectatorMetadata"
  >;
  isRelay(): boolean;
  spectatorDelayMs(): SpectatorDelayMs;
  spectatorDispatchDelayMs(requestedDelayMs: number): number;
  history(): readonly PersistedMatchEvent[];
  nextSequence(): number;
  claimSpectatorSequence(): number;
  buildRoomState(): Extract<ServerMessage, { type: "room_state" }>;
  broadcastViewerState(): void;
}

export class SpectatorStreams {
  private readonly live = new Set<Send>();
  private readonly delayed = new Set<DelayedSpectatorSession>();

  constructor(
    private readonly presence: MatchViewerPresence,
    private readonly port: SpectatorStreamPort
  ) {}

  get hasLive(): boolean {
    return this.live.size > 0;
  }

  delayedSessions(): ReadonlySet<unknown> {
    return new Set(this.delayed);
  }

  broadcastLive(message: ServerMessage): void {
    for (const send of this.live) {
      send(message);
    }
  }

  broadcastPresence(message: ServerMessage): void {
    this.broadcastLive(message);
    for (const session of this.delayed) {
      if (!session.closed) {
        session.send(message);
      }
    }
  }

  attachSpectator(send: Send, viewer?: ViewerPresence): void {
    if (this.port.spectatorDispatchDelayMs(0) > 0) {
      throw new Error(
        "This match requires delayed spectating; use attachDelayedSpectator."
      );
    }
    this.live.add(send);
    if (viewer) {
      this.presence.attach(send, {
        ...viewer,
        role: "spectator",
        delayMs: this.port.isRelay() ? this.port.spectatorDelayMs() : 0,
      });
    }
    send({
      type: "spectator_config",
      matchId: this.port.matchId,
      delayMs: this.port.spectatorDelayMs(),
      ...(this.port.timing.timingMode !== "legacy"
        ? { clock: this.port.timing.stamp(), presentationOffsetMs: 0 }
        : {}),
    });
    send(this.port.buildRoomState());
    this.port.broadcastViewerState();
  }

  detachSpectator(send: Send): void {
    this.live.delete(send);
    this.presence.detach(send);
    this.port.broadcastViewerState();
  }

  attachDelayedSpectator(
    send: Send,
    delayMs: number,
    viewer?: ViewerPresence
  ): DelayedSpectatorSession {
    if (delayMs < 0) {
      throw new Error("attachDelayedSpectator: delayMs must be >= 0");
    }
    const effectiveDelayMs = this.port.spectatorDispatchDelayMs(delayMs);
    const session: DelayedSpectatorSession = {
      send,
      delayMs: effectiveDelayMs,
      nextCursor: 0,
      seq: 0,
      timer: null,
      closed: false,
    };
    this.delayed.add(session);
    if (viewer) {
      this.presence.attach(send, {
        ...viewer,
        role: "spectator",
        delayMs: this.port.isRelay()
          ? this.port.spectatorDelayMs()
          : effectiveDelayMs,
      });
    }
    send({
      type: "spectator_config",
      matchId: this.port.matchId,
      delayMs: this.port.isRelay()
        ? this.port.spectatorDelayMs()
        : effectiveDelayMs,
      ...(this.port.timing.timingMode !== "legacy"
        ? {
            clock: this.port.timing.stamp(),
            presentationOffsetMs: this.port.isRelay() ? 0 : effectiveDelayMs,
          }
        : {}),
    });
    this.dispatchDelayedSpectator(session, true);
    this.port.broadcastViewerState();
    return session;
  }

  detachDelayedSpectator(session: DelayedSpectatorSession): void {
    session.closed = true;
    if (session.timer !== null) {
      session.timer.cancel();
      session.timer = null;
    }
    this.delayed.delete(session);
    this.presence.detach(session.send);
    this.port.broadcastViewerState();
  }

  private dispatchDelayedSpectator(
    session: DelayedSpectatorSession,
    batched: boolean
  ): void {
    if (session.closed) {
      return;
    }
    if (session.timer !== null) {
      session.timer.cancel();
      session.timer = null;
    }
    const now = this.port.runtime.now();
    const batch: GameEvent[] = [];
    let lastSeq = -1;
    while (session.nextCursor < this.port.history().length) {
      const entry = this.port.history()[session.nextCursor];
      if (entry.emittedAt + session.delayMs > now) {
        break;
      }
      session.nextCursor++;
      const projected = projectPublicEvent(entry.event);
      if (projected === null) {
        continue;
      }
      const seq = session.seq++;
      if (batched) {
        batch.push(projected);
        lastSeq = seq;
      } else {
        session.send({
          type: "event",
          seq,
          events: [projected],
          legalActions: [],
          ...this.port.timing.spectatorMetadata(
            entry.seq,
            seq,
            session.delayMs,
            this.port.isRelay()
          ),
        });
      }
    }
    if (batched && batch.length > 0) {
      session.send({
        type: "event",
        seq: lastSeq,
        events: batch,
        legalActions: [],
      });
    }
    if (session.nextCursor < this.port.history().length) {
      const entry = this.port.history()[session.nextCursor];
      const waitMs = Math.max(
        0,
        entry.emittedAt + session.delayMs - this.port.runtime.now()
      );
      session.timer = this.port.runtime.schedule(() => {
        session.timer = null;
        this.dispatchDelayedSpectator(session, false);
      }, waitMs);
    }
  }

  notifyDelayedSpectators(): void {
    for (const session of this.delayed) {
      if (session.timer === null && !session.closed) {
        this.dispatchDelayedSpectator(session, false);
      }
    }
  }

  sendToSpectators(event: GameEvent): void {
    const projected = projectPublicEvent(event);
    if (projected === null) {
      return;
    }
    // The canonical public sequence advances even with no live attachment.
    const seq = this.port.claimSpectatorSequence();
    for (const send of this.live) {
      send({
        type: "event",
        seq,
        events: [projected],
        legalActions: [],
        ...this.port.timing.spectatorMetadata(
          this.port.nextSequence() - 1,
          seq,
          0,
          this.port.isRelay()
        ),
      });
    }
  }

  replaySpectatorBuffer(
    fromSeq: number
  ): Array<{ seq: number; event: GameEvent }> {
    return replayProjectedEvents(
      this.port.history(),
      fromSeq,
      projectPublicEvent
    );
  }

  replayDelayedSpectatorBuffer(
    fromSeq: number,
    delayMs: number,
    now: number = this.port.runtime.now()
  ): Array<{ seq: number; event: GameEvent }> {
    return replayProjectedEvents(
      this.port.history(),
      fromSeq,
      projectPublicEvent,
      (entry) =>
        !(entry.emittedAt + this.port.spectatorDispatchDelayMs(delayMs) > now)
    );
  }
}
