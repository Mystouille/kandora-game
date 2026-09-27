import { describe, expect, it } from "vitest";
import type { ServerMessage } from "~/game/protocol/messages";
import { MatchProcess } from "./match";
import { closePlayerConnection } from "./playerConnectionLifecycle";
import { ephemeralMatchRepository } from "./repository";

const dependencies = { repository: ephemeralMatchRepository };
const send = (_message: ServerMessage): void => undefined;

describe("player connection close lifecycle", () => {
  it("releases a waiting-room seat immediately", () => {
    const match = MatchProcess.createWaitingRoom("waiting", 1, dependencies);
    const seat = match.claimSeat("user-1", "Alice");
    if (seat === null) {
      throw new Error("expected a waiting-room seat");
    }
    match.attachHuman(seat, send, undefined, {
      clientSessionId: "waiting-session-1234",
    });

    expect(closePlayerConnection(match, send)).toEqual({
      kind: "waiting_released",
      seat,
    });
    expect(match.humanSeatForUser("user-1")).toBeNull();
  });

  it("detaches but preserves a playing seat", async () => {
    const match = new MatchProcess(
      "playing",
      2,
      [
        { userId: "user-1", displayName: "Alice", isBot: false },
        { userId: "bot-1", displayName: "Bot 1", isBot: true },
        { userId: "bot-2", displayName: "Bot 2", isBot: true },
        { userId: "bot-3", displayName: "Bot 3", isBot: true },
      ],
      dependencies
    );
    match.attachHuman(0, send, undefined, {
      clientSessionId: "playing-session-1234",
    });
    await match.start();

    expect(closePlayerConnection(match, send)).toEqual({
      kind: "detached",
      seat: 0,
    });
    expect(match.humanSeatForUser("user-1")).toBe(0);
    expect(match.isHumanConnected(0)).toBe(false);
  });
});
