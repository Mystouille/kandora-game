import { afterEach, describe, expect, it } from "vitest";
import type { GameEvent, Seat } from "../protocol/messages";
import { parseTileList } from "../client/debugSeed";
import { useMatchStore } from "../client/store";
import { seatValues } from "../rules/seats";
import { applyReplayEvent, initialView, replayViewToMatchView } from "./player";

const seats = [0, 1, 2, 3].map((seat) => ({
  seat: seat as 0 | 1 | 2 | 3,
  userId: String(seat),
  displayName: `Player ${seat + 1}`,
}));

const startingHand = parseTileList("123789m123p1239s").tiles;

function openingHand(
  dealer: Seat,
  firstDraw: string
): Extract<GameEvent, { type: "hand_start" }> {
  return {
    type: "hand_start",
    rulesFamily: "mcr",
    round: dealer,
    dealer,
    roundWind: "E",
    roundNumber: dealer + 1,
    startingHands: seatValues(4, (seat) =>
      seat === dealer ? [...startingHand, firstDraw] : [...startingHand]
    ),
    doraIndicators: [],
  };
}

afterEach(() => useMatchStore.getState().reset());

describe("MCR replay folding", () => {
  it("keeps live and replay names aligned after a round seat change", () => {
    const names = ["Player 2", "Player 1", "Player 4", "Player 3"] as const;
    const matchStart: GameEvent = {
      type: "match_start",
      rulesFamily: "mcr",
      seats,
      ruleSet: "mcr-ema",
    };
    const handStart: GameEvent = {
      ...openingHand(0, "5p"),
      round: 4,
      roundWind: "S",
      roundNumber: 1,
      scores: [200, 100, 400, 300],
      seatNames: [...names],
    };

    useMatchStore.getState().setMatch("mcr-seat-change", 1);
    useMatchStore.getState().applyEvent(matchStart, 0);
    useMatchStore.getState().applyEvent(handStart, 1);

    const replay = applyReplayEvent(
      applyReplayEvent(initialView(), matchStart),
      handStart
    );
    expect(useMatchStore.getState().seatNames).toEqual(names);
    expect(replay.seatNames).toEqual(names);
    expect(
      replayViewToMatchView(replay, {
        index: 1,
        seatNames: ["stale 0", "stale 1", "stale 2", "stale 3"],
      }).seatNames
    ).toEqual(names);
  });

  it.each([
    { playerCount: 4, sanmaType: "online" },
    { playerCount: 3, sanmaType: "online" },
    { playerCount: 3, sanmaType: "kansai" },
  ] as const)(
    "waits for a separate draw in $playerCount-player $sanmaType Riichi",
    ({ playerCount, sanmaType }) => {
      const hand = parseTileList("123789p123789s1z").tiles;
      const event: GameEvent = {
        type: "hand_start",
        rulesFamily: "riichi",
        playerCount,
        sanmaType,
        round: 0,
        dealer: 0,
        startingHands: seatValues(playerCount, () => [...hand]),
        hand,
        doraIndicators: ["1z"],
      };
      useMatchStore.getState().setMatch("riichi-opening", 0);
      useMatchStore.getState().applyEvent(event, 1);
      const replay = applyReplayEvent(initialView(), event);
      expect(useMatchStore.getState().freshlyDrawnSeat).toBeNull();
      expect(replay.freshlyDrawnSeat).toBeNull();
      expect(useMatchStore.getState().hands[0]).toHaveLength(13);
      const draw: GameEvent = {
        type: "draw",
        seat: 0,
        tile: "1z",
        wallRemaining: 50,
      };
      useMatchStore.getState().applyEvent(draw, 2);
      expect(useMatchStore.getState().freshlyDrawnSeat).toBe(0);
      expect(applyReplayEvent(replay, draw).freshlyDrawnSeat).toBe(0);
    }
  );

  it.each([0, 1, 2, 3] as const)(
    "recognizes seat %i's opening draw for players, spectators, and replays",
    (dealer) => {
      const event = openingHand(dealer, "5p");
      const replay = applyReplayEvent(initialView(), event);
      expect(replay.freshlyDrawnSeat).toBe(dealer);
      expect(replayViewToMatchView(replay, { index: 0 }).freshlyDrawnSeat).toBe(
        dealer
      );
      for (const mySeat of [0, 1, 2, 3, null] as const) {
        useMatchStore.getState().setMatch("mcr-opening", mySeat);
        useMatchStore.getState().applyEvent(
          {
            ...event,
            hand:
              mySeat === null
                ? undefined
                : mySeat === dealer
                  ? [...startingHand, "5p"]
                  : [...startingHand],
          },
          1
        );
        expect(useMatchStore.getState().freshlyDrawnSeat).toBe(dealer);
        expect(useMatchStore.getState().hands[dealer]).toHaveLength(14);
      }
    }
  );

  it.each(["5p", "9s"])(
    "removes opening %s exactly once from live and replay hands",
    (firstDraw) => {
      const start = openingHand(0, firstDraw);
      useMatchStore.getState().setMatch("mcr-discard", 0);
      useMatchStore
        .getState()
        .applyEvent({ ...start, hand: [...startingHand, firstDraw] }, 1);
      let replay = applyReplayEvent(initialView(), start);
      const discard: GameEvent = {
        type: "discard",
        seat: 0,
        tile: firstDraw,
        tsumogiri: true,
        discardSource: "draw",
      };
      useMatchStore.getState().applyEvent(discard, 2);
      replay = applyReplayEvent(replay, discard);
      expect(useMatchStore.getState().hands[0]).toEqual(startingHand);
      expect(replay.hands[0]).toEqual(startingHand);
      expect(useMatchStore.getState().discards[0]).toEqual([firstDraw]);
      expect(replay.discards[0]).toEqual([firstDraw]);
      expect(useMatchStore.getState().freshlyDrawnSeat).toBeNull();
      expect(replay.freshlyDrawnSeat).toBeNull();

      const draw: GameEvent = {
        type: "draw",
        seat: 0,
        tile: "2z",
        wallRemaining: 85,
      };
      const handDiscard: GameEvent = {
        type: "discard",
        seat: 0,
        tile: "9s",
        tsumogiri: false,
        discardSource: "hand",
      };
      useMatchStore.getState().applyEvent(draw, 3);
      useMatchStore.getState().applyEvent(handDiscard, 4);
      replay = applyReplayEvent(applyReplayEvent(replay, draw), handDiscard);
      const remaining = [...startingHand.slice(0, -1), "2z"];
      expect(useMatchStore.getState().hands[0]).toEqual(remaining);
      expect(replay.hands[0]).toEqual(remaining);
    }
  );

  it("tracks flowers and MCR score details in the neutral replay view", () => {
    const events: GameEvent[] = [
      {
        type: "match_start",
        rulesFamily: "mcr",
        seats,
        ruleSet: "mcr-ema",
      },
      {
        type: "hand_start",
        rulesFamily: "mcr",
        round: 0,
        dealer: 0,
        roundWind: "E",
        roundNumber: 1,
        flowerTiles: [[], [], [], []],
        startingHands: [
          Array.from({ length: 14 }, () => "1m"),
          Array.from({ length: 13 }, () => "2m"),
          Array.from({ length: 13 }, () => "3m"),
          Array.from({ length: 13 }, () => "4m"),
        ],
        doraIndicators: [],
      },
      { type: "draw", seat: 1, tile: "1f", wallRemaining: 90 },
      { type: "flower", seat: 1, tile: "1f" },
      {
        type: "draw",
        seat: 1,
        tile: "5m",
        wallRemaining: 89,
        replacementKind: "flower",
        fromDeadWall: false,
      },
      {
        type: "win",
        seat: 1,
        loser: 0,
        winTile: "1m",
        scoringFamily: "mcr",
        totalFan: 89,
        nonFlowerFan: 88,
        fan: [
          {
            id: "THIRTEEN_ORPHANS",
            name: "Thirteen Orphans",
            count: 1,
            points: 88,
          },
          {
            id: "FLOWER_TILES",
            name: "Flower Tiles",
            count: 1,
            points: 1,
          },
        ],
      },
      {
        type: "hand_end",
        reason: "ron",
        delta: [-97, 113, -8, -8],
      },
    ];

    let view = initialView({ rulesFamily: "mcr", playerCount: 4 });
    for (const event of events) {
      view = applyReplayEvent(view, event);
    }

    expect(view.rulesFamily).toBe("mcr");
    expect(view.flowerTiles[1]).toEqual(["1f"]);
    expect(view.lastHandResult?.wins?.[0]).toMatchObject({
      scoringFamily: "mcr",
      totalFan: 89,
      nonFlowerFan: 88,
    });
    expect(
      replayViewToMatchView(view, { index: events.length - 1 }).rulesFamily
    ).toBe("mcr");
  });
});
