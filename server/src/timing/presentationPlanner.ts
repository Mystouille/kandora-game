import type { GameEvent } from "~/game/protocol/messages";
import type { PresentationEvent } from "~/game/protocol/timing";
import {
  LIVE_DISCARD_SLIDE_MS,
  LIVE_DISCARD_HOVER_MS,
  LIVE_DRAW_SLIDE_MS,
  LIVE_MIN_DRAW_TO_DISCARD_MS,
  LIVE_CALL_READY_MS,
} from "~/game/presentation/policy";

export class PresentationPlanner {
  private lastDiscardAt: number | null = null;
  private readonly lastDrawAt: Array<number | null> = [null, null, null, null];
  private readyAt = 0;
  private latest: PresentationEvent | null = null;
  private readonly schedules = new Map<number, PresentationEvent>();

  record(event: GameEvent, occurredAt: number, seq: number): void {
    if (event.type === "hand_start") {
      this.lastDiscardAt = null;
      this.lastDrawAt.fill(null);
      this.latest = null;
    }
    if (event.type === "draw") {
      const startsAt = Math.max(
        occurredAt,
        this.lastDiscardAt === null
          ? occurredAt
          : this.lastDiscardAt + LIVE_DISCARD_SLIDE_MS + LIVE_DISCARD_HOVER_MS
      );
      this.lastDrawAt[event.seat] = startsAt;
      this.readyAt = startsAt + LIVE_DRAW_SLIDE_MS;
      this.latest = {
        seq,
        kind: "draw",
        occurredAt,
        startsAt,
        readyAt: this.readyAt,
      };
    } else if (event.type === "discard") {
      const drawnAt = this.lastDrawAt[event.seat];
      const startsAt = Math.max(
        occurredAt,
        drawnAt === null ? occurredAt : drawnAt + LIVE_MIN_DRAW_TO_DISCARD_MS
      );
      this.lastDiscardAt = startsAt;
      this.lastDrawAt[event.seat] = null;
      this.readyAt = startsAt + LIVE_DISCARD_SLIDE_MS;
      this.latest = {
        seq,
        kind: "discard",
        occurredAt,
        startsAt,
        readyAt: this.readyAt,
      };
    } else if (
      event.type === "call" ||
      (event.type === "nuki" &&
        (event.stage === "declared" || event.tile !== "4z"))
    ) {
      this.readyAt = occurredAt + LIVE_CALL_READY_MS;
      this.latest = {
        seq,
        kind: "call",
        occurredAt,
        startsAt: occurredAt,
        readyAt: this.readyAt,
      };
    } else if (event.type === "ryuukyoku_declaration") {
      this.readyAt = occurredAt;
    } else if (event.type === "hand_end" || event.type === "match_end") {
      this.readyAt = occurredAt;
      this.latest = null;
    }
    if (this.latest?.seq === seq) {
      this.schedules.set(seq, { ...this.latest });
    }
  }

  decisionReadyAt(now: number): number {
    return Math.max(now, this.readyAt);
  }

  eventForSequence(seq: number): PresentationEvent[] {
    return this.latest === null ? [] : [{ ...this.latest, seq }];
  }

  recordedEvent(sequence: number, wireSequence: number): PresentationEvent[] {
    const event = this.schedules.get(sequence);
    return event === undefined ? [] : [{ ...event, seq: wireSequence }];
  }
}
