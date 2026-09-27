import { describe, expect, it } from "vitest";
import { liveRoomAction, reconnectMatchPath } from "./lobby";

describe("web lobby active-match actions", () => {
  it("offers reconnect only for the authenticated user's playing match", () => {
    expect(liveRoomAction("playing", "mine", "mine")).toBe("reconnect");
    expect(liveRoomAction("playing", "other", "mine")).toBe("watch");
    expect(liveRoomAction("waiting", "mine", "mine")).toBeNull();
    expect(liveRoomAction("waiting", "mine", null)).toBe("join");
  });

  it("builds an explicit one-shot takeover link", () => {
    expect(reconnectMatchPath("room / 1")).toBe(
      "/game/room%20%2F%201?takeover=1"
    );
  });
});
