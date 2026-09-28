import { describe, expect, it } from "vitest";
import {
  GameEventSchema,
  LegalActionSchema,
  SnapshotStateSchema,
} from "./messages";

function snapshotBase() {
  return {
    mySeat: 0,
    hands: [["1m"], [null], [null], [null]],
    discards: [[], [], [], []],
    melds: [[], [], [], []],
    wallRemaining: 0,
    doraIndicators: ["1z"],
    turn: 2,
    dealer: 2,
    roundWind: "S",
    roundNumber: 4,
    honba: 0,
    riichiSticks: 0,
    scores: [25000, 25000, 25000, 25000],
    riichiDeclared: [false, false, false, false],
    lastDiscard: null,
    phase: "awaiting_ryuukyoku_declarations",
  } as const;
}

describe("ryuukyoku declaration protocol", () => {
  it.each(["declare_tenpai", "declare_noten"] as const)(
    "accepts the %s legal action",
    (type) => {
      expect(LegalActionSchema.parse({ id: type, type })).toEqual({
        id: type,
        type,
      });
    }
  );

  it("preserves a public live declaration and revealed hand", () => {
    const event = GameEventSchema.parse({
      type: "ryuukyoku_declaration",
      seat: 2,
      tenpai: true,
      hand: ["1m", "2m", "3m"],
    });

    expect(event).toEqual({
      type: "ryuukyoku_declaration",
      seat: 2,
      tenpai: true,
      hand: ["1m", "2m", "3m"],
    });
  });

  it("preserves the merged East-to-North declaration order on hand_end", () => {
    const declarations = [
      { seat: 2, tenpai: true },
      { seat: 3, tenpai: false },
      { seat: 0, tenpai: true },
      { seat: 1, tenpai: false },
    ] as const;
    const event = GameEventSchema.parse({
      type: "hand_end",
      reason: "exhaustive_draw",
      tenpai: [true, false, true, false],
      declarations,
    });

    expect(
      event.type === "hand_end" ? event.declarations : undefined
    ).toEqual(declarations);
  });

  it("rejects a hand leak on a Noten declaration", () => {
    expect(
      GameEventSchema.safeParse({
        type: "ryuukyoku_declaration",
        seat: 1,
        tenpai: false,
        hand: ["1m"],
      }).success
    ).toBe(false);
  });

  it("preserves reconnect state without requiring it on old snapshots", () => {
    const declarations = [null, null, true, false] as const;
    const hands = [null, null, ["1m", "2m", "3m"], null] as const;

    expect(
      SnapshotStateSchema.parse({
        ...snapshotBase(),
        ryuukyokuDeclarations: declarations,
        ryuukyokuTenpaiHands: hands,
      })
    ).toMatchObject({
      ryuukyokuDeclarations: declarations,
      ryuukyokuTenpaiHands: hands,
    });
    expect(SnapshotStateSchema.safeParse(snapshotBase()).success).toBe(true);
  });

  it("preserves a settled exhaustive result in a reconnect snapshot", () => {
    const parsed = SnapshotStateSchema.parse({
      ...snapshotBase(),
      phase: "hand_ended",
      lastHandResult: {
        type: "hand_end",
        reason: "exhaustive_draw",
        tenpai: [true, false, true, false],
        declarations: [
          { seat: 2, tenpai: true },
          { seat: 3, tenpai: false },
          { seat: 0, tenpai: true },
          { seat: 1, tenpai: false },
        ],
        tenpaiHands: [["1m"], null, ["3m"], null],
      },
    });

    expect(parsed.lastHandResult?.declarations).toHaveLength(4);
  });

  it("rejects an incomplete merged declaration list", () => {
    expect(
      GameEventSchema.safeParse({
        type: "hand_end",
        reason: "exhaustive_draw",
        declarations: [{ seat: 0, tenpai: true }],
      }).success
    ).toBe(false);
  });
});
