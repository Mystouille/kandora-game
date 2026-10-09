import type { ReadonlySeatValues } from "~/game/protocol/seat";
import { copySeatValues } from "~/game/rules/seats";
import {
  permuteSeatValues,
  seatValues,
  type PlayerCount,
} from "~/game/rules/seats";
import { type SeatValues } from "~/game/protocol/seat";
import type { GameEvent } from "~/game/protocol/messages";
import { MatchEventJournal } from "../eventJournal";
import type { MatchRuntime } from "../runtime";
import { runtimeCalendarNow } from "../runtime";
import type { Seat } from "~/game/protocol/messages";
import type {
  MatchEventJournalStore,
  PersistedMatchEvent,
} from "../repository";
import type { DecisionTiming } from "../timing/decisionTiming";
export interface EventPublisherPort {
  readonly playerCount?: PlayerCount;
  readonly runtime: Pick<MatchRuntime, "now" | "wallNow">;
  readonly timing: Pick<DecisionTiming, "record">;
  readonly eventJournalStore: MatchEventJournalStore | null;
  readonly onEventJournalError?: (
    context: import("../eventJournal").EventJournalErrorContext
  ) => void;
  enrichForArchive(event: GameEvent): GameEvent;
  humanSeats(): Seat[];
  sendToSeat(seat: Seat, event: GameEvent): void;
  sendToSpectators(event: GameEvent): void;
  notifyDelayedSpectators(): void;
}
export class MatchEventPublisher {
  constructor(private readonly port: EventPublisherPort) {
    this.seatSeq = seatValues(port.playerCount ?? 4, () => 0);
  }
  private nextSeq = 0;

  private seatSeq: SeatValues<number>;

  private readonly eventLog: Array<{
    seq: number;
    event: GameEvent;
    /** Runtime wall-clock time at which this event was
     * appended to the log. Used by the delayed-spectator scheduler
     * to gate dispatch (`emittedAt + delayMs <= now`). */
    emittedAt: number;
    calendarAt?: number;
  }> = [];

  private spectatorSeq = 0;

  private eventJournal: MatchEventJournal | null = null;

  openEventJournal(matchId: string, initialNextSeq: number): void {
    if (this.port.eventJournalStore === null) {
      return;
    }
    if (this.eventJournal !== null) {
      throw new Error("MatchProcess.openEventJournal: journal already open");
    }
    this.eventJournal = new MatchEventJournal({
      matchId,
      initialNextSeq,
      store: this.port.eventJournalStore,
      readEvents: (fromSeq, toSeq) =>
        this.eventLog.slice(fromSeq, toSeq).map((entry) => ({ ...entry })),
      onError: this.port.onEventJournalError,
    });
  }

  async supersedeEventJournal(): Promise<void> {
    const journal = this.eventJournal;
    this.eventJournal = null;
    await journal?.supersede();
  }

  async flushEventJournal(): Promise<void> {
    if (this.eventJournal !== null) {
      await this.eventJournal.flush();
    }
  }

  async emitEvent(event: GameEvent): Promise<void> {
    this.port.timing.record(event, this.nextSeq);
    const omniSeq = this.nextSeq++;
    const archived = this.port.enrichForArchive(event);
    const emittedAt = this.port.runtime.now();
    this.eventLog.push({
      seq: omniSeq,
      event: archived,
      emittedAt,
      ...(this.port.runtime.wallNow
        ? { calendarAt: runtimeCalendarNow(this.port.runtime) }
        : {}),
    });
    this.eventJournal?.record(omniSeq);
    // Live broadcast — per recipient. Each seat's per-seat seq is
    // assigned inside `sendToSeat`, only when the projection emits
    // a non-null frame. We iterate every human seat so multi-
    // human matches fan out correctly; bots don't have sockets.
    for (const seat of this.port.humanSeats()) {
      this.port.sendToSeat(seat, event);
    }
    // In-process spectator fan-out. Project once via the
    // public-projection helper (recipient: "spectator") and
    // assign the spectator seq line only when the projection is
    // non-null. All attached spectators share the same wire
    // stream / numbering because the projection is pure.
    // Pass the **archived** event so the projection can forward
    // omniscient fields (e.g. `startingHands` on `hand_start`)
    // — spectators are omniscient in this product.
    this.port.sendToSpectators(archived);
    // Notify delayed spectator sessions so they can (re-)schedule
    // their dispatch timer for this freshly appended event. No-op
    // when there are no delayed sessions.
    this.port.notifyDelayedSpectators();
    // Resync (live and spectator) reads from this in-process log.
    // There is no per-event database write; recovery checkpoints
    // snapshot the complete log at command/input boundaries, and
    // `archiveCurrentGame` writes the final public archive at match end.
  }
  get nextSequence(): number {
    return this.nextSeq;
  }
  restoreNextSequence(next: number): void {
    this.nextSeq = next;
  }
  seatSequences(): SeatValues<number> {
    return copySeatValues(this.seatSeq);
  }
  restoreSeatSequences(values: ReadonlySeatValues<number>): void {
    this.seatSeq = copySeatValues(values);
  }
  permuteSeats(permutation: ReadonlySeatValues<Seat>): void {
    this.seatSeq = permuteSeatValues(this.seatSeq, permutation);
  }
  get spectatorSequence(): number {
    return this.spectatorSeq;
  }
  restoreSpectatorSequence(value: number): void {
    this.spectatorSeq = value;
  }
  claimSeatSequence(seat: Seat): number {
    return this.seatSeq[seat]++;
  }
  claimSpectatorSequence(): number {
    return this.spectatorSeq++;
  }
  history(): readonly PersistedMatchEvent[] {
    return this.eventLog;
  }
  restoreEntry(entry: PersistedMatchEvent): void {
    this.eventLog.push(entry);
  }
  get journal(): MatchEventJournal | null {
    return this.eventJournal;
  }
  appendRelay(event: GameEvent): void {
    this.eventLog.push({
      seq: this.nextSeq++,
      event,
      emittedAt: this.port.runtime.now(),
      ...(this.port.runtime.wallNow
        ? { calendarAt: runtimeCalendarNow(this.port.runtime) }
        : {}),
    });
  }
}
