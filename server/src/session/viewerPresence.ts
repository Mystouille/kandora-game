import type {
  Seat,
  ServerMessage,
  ViewerPresence,
} from "~/game/protocol/messages";
import type { Send } from "./playerConnections";
import type { MatchPlayerInit } from "./roomRoster";

export class MatchViewerPresence {
  private readonly viewers = new Map<Send, ViewerPresence>();

  attach(send: Send, viewer: ViewerPresence): void {
    this.viewers.set(send, { ...viewer, role: "spectator" });
  }

  detach(send: Send): void {
    this.viewers.delete(send);
  }

  build(
    players: ReadonlyMap<Seat, Readonly<MatchPlayerInit> | null>
  ): Extract<ServerMessage, { type: "viewer_state" }> {
    const seatedUserIds = new Set<string>();
    for (const player of players.values()) {
      if (player !== null && !player.isBot) {
        seatedUserIds.add(player.userId);
      }
    }
    const byUserId = new Map<string, ViewerPresence>();
    for (const viewer of this.viewers.values()) {
      if (seatedUserIds.has(viewer.userId)) {
        continue;
      }
      const current = byUserId.get(viewer.userId);
      const currentDelayMs = current?.delayMs ?? 0;
      const nextDelayMs = viewer.delayMs ?? 0;
      if (current === undefined || (currentDelayMs > 0 && nextDelayMs === 0)) {
        byUserId.set(viewer.userId, viewer);
      }
    }
    const viewers = [...byUserId.values()].sort((left, right) => {
      const leftDelayed = (left.delayMs ?? 0) > 0;
      const rightDelayed = (right.delayMs ?? 0) > 0;
      if (leftDelayed !== rightDelayed) {
        return leftDelayed ? 1 : -1;
      }
      return left.displayName.localeCompare(right.displayName);
    });
    return { type: "viewer_state", viewers };
  }
}
