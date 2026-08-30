import type { MatchProcess } from "./match";

export function listLobbyRoomSummaries(
  matches: Iterable<MatchProcess>
): Array<ReturnType<MatchProcess["summary"]>> {
  const rooms: Array<ReturnType<MatchProcess["summary"]>> = [];
  for (const match of matches) {
    if (match.status === "finished" || match.isRelay) {
      continue;
    }
    rooms.push(match.summary());
  }
  return rooms;
}