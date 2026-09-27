import type { ServerMessage } from "~/game/protocol/messages";
import type { MatchProcess } from "./match";

type Send = (message: ServerMessage) => void;

export type PlayerConnectionCloseResult =
  | { kind: "stale" }
  | { kind: "waiting_released"; seat: 0 | 1 | 2 | 3 }
  | { kind: "detached"; seat: 0 | 1 | 2 | 3 };

export function closePlayerConnection(
  match: MatchProcess,
  send: Send
): PlayerConnectionCloseResult {
  const seat = match.humanSeatFor(send);
  if (seat === null) {
    return { kind: "stale" };
  }
  if (match.status === "waiting") {
    match.releaseSeat(seat);
    return { kind: "waiting_released", seat };
  }
  if (!match.detachHuman(seat, send)) {
    return { kind: "stale" };
  }
  return { kind: "detached", seat };
}
