import type { GameEvent, Seat } from "~/game/protocol/messages";
import type { SpectatorDelayMs } from "~/game/protocol/spectatorDelay";
import type { MatchRepository, PersistedMatchEvent } from "../repository";
import { runtimeCalendarNow, type MatchRuntime } from "../runtime";
import { gameTiming } from "../session/timingPolicy";
import type { RoomRoster } from "../session/roomRoster";
import type { FinalScore } from "../session/sessionTypes";
import type { SessionSnapshot } from "../session/sessionCoordinator";

export interface RelayMatchPort {
  sessionSnapshot(): Pick<SessionSnapshot, "status" | "startedAt">;
  startRelay(): void;
  finishRelay(): void;
  history(): readonly PersistedMatchEvent[];
  appendRelay(event: GameEvent): void;
  sendToSpectators(event: GameEvent): void;
  notifyDelayedSpectators(): void;
}

export class RelayMatch {
  private enabled = false;
  private sourceGameId: string | null = null;
  private sourceGameIdAliases: string[] = [];
  private ruleSet = "tenhou-default";
  private seats: Array<{ seat: Seat; displayName: string }> | null = null;
  private finalScores: FinalScore[] | null = null;

  constructor(
    private readonly matchId: string,
    private readonly minimumDelayMs: SpectatorDelayMs,
    private readonly runtime: MatchRuntime,
    private readonly repository: MatchRepository,
    private readonly roster: RoomRoster,
    private readonly port: RelayMatchPort
  ) {}

  get isRelay(): boolean {
    return this.enabled;
  }

  get presetId(): string {
    return this.ruleSet;
  }

  get spectatorDelayMs(): SpectatorDelayMs {
    return this.enabled
      ? gameTiming.TENHOU_RELAY_VIEWER_DELAY_MS
      : this.minimumDelayMs;
  }

  spectatorDispatchDelayMs(requestedDelayMs: number): number {
    return this.enabled ? 0 : Math.max(this.minimumDelayMs, requestedDelayMs);
  }

  start(sourceGameId: string | null, ruleSet: string): void {
    this.enabled = true;
    this.port.startRelay();
    this.sourceGameId = sourceGameId;
    this.ruleSet = ruleSet;
  }

  setReplayIdentity(
    sourceGameId: string,
    sourceGameIdAliases: string[] = []
  ): void {
    if (!this.enabled || this.port.sessionSnapshot().status !== "playing") {
      return;
    }
    this.sourceGameId = sourceGameId;
    this.sourceGameIdAliases = [...new Set(sourceGameIdAliases)];
  }

  injectEvent(event: GameEvent): void {
    if (!this.enabled || this.port.sessionSnapshot().status !== "playing") {
      return;
    }
    this.port.appendRelay(event);
    if (event.type === "match_start") {
      this.seats = event.seats.map((seat) => ({
        seat: seat.seat,
        displayName: seat.displayName,
      }));
      for (const seat of event.seats) {
        this.roster.replaceSeat(seat.seat, {
          userId: seat.userId,
          displayName: seat.displayName,
          isBot: false,
        });
      }
    } else if (event.type === "match_end") {
      this.finalScores = event.finalScores.map((score) => ({
        seat: score.seat,
        score: score.score,
        place: score.place as FinalScore["place"],
      }));
    }
    this.port.sendToSpectators(event);
    this.port.notifyDelayedSpectators();
  }

  async close(): Promise<void> {
    if (!this.enabled || this.port.sessionSnapshot().status !== "playing") {
      return;
    }
    this.port.finishRelay();
    if (!this.sourceGameId) {
      return;
    }
    const seats = ([0, 1, 2, 3] as const).map((seat) => {
      const finalScore = this.finalScores?.find((score) => score.seat === seat);
      return {
        seat,
        displayName:
          this.seats?.find((player) => player.seat === seat)?.displayName ||
          this.roster.player(seat)?.displayName ||
          `Seat ${seat}`,
        finalScore: finalScore?.score ?? 0,
        place: finalScore?.place ?? ((seat + 1) as FinalScore["place"]),
      };
    });
    try {
      await this.repository.archiveReplayLog({
        matchId: this.matchId,
        source: "tenhou",
        sourceGameId: this.sourceGameId,
        sourceGameIdAliases: this.sourceGameIdAliases,
        insertOnly: true,
        startedAt:
          this.port.sessionSnapshot().startedAt ??
          new Date(runtimeCalendarNow(this.runtime)),
        endedAt: new Date(runtimeCalendarNow(this.runtime)),
        ruleSet: this.ruleSet,
        events: this.port.history().map((entry) => entry.event),
        seats,
      });
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error(
        "[game-server] relay archiveReplayLog failed (non-fatal)",
        error
      );
    }
  }
}
