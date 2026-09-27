import { describe, expect, it } from "vitest";
import { MatchProcess, setNextHandDelayMs } from "./match";
import { ephemeralMatchRepository } from "./repository";
import {
  findActiveMatchForUser,
  MultipleActiveMatchesError,
} from "./activeMatches";

function playingMatch(matchId: string, userId: string): MatchProcess {
  const match = new MatchProcess(
    matchId,
    1,
    [
      { userId, displayName: "Human", isBot: false },
      { userId: `${matchId}-bot-1`, displayName: "Bot 1", isBot: true },
      { userId: `${matchId}-bot-2`, displayName: "Bot 2", isBot: true },
      { userId: `${matchId}-bot-3`, displayName: "Bot 3", isBot: true },
    ],
    { repository: ephemeralMatchRepository }
  );
  match.attachHuman(0, () => undefined);
  return match;
}

describe("active match lookup", () => {
  it("returns only a playing match belonging to the user", async () => {
    setNextHandDelayMs(0);
    const waiting = MatchProcess.createWaitingRoom("waiting", 2, {
      repository: ephemeralMatchRepository,
    });
    waiting.claimSeat("user-1", "Human");
    const playing = playingMatch("playing", "user-1");
    await playing.start();

    expect(findActiveMatchForUser([waiting, playing], "user-1")).toEqual({
      matchId: "playing",
      status: "playing",
      connected: true,
    });
  });

  it("can exclude the target match when enforcing cross-room uniqueness", async () => {
    setNextHandDelayMs(0);
    const playing = playingMatch("playing", "user-1");
    await playing.start();

    expect(findActiveMatchForUser([playing], "user-1", "playing")).toBeNull();
  });

  it("raises an explicit invariant error instead of choosing a match", async () => {
    setNextHandDelayMs(0);
    const first = playingMatch("first", "user-1");
    const second = playingMatch("second", "user-1");
    await first.start();
    await second.start();

    expect(() => findActiveMatchForUser([first, second], "user-1")).toThrow(
      MultipleActiveMatchesError
    );
  });
});
