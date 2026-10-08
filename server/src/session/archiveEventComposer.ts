import { type SeatValues } from "~/game/protocol/seat";
import type { GameEvent, Seat } from "~/game/protocol/messages";
import { type Tile } from "~/game/rules";

import type { MatchKernel, MatchStateView } from "./matchKernel";
export interface ArchiveEventPort {
  state(): MatchStateView;
  readonly kernel: Pick<MatchKernel, "drawQueuesForArchive" | "handWaits">;
}

export class ArchiveEventComposer {
  private handStartLiveWall: Tile[] | null = null;
  wall(): Tile[] | null {
    return this.handStartLiveWall === null ? null : [...this.handStartLiveWall];
  }
  restoreWall(wall: readonly Tile[] | null): void {
    this.handStartLiveWall = wall === null ? null : [...wall];
  }

  constructor(private readonly port: ArchiveEventPort) {}
  enrichForArchive(event: GameEvent): GameEvent {
    if (event.type === "hand_start") {
      const liveWall = [...this.port.state().liveWall];
      const deadWall = [...this.port.state().deadWall];
      const duplicateDrawQueues = this.port.kernel.drawQueuesForArchive();
      // Cache for mid-hand spectator snapshots. `state.liveWall`
      // at hand_start time is the full 70-tile starting wall (no
      // draws have happened yet for this hand).
      this.handStartLiveWall = duplicateDrawQueues === null ? liveWall : null;
      return {
        ...event,
        startingHands: this.port.state().hands.map((h) => [...h]) as SeatValues<
          Tile[]
        >,
        ...(duplicateDrawQueues === null
          ? {
              // Omniscient live wall in draw order — 70 tiles remaining
              // after the initial 4×13 deal. Used by replay clients for
              // the `showWalls` overlay; duplicate hands instead archive
              // their four independent queues below.
              liveWall,
            }
          : { duplicateDrawQueues }),
        // Fixed 14-tile snapshot in protocol yama-index order.
        // Replay Show walls uses it for rinshan, dora, ura-dora,
        // and kan-indicator positions.
        deadWall,
      };
    }
    if (event.type === "hand_end") {
      // Per-seat wait tiles at hand end. Computed against each
      // seat's concealed hand via the rules engine; mirrors the
      // same `waits()` predicate the engine uses for
      // tenpai-payment detection at exhaustive draw. Seats not
      // in tenpai get `null`. Used by replay clients for the
      // `showWaits` overlay so the renderer doesn't have to
      // recompute (and can stay consistent with whatever waits
      // the platform recorded).
      const declaredTenpai =
        event.reason === "exhaustive_draw"
          ? this.port.state().lastHandResult?.tenpai
          : null;
      const seatWaits: (Tile[] | null)[] = this.port
        .state()
        .hands.map((h, seat) => {
          if (declaredTenpai !== null && declaredTenpai?.[seat] !== true) {
            return null;
          }
          const w = this.port.kernel.handWaits(seat as Seat);
          return w.length > 0 ? w : null;
        });
      return {
        ...event,
        waits: seatWaits as SeatValues<Tile[] | null>,
      };
    }
    return event;
  }
}
