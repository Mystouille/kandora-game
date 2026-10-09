import type { MatchRepository, PersistedMatchEvent } from "../repository";
import { runtimeCalendarNow, type MatchRuntime } from "../runtime";
import type { MatchKernel } from "./matchKernel";
import type { RoomRoster } from "./roomRoster";
import { compactRyuukyokuDeclarationsForReplay } from "./replayEvents";
import type { FinalScore } from "./sessionTypes";
import type { SessionSnapshot } from "./sessionCoordinator";

export interface GameArchivePort {
  history(): readonly PersistedMatchEvent[];
  sessionSnapshot(): SessionSnapshot;
  currentGameMongoId(): string;
  supersedeEventJournal(): Promise<void>;
}

export class GameArchive {
  constructor(
    private readonly presetId: string,
    private readonly runtime: MatchRuntime,
    private readonly repository: MatchRepository,
    private readonly kernel: MatchKernel,
    private readonly roster: RoomRoster,
    private readonly port: GameArchivePort
  ) {}

  async archiveCurrentGame(finalScores: FinalScore[]): Promise<void> {
    const gameEvents = this.port
      .history()
      .slice(this.port.sessionSnapshot().gameStartLogIdx);
    const replayEvents = compactRyuukyokuDeclarationsForReplay(
      gameEvents.map((entry) => entry.event)
    );
    const docId = this.port.currentGameMongoId();
    await this.port.supersedeEventJournal();
    await this.repository.archiveMatch({
      matchId: docId,
      events: gameEvents,
      finalScores: finalScores.map((score) => ({
        seat: score.seat,
        score: score.score,
        place: score.place,
      })),
    });
    try {
      const startedAt =
        this.port.sessionSnapshot().startedAt ??
        new Date(runtimeCalendarNow(this.runtime));
      await this.repository.archiveReplayLog({
        matchId: docId,
        startedAt,
        endedAt: new Date(runtimeCalendarNow(this.runtime)),
        ruleSet: this.presetId,
        rulesFamily: this.kernel.view.ruleSet.rulesFamily,
        ...(this.kernel.view.ruleSet.playerCount === 3 ||
        this.kernel.view.ruleSet.rulesFamily === "mcr"
          ? { ruleSetDetails: { ...this.kernel.view.ruleSet } }
          : {}),
        mode: this.kernel.mode,
        events: replayEvents,
        seats: finalScores.map((score) => {
          const player = this.roster.player(score.seat);
          return {
            seat: score.seat,
            userDbId: player && !player.isBot ? player.userId : undefined,
            displayName: player?.displayName ?? `Seat ${score.seat}`,
            finalScore: score.score,
            place: score.place,
          };
        }),
      });
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error("[game-server] archiveReplayLog failed (non-fatal)", error);
    }
  }
}
