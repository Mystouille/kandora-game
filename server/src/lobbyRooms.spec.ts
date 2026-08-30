import { describe, expect, it } from "vitest";

import { listLobbyRoomSummaries } from "./lobbyRooms";
import { MatchProcess } from "./match";
import { ephemeralMatchRepository } from "./repository";

describe("listLobbyRoomSummaries", () => {
  it("includes native rooms and hides Tenhou relay matches", () => {
    const nativeRoom = MatchProcess.createWaitingRoom(
      "native-room",
      42,
      { repository: ephemeralMatchRepository }
    );
    const tenhouRelay = MatchProcess.createRelayMatch(
      "relay-room",
      "0E342071",
      { repository: ephemeralMatchRepository },
      "tenhou"
    );

    expect(listLobbyRoomSummaries([nativeRoom, tenhouRelay])).toEqual([
      nativeRoom.summary(),
    ]);
  });
});