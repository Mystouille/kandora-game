import { describe, expect, it } from "vitest";
import { ClientMessageSchema, GameEventSchema } from "./messages";
import { SANMA_CAPABILITY, SanmaWallStateSchema } from "./sanma";

describe("sanma wire contracts", () => {
  it("preserves the parsed shape of a legacy four-player start", () => {
    const event = {
      type: "match_start",
      ruleSet: "m-league",
      seats: [0, 1, 2, 3].map((seat) => ({
        seat,
        userId: `user-${seat}`,
        displayName: `Player ${seat}`,
      })),
    };
    expect(GameEventSchema.parse(event)).toEqual(event);
  });

  it.each(["declared", "completed"] as const)(
    "carries a public nuki %s without hidden replacement data",
    (stage) => {
      expect(
        GameEventSchema.parse({ type: "nuki", seat: 2, tile: "4z", stage })
      ).toEqual({ type: "nuki", seat: 2, tile: "4z", stage });
      expect(
        GameEventSchema.safeParse({ type: "nuki", seat: 2, tile: "1p", stage })
          .success
      ).toBe(false);
    }
  );

  it("preserves opening replacement cause independently of physical source", () => {
    const event = {
      type: "draw",
      seat: 1,
      tile: "3p",
      wallRemaining: 59,
      fromDeadWall: true,
      replacementKind: "nuki",
      opening: true,
      sanmaWall: {
        sanmaType: "kansai",
        mode: "duplicate",
        replacementsTaken: 1,
        kanCount: 0,
      },
    };
    expect(GameEventSchema.parse(event)).toEqual(event);
    expect(
      SanmaWallStateSchema.safeParse({
        sanmaType: "kansai",
        mode: "standard",
        replacementsTaken: 5,
        kanCount: 0,
      }).success
    ).toBe(false);
  });

  it("negotiates sanma independently of timing capability", () => {
    expect(
      ClientMessageSchema.parse({
        type: "hello",
        token: "test",
        matchId: "test",
        gameCapabilities: [SANMA_CAPABILITY],
      })
    ).toMatchObject({ gameCapabilities: ["sanma-v1"] });
  });
});
