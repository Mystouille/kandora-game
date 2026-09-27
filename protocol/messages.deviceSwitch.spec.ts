import { describe, expect, it } from "vitest";
import { ClientMessageSchema, ServerMessageSchema } from "./messages";

describe("device-switching protocol", () => {
  it("accepts a bounded player session identifier and takeover flag", () => {
    expect(
      ClientMessageSchema.parse({
        type: "hello",
        token: "token",
        matchId: "match-1",
        clientSessionId: "destination-session-123",
        takeover: true,
      })
    ).toMatchObject({
      clientSessionId: "destination-session-123",
      takeover: true,
    });
  });

  it("rejects malformed client session identifiers", () => {
    expect(
      ClientMessageSchema.safeParse({
        type: "hello",
        token: "token",
        matchId: "match-1",
        clientSessionId: "spaces are invalid",
      }).success
    ).toBe(false);
  });

  it("validates the terminal replacement message", () => {
    expect(
      ServerMessageSchema.parse({
        type: "session_replaced",
        matchId: "match-1",
        message: "Game resumed on another device.",
      })
    ).toEqual({
      type: "session_replaced",
      matchId: "match-1",
      message: "Game resumed on another device.",
    });
  });
});
