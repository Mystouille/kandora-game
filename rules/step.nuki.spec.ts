import { describe, expect, it } from "vitest";
import type { SanmaType } from "../protocol/seat";
import type { Action } from "./actions";
import {
  canDeclareNuki,
  getPendingRobbery,
  isNukiTile,
  nextAutomaticNuki,
} from "./nuki";
import { scoreHand } from "./score";
import { handScoringContext } from "./scoringContext";
import { activeSeats } from "./seats";
import { createInitialState, MatchStateSchema, type MatchState } from "./state";
import { step, type EngineEvent, type StepResult } from "./step";
import type { Seat, Tile } from "./types";
import { takeSanmaReplacement } from "./wallTransitions";

function tiles(shorthand: string): Tile[] {
  const result: Tile[] = [];
  let digits = "";
  for (const character of shorthand) {
    if (character >= "0" && character <= "9") {
      digits += character;
    } else {
      for (const digit of digits) {
        result.push(`${digit}${character}`);
      }
      digits = "";
    }
  }
  return result;
}

const FILLER = tiles("19m147p258s12356z");
const NORTH_WAIT = tiles("123p123789s5554z");
const REPLACEMENT_WAIT = tiles("123p123789s5557z");
const NO_YAKU_NORTH_WAIT = tiles("123p234789s4z");

function nukiState(
  sanmaType: SanmaType = "online",
  duplicate = false,
  seat: Seat = 0
): MatchState {
  const state = createInitialState(42, {
    ruleSet: { playerCount: 3, sanmaType },
    wall: { duplicate },
  });
  state.hands = activeSeats(3).map(() => [...FILLER]);
  state.discards = [["9m"], ["9m"], ["9m"]];
  state.liveWall = tiles("123456789p123456789s");
  state.deadWall = [
    ...tiles("12345678s"),
    "1z",
    "2z",
    ...(sanmaType === "online" || duplicate ? tiles("3567z") : []),
  ];
  state.doraIndicators = [state.deadWall[duplicate ? 4 : 8]];
  state.uraDoraIndicators = [state.deadWall[duplicate ? 5 : 9]];
  const tile: Tile = sanmaType === "online" ? "4z" : "5m";
  state.hands[seat].push(tile);
  state.lastDrawn[seat] = tile;
  state.turn = seat;
  state.phase = "awaiting_discard";
  return state;
}

function setReplacement(state: MatchState, tile: Tile): void {
  if (state.sanmaWall?.mode === "duplicate") {
    state.liveWall[0] = tile;
  } else {
    state.deadWall[0] = tile;
  }
}

function declareNuki(state: MatchState): StepResult {
  const result = step(state, {
    type: "nuki",
    seat: state.turn,
    tile: state.ruleSet.sanmaType === "online" ? "4z" : "5m",
  });
  expect(result.state).not.toBe(state);
  return result;
}

function completeNuki(state: MatchState): StepResult {
  return step(state, {
    type: "complete_nuki",
    ...(state.sanmaWall?.mode === "duplicate"
      ? { replacementTile: state.liveWall[0] }
      : {}),
  });
}

function expectRejected(state: MatchState, action: Action): void {
  const before = structuredClone(state);
  const result = step(state, action);
  expect(result.state).toBe(state);
  expect(result.events).toEqual([]);
  expect(state).toEqual(before);
}

function winningEvent(
  result: StepResult
): Extract<EngineEvent, { type: "win" }> {
  const event = result.events.find((candidate) => candidate.type === "win");
  if (!event || event.type !== "win") {
    throw new Error("Expected a win");
  }
  return event;
}

function openNorthWait(state: MatchState, seat: Seat): void {
  state.hands[seat] = [...NO_YAKU_NORTH_WAIT];
  state.melds[seat] = [
    {
      type: "pon",
      tiles: ["1m", "1m", "1m"],
      claimedTile: "1m",
      from: 0,
    },
  ];
}

function physicalTiles(state: MatchState): Tile[] {
  return [
    ...state.hands.flat(),
    ...state.discards.flat(),
    ...state.melds.flatMap((melds) => melds.flatMap((meld) => meld.tiles)),
    ...state.nukiTiles.flat(),
    ...state.liveWall,
    ...state.deadWall,
    ...(state.pendingNuki && state.ruleSet.sanmaType === "online"
      ? [state.pendingNuki.tile]
      : []),
  ].sort();
}

describe("Online North nuki", () => {
  it("declares before committing the tile or any replacement resources", () => {
    const state = nukiState();
    state.ippatsuEligible = [true, true, true];
    state.doubleRiichi = [true, true, false];
    const before = structuredClone(state);
    const result = declareNuki(state);
    expect(result.events).toEqual([
      { type: "nuki", seat: 0, tile: "4z", stage: "declared" },
    ]);
    expect(result.state.phase).toBe("awaiting_chankan");
    expect(result.state.pendingNuki).toEqual({
      seat: 0,
      tile: "4z",
      opening: false,
    });
    expect(result.state.pendingShouminkan).toBeNull();
    expect(getPendingRobbery(result.state)).toEqual({
      kind: "nuki",
      seat: 0,
      tile: "4z",
      opening: false,
    });
    expect(result.state.hands[0]).toEqual(FILLER);
    expect(result.state.lastDrawn[0]).toBeNull();
    expect(result.state.nukiTiles).toEqual([[], [], []]);
    expect(result.state.ippatsuEligible).toEqual([false, false, false]);
    expect(result.state.doubleRiichi).toEqual(state.doubleRiichi);
    expect(result.state.liveWall).toEqual(state.liveWall);
    expect(result.state.deadWall).toEqual(state.deadWall);
    expect(result.state.sanmaWall).toEqual(state.sanmaWall);
    expect(physicalTiles(result.state)).toEqual(physicalTiles(state));
    expect(MatchStateSchema.parse(result.state)).toEqual(result.state);
    expect(state).toEqual(before);
  });

  it.each([false, true])(
    "commits once and replaces without kan dora, Duplicate=%s",
    (duplicate) => {
      const state = nukiState("online", duplicate);
      setReplacement(state, "7z");
      const declared = declareNuki(state).state;
      const before = structuredClone(declared);
      const result = completeNuki(declared);
      expect(result.events).toEqual([
        { type: "nuki", seat: 0, tile: "4z", stage: "completed" },
        {
          type: "draw",
          seat: 0,
          tile: "7z",
          wallRemaining: state.liveWall.length - 1,
          fromDeadWall: !duplicate,
          replacementKind: "nuki",
        },
      ]);
      expect(result.state.phase).toBe("awaiting_discard");
      expect(result.state.pendingNuki).toBeNull();
      expect(getPendingRobbery(result.state)).toBeNull();
      expect(result.state.nukiTiles).toEqual([["4z"], [], []]);
      expect(result.state.hands[0]).toEqual([...FILLER, "7z"]);
      expect(result.state.lastDrawn[0]).toBe("7z");
      expect(result.state.lastDrawFromDeadWall).toBe(true);
      expect(result.state.sanmaWall).toMatchObject({
        kanCount: 0,
        replacementsTaken: 1,
      });
      expect(result.state.deadWall).toHaveLength(14);
      expect(result.state.doraIndicators).toEqual(state.doraIndicators);
      expect(result.state.uraDoraIndicators).toEqual(state.uraDoraIndicators);
      expect(result.state.melds).toEqual([[], [], []]);
      expect(physicalTiles(result.state)).toEqual(physicalTiles(state));
      expect(MatchStateSchema.parse(result.state)).toEqual(result.state);
      expect(declared).toEqual(before);
      expectRejected(result.state, { type: "complete_nuki" });
    }
  );

  it("can extract a concealed North instead of the drawn tile before riichi", () => {
    const state = nukiState();
    state.hands[0] = [...FILLER.slice(0, -1), "4z", "7p"];
    state.lastDrawn[0] = "7p";
    const result = declareNuki(state);
    expect(result.state.hands[0]).toContain("7p");
    expect(result.state.hands[0]).not.toContain("4z");
    expect(result.state.hands[0]).toHaveLength(13);
  });

  it("can keep or discard North rather than extracting it", () => {
    const state = nukiState();
    expect(nextAutomaticNuki(state)).toBeNull();
    const result = step(state, { type: "discard", seat: 0, tile: "4z" });
    expect(result.state.discards[0].at(-1)).toBe("4z");
    expect(result.state.nukiTiles).toEqual([[], [], []]);
  });

  it.each(["pon", "ankan", "daiminkan", "shouminkan"] as const)(
    "retains ordinary North %s use",
    (kind) => {
      const state = nukiState();
      const count =
        kind === "ankan"
          ? 4
          : kind === "shouminkan"
            ? 1
            : kind === "pon"
              ? 2
              : 3;
      state.hands[0] = [
        ...Array<Tile>(count).fill("4z"),
        ...FILLER.slice(0, kind === "pon" ? 11 : 10),
      ];
      if (kind === "pon" || kind === "daiminkan") {
        state.phase = "awaiting_draw";
        state.turn = 0;
        state.lastDrawn[0] = null;
        state.lastDiscard = { seat: 2, tile: "4z" };
        state.discards[2].push("4z");
      } else if (kind === "shouminkan") {
        state.melds[0] = [
          {
            type: "pon",
            tiles: ["4z", "4z", "4z"],
            claimedTile: "4z",
            from: 2,
          },
        ];
      }
      const result =
        kind === "pon"
          ? step(state, { type: "pon", seat: 0, tiles: ["4z", "4z"] })
          : step(state, { type: "kan", seat: 0, kind, tile: "4z" });
      expect(result.events[0]?.type).toBe("call");
      expect(result.state.melds[0][0].type).toBe(kind);
      expect(result.state.nukiTiles).toEqual([[], [], []]);
      expect(result.state.pendingNuki).toBeNull();
      if (kind === "pon") {
        expectRejected(result.state, { type: "nuki", seat: 0, tile: "4z" });
      } else if (kind === "shouminkan") {
        expect(getPendingRobbery(result.state)).toEqual({
          kind: "shouminkan",
          seat: 0,
          tile: "4z",
          ponIdx: 0,
        });
      }
    }
  );

  it("permits four successive North extractions on replacement draws", () => {
    let state = nukiState();
    state.deadWall.splice(0, 4, "4z", "4z", "4z", "7z");
    const before = physicalTiles(state);
    for (let index = 0; index < 4; index++) {
      state = completeNuki(declareNuki(state).state).state;
      expect(state.hands[0]).toHaveLength(14);
      expect(state.nukiTiles[0]).toHaveLength(index + 1);
      expect(state.sanmaWall).toMatchObject({
        replacementsTaken: index + 1,
        kanCount: 0,
      });
    }
    expect(state.nukiTiles[0]).toEqual(["4z", "4z", "4z", "4z"]);
    expect(state.lastDrawn[0]).toBe("7z");
    expect(physicalTiles(state)).toEqual(before);
  });

  it("after riichi extracts only the drawn North and preserves the locked hand", () => {
    const state = nukiState();
    const lockedHand = [...FILLER.slice(0, -1), "4z"] as Tile[];
    state.hands[0] = [...lockedHand, "4z"];
    state.riichiDeclared[0] = true;
    state.doubleRiichi[0] = true;
    state.ippatsuEligible[0] = true;
    state.deadWall.splice(0, 2, "4z", "7z");
    const declared = declareNuki(state).state;
    expect(declared.hands[0]).toEqual(lockedHand);
    expect(declared.riichiDeclared[0]).toBe(true);
    expect(declared.doubleRiichi[0]).toBe(true);
    expect(declared.ippatsuEligible[0]).toBe(false);
    const firstReplacement = completeNuki(declared).state;
    expect(firstReplacement.lastDrawn[0]).toBe("4z");
    const secondDeclaration = declareNuki(firstReplacement).state;
    expect(secondDeclaration.hands[0]).toEqual(lockedHand);
    const completed = completeNuki(secondDeclaration).state;
    expectRejected(completed, { type: "nuki", seat: 0, tile: "4z" });
    expectRejected(completed, { type: "discard", seat: 0, tile: "4z" });
    expect(
      step(completed, { type: "discard", seat: 0, tile: "7z" }).events[0]?.type
    ).toBe("discard");
  });

  it.each([
    [
      "wrong turn",
      (state: MatchState) => {
        state.turn = 1;
      },
    ],
    [
      "not a draw turn",
      (state: MatchState) => {
        state.phase = "awaiting_draw";
      },
    ],
    [
      "after a pon",
      (state: MatchState) => {
        state.lastDrawn[0] = null;
      },
    ],
    [
      "North absent",
      (state: MatchState) => {
        state.hands[0][13] = "7z";
      },
    ],
    [
      "locked concealed North",
      (state: MatchState) => {
        state.riichiDeclared[0] = true;
        state.hands[0] = [...FILLER.slice(0, -1), "4z", "7z"];
        state.lastDrawn[0] = "7z";
      },
    ],
    [
      "empty live reserve",
      (state: MatchState) => {
        state.liveWall = [];
      },
    ],
    [
      "invalid reserve",
      (state: MatchState) => {
        state.deadWall.pop();
      },
    ],
    [
      "four extracted tiles",
      (state: MatchState) => {
        state.nukiTiles[1] = ["4z", "4z", "4z", "4z"];
      },
    ],
  ] as const)("rejects %s without mutation", (_name, change) => {
    const state = nukiState();
    change(state);
    expect(canDeclareNuki(state, { type: "nuki", seat: 0, tile: "4z" })).toBe(
      false
    );
    expectRejected(state, { type: "nuki", seat: 0, tile: "4z" });
  });

  it.each([
    { type: "nuki", seat: 3, tile: "4z" },
    { type: "nuki", seat: 0, tile: "5m" },
    { type: "nuki", seat: 0, tile: "4z", opening: true },
    { type: "complete_nuki" },
  ] satisfies Action[])("rejects stale or invalid action %j", (action) => {
    expectRejected(nukiState(), action);
  });

  it("rejects nuki entirely in four-player games", () => {
    const state = createInitialState(42);
    state.phase = "awaiting_discard";
    state.hands[0].push("4z");
    state.lastDrawn[0] = "4z";
    expectRejected(state, { type: "nuki", seat: 0, tile: "4z" });
    expect(nextAutomaticNuki(state, true)).toBeNull();
  });
});

describe("North robbery and furiten", () => {
  it.each([false, true])(
    "awards chankan even when it is the only yaku, Duplicate=%s",
    (duplicate) => {
      const state = nukiState("online", duplicate);
      openNorthWait(state, 1);
      expect(
        scoreHand({
          ...handScoringContext(state, 1),
          hand: state.hands[1],
          winTile: "4z",
          tsumo: false,
        }).han
      ).toBe(0);
      const declared = declareNuki(state).state;
      const result = step(declared, { type: "ron", seat: 1 });
      const win = winningEvent(result);
      expect(win).toMatchObject({ winner: 1, loser: 0, winTile: "4z" });
      expect(win.score.han).toBe(1);
      expect(
        Object.keys(win.score.yaku).some((name) =>
          /搶槓|槍槓|chankan/i.test(name)
        )
      ).toBe(true);
      expect(result.state.phase).toBe("hand_ended");
      expect(result.state.nukiTiles).toEqual([[], [], []]);
      expect(result.state.pendingNuki).toEqual(declared.pendingNuki);
      expect(getPendingRobbery(result.state)).toBeNull();
      expect(result.state.liveWall).toEqual(state.liveWall);
      expect(result.state.deadWall).toEqual(state.deadWall);
      expect(result.state.doraIndicators).toEqual(state.doraIndicators);
      expect(result.state.sanmaWall).toEqual(state.sanmaWall);
      expect(physicalTiles(result.state)).toEqual(physicalTiles(state));
      expect(MatchStateSchema.parse(result.state)).toEqual(result.state);
      expectRejected(result.state, { type: "complete_nuki" });
      expectRejected(declared, { type: "complete_shouminkan" });
    }
  );

  it("accepts simultaneous ron and gives deposits only to the head winner", () => {
    const state = nukiState();
    openNorthWait(state, 1);
    openNorthWait(state, 2);
    state.riichiSticks = 2;
    const result = step(declareNuki(state).state, {
      type: "ron",
      seat: 1,
      additionalWinners: [2],
    });
    expect(result.events.map((event) => event.type)).toEqual([
      "win",
      "win",
      "hand_end",
    ]);
    expect(result.state.lastHandResult?.delta).toHaveLength(3);
    expect(
      result.state.lastHandResult?.delta.reduce((sum, delta) => sum + delta, 0)
    ).toBe(2000);
    expect(
      result.state.lastHandResult!.delta[1] -
        result.state.lastHandResult!.delta[2]
    ).toBe(2000);
    expect(result.state.riichiSticks).toBe(0);
    expect(result.state.nukiTiles).toEqual([[], [], []]);
  });

  it.each(["furitenLocked", "furitenTemp", "own discard"] as const)(
    "applies %s even to a chankan-only hand",
    (kind) => {
      const state = nukiState();
      openNorthWait(state, 1);
      if (kind === "own discard") {
        state.discards[1].push("4z");
      } else {
        state[kind][1] = true;
      }
      expectRejected(declareNuki(state).state, { type: "ron", seat: 1 });
    }
  );

  it("rejects a self-ron, missing agari and invalid multi-ron without resource use", () => {
    const state = nukiState();
    state.hands[1] = [...NORTH_WAIT];
    const declared = declareNuki(state).state;
    for (const action of [
      { type: "ron", seat: 0 },
      { type: "ron", seat: 2 },
      { type: "ron", seat: 1, additionalWinners: [1] },
      { type: "ron", seat: 1, additionalWinners: [3] },
    ] satisfies Action[]) {
      expectRejected(declared, action);
    }
  });

  it("locks missed chankan ron temporarily or permanently before the replacement", () => {
    const state = nukiState();
    openNorthWait(state, 1);
    state.hands[2] = [...NORTH_WAIT];
    state.riichiDeclared[2] = true;
    const result = completeNuki(declareNuki(state).state);
    expect(result.state.furitenTemp).toEqual([false, true, false]);
    expect(result.state.furitenLocked).toEqual([false, false, true]);
    expect(result.furitenChanges).toContainEqual({ seat: 1, active: true });
    expect(result.furitenChanges).toContainEqual({ seat: 2, active: true });
    const discarded = step(result.state, {
      type: "discard",
      seat: 0,
      tile: result.state.lastDrawn[0]!,
    }).state;
    const drawn = step(discarded, { type: "draw", seat: 1 }).state;
    const ownDiscard = step(drawn, {
      type: "discard",
      seat: 1,
      tile: drawn.lastDrawn[1]!,
    }).state;
    expect(ownDiscard.furitenTemp[1]).toBe(false);
    expect(ownDiscard.furitenLocked[2]).toBe(true);
  });
});

describe("Kansai mandatory nuki", () => {
  it.each([false, true])(
    "leaves raw deals for deterministic opening normalization, Duplicate=%s",
    (duplicate) => {
      for (let seed = 0; seed < 16; seed++) {
        const raw = createInitialState(seed, {
          ruleSet: { playerCount: 3, sanmaType: "kansai" },
          wall: { duplicate },
        });
        expect(raw.hands.map((hand) => hand.length)).toEqual([13, 13, 13]);
        expect(raw.nukiTiles).toEqual([[], [], []]);
        expect(raw.liveWall).toHaveLength(duplicate ? 59 : 63);
        expect(raw.deadWall).toHaveLength(duplicate ? 14 : 10);
        expect(raw.sanmaWall?.replacementsTaken).toBe(0);
        const queues = [
          raw.liveWall.slice(0, 20),
          raw.liveWall.slice(20, 40),
          raw.liveWall.slice(40),
        ];
        const before = physicalTiles(raw);
        let state = raw;
        for (let count = 0; count < 4; count++) {
          const action = nextAutomaticNuki(state, true);
          if (action === null) {
            break;
          }
          const queueBefore = queues.map((queue) => [...queue]);
          const extracted = step(state, action).state;
          const result = step(extracted, {
            type: "complete_nuki",
            ...(duplicate ? { replacementTile: queues[action.seat][0] } : {}),
          });
          expect(result.events).toContainEqual(
            expect.objectContaining({
              type: "draw",
              seat: action.seat,
              replacementKind: "nuki",
              opening: true,
            })
          );
          if (duplicate) {
            queues[action.seat].shift();
            for (const other of activeSeats(3).filter(
              (seat) => seat !== action.seat
            )) {
              expect(queues[other]).toEqual(queueBefore[other]);
            }
            expect([...result.state.liveWall].sort()).toEqual(
              queues.flat().sort()
            );
          }
          state = result.state;
          expect(state.hands.map((hand) => hand.length)).toEqual([13, 13, 13]);
          expect(state.lastDrawn).toEqual([null, null, null]);
          expect(state.turn).toBe(0);
          expect(state.phase).toBe("awaiting_draw");
          expect(physicalTiles(state)).toEqual(before);
          expect(MatchStateSchema.parse(state)).toEqual(state);
        }
        expect(nextAutomaticNuki(state, true)).toBeNull();
        expect(
          state.hands.flat().some((tile) => isNukiTile(tile, state.ruleSet))
        ).toBe(false);
        expect(state.liveWall).toHaveLength(
          duplicate ? 59 - state.nukiTiles.flat().length : 63
        );
        expect(state.deadWall).toHaveLength(
          duplicate ? 14 : 10 - state.nukiTiles.flat().length
        );
      }
    }
  );

  it.each(["5m", "0m"] as const)(
    "forces extraction after an ordinary live draw of %s",
    (tile) => {
      const state = nukiState("kansai");
      state.hands[0].pop();
      state.lastDrawn[0] = null;
      state.phase = "awaiting_draw";
      state.liveWall.unshift(tile);
      const drawn = step(state, { type: "draw", seat: 0 }).state;
      expect(drawn.lastDrawn[0]).toBe(tile);
      expect(nextAutomaticNuki(drawn)).toEqual({
        type: "nuki",
        seat: 0,
        tile,
        opening: false,
      });
      expectRejected(drawn, { type: "discard", seat: 0, tile });
      const extracted = step(drawn, nextAutomaticNuki(drawn)!).state;
      expect(extracted.nukiTiles[0]).toEqual([tile]);
    }
  );

  it.each(["5m", "0m"] as const)(
    "extracts %s immediately without a robbery or interruption",
    (tile) => {
      const state = nukiState("kansai");
      state.hands[0][13] = tile;
      state.lastDrawn[0] = tile;
      state.ippatsuEligible = [true, true, true];
      state.doubleRiichi = [true, false, true];
      const before = structuredClone(state);
      const action = nextAutomaticNuki(state);
      expect(action).toEqual({ type: "nuki", seat: 0, tile, opening: false });
      const result = step(state, action!);
      expect(result.events).toEqual([
        { type: "nuki", seat: 0, tile, stage: "completed" },
      ]);
      expect(result.state.phase).toBe("awaiting_nuki_replacement");
      expect(result.state.pendingNuki).toEqual({
        seat: 0,
        tile,
        opening: false,
      });
      expect(result.state.nukiTiles).toEqual([[tile], [], []]);
      expect(result.state.hands[0]).toEqual(FILLER);
      expect(result.state.lastDrawn[0]).toBeNull();
      expect(result.state.ippatsuEligible).toEqual(state.ippatsuEligible);
      expect(result.state.doubleRiichi).toEqual(state.doubleRiichi);
      expect(result.state.deadWall).toEqual(state.deadWall);
      expect(result.state.liveWall).toEqual(state.liveWall);
      expect(getPendingRobbery(result.state)).toBeNull();
      expect(physicalTiles(result.state)).toEqual(physicalTiles(state));
      expect(MatchStateSchema.parse(result.state)).toEqual(result.state);
      expectRejected(result.state, action!);
      expectRejected(result.state, { type: "ron", seat: 1 });
      expect(state).toEqual(before);
    }
  );

  it.each([false, true])(
    "replaces once without a second pile increment, Duplicate=%s",
    (duplicate) => {
      const state = nukiState("kansai", duplicate);
      setReplacement(state, "7z");
      const extracted = declareNuki(state).state;
      const result = completeNuki(extracted);
      expect(result.events).toEqual([
        {
          type: "draw",
          seat: 0,
          tile: "7z",
          wallRemaining: state.liveWall.length - (duplicate ? 1 : 0),
          fromDeadWall: !duplicate,
          replacementKind: "nuki",
        },
      ]);
      expect(result.state.nukiTiles).toEqual([["5m"], [], []]);
      expect(result.state.phase).toBe("awaiting_discard");
      expect(result.state.pendingNuki).toBeNull();
      expect(result.state.hands[0]).toEqual([...FILLER, "7z"]);
      expect(result.state.lastDrawn[0]).toBe("7z");
      expect(result.state.lastDrawFromDeadWall).toBe(true);
      expect(result.state.deadWall).toHaveLength(duplicate ? 14 : 9);
      expect(result.state.doraIndicators).toEqual(state.doraIndicators);
      expect(physicalTiles(result.state)).toEqual(physicalTiles(state));
      expect(MatchStateSchema.parse(result.state)).toEqual(result.state);
    }
  );

  it.each([
    { type: "discard", seat: 0, tile: "5m" },
    { type: "discard", seat: 0, tile: "1m" },
    { type: "riichi", seat: 0, tile: "5m" },
    { type: "tsumo", seat: 0 },
    { type: "kan", seat: 0, kind: "ankan", tile: "1m" },
    { type: "draw", seat: 0 },
  ] satisfies Action[])(
    "blocks ordinary actions until extraction: %j",
    (action) => {
      expectRejected(nukiState("kansai"), action);
    }
  );

  it.each(["pon", "daiminkan", "ron"] as const)(
    "does not allow %s on a retained 5m",
    (kind) => {
      const state = nukiState("kansai");
      state.phase = "awaiting_draw";
      state.lastDrawn[0] = null;
      state.hands[0] = [...tiles("555m"), ...FILLER.slice(0, 10)];
      state.lastDiscard = { seat: 2, tile: "5m" };
      state.discards[2].push("5m");
      const action: Action =
        kind === "pon"
          ? { type: "pon", seat: 0, tiles: ["5m", "5m"] }
          : kind === "ron"
            ? { type: "ron", seat: 0 }
            : { type: "kan", seat: 0, kind, tile: "5m" };
      expectRejected(state, action);
    }
  );

  it("normalizes all opening hands in dealer order, including a replacement chain", () => {
    let state = nukiState("kansai");
    state.hands = activeSeats(3).map(() => [...FILLER.slice(0, -1), "5m"]);
    state.hands[1][12] = "0m";
    state.discards = [[], [], []];
    state.lastDrawn = [null, null, null];
    state.phase = "awaiting_draw";
    state.dealer = 1;
    state.turn = 1;
    state.deadWall.splice(0, 4, "5m", "7z", "8p", "8s");
    const before = physicalTiles(state);
    const initialLive = [...state.liveWall];
    const processed: Seat[] = [];
    for (let index = 0; index < 4; index++) {
      const action = nextAutomaticNuki(state, true);
      expect(action).not.toBeNull();
      processed.push(action!.seat);
      const extracted = step(state, action!).state;
      expect(extracted.hands[action!.seat]).toHaveLength(12);
      expect(extracted.turn).toBe(1);
      expect(extracted.pendingNuki?.opening).toBe(true);
      expect(MatchStateSchema.parse(extracted)).toEqual(extracted);
      const replacement = completeNuki(extracted);
      expect(replacement.events).toEqual([
        {
          type: "draw",
          seat: action!.seat,
          tile: replacement.state.hands[action!.seat].at(-1),
          wallRemaining: initialLive.length,
          fromDeadWall: true,
          replacementKind: "nuki",
          opening: true,
        },
      ]);
      state = replacement.state;
      expect(state.hands.map((hand) => hand.length)).toEqual([13, 13, 13]);
      expect(state.phase).toBe("awaiting_draw");
      expect(state.turn).toBe(1);
      expect(state.lastDrawn).toEqual([null, null, null]);
      expect(state.lastDrawFromDeadWall).toBe(false);
      expect(state.liveWall).toEqual(initialLive);
      expectRejected(state, { type: "tsumo", seat: action!.seat });
    }
    expect(processed).toEqual([1, 1, 2, 0]);
    expect(nextAutomaticNuki(state, true)).toBeNull();
    expect(state.nukiTiles).toEqual([["5m"], ["0m", "5m"], ["5m"]]);
    expect(state.deadWall).toHaveLength(6);
    expect(state.sanmaWall).toMatchObject({
      replacementsTaken: 4,
      kanCount: 0,
    });
    expect(physicalTiles(state)).toEqual(before);
    expect(MatchStateSchema.parse(state)).toEqual(state);
    const drawn = step(state, { type: "draw", seat: 1 }).state;
    expect(drawn.hands.map((hand) => hand.length)).toEqual([13, 14, 13]);
    expect(drawn.lastDrawFromDeadWall).toBe(false);
  });

  it("rejects opening extraction after the first ordinary draw or discard", () => {
    const drawn = nukiState("kansai");
    expectRejected(drawn, { type: "nuki", seat: 0, tile: "5m", opening: true });
    drawn.phase = "awaiting_draw";
    drawn.lastDrawn[0] = null;
    drawn.hands[0].shift();
    expectRejected(drawn, { type: "nuki", seat: 0, tile: "5m", opening: true });
    expect(nextAutomaticNuki(drawn, true)).toBeNull();
  });

  it("extracts a kan-drawn 5m without undoing the kan's interruption", () => {
    const state = nukiState("kansai");
    state.hands[0] = [...tiles("9999p"), ...FILLER.slice(0, 10)];
    state.lastDrawn[0] = "9p";
    state.ippatsuEligible = [true, true, true];
    state.deadWall.splice(0, 2, "5m", "7z");
    const kan = step(state, {
      type: "kan",
      seat: 0,
      kind: "ankan",
      tile: "9p",
    });
    expect(kan.state.lastDrawn[0]).toBe("5m");
    expect(kan.events).toContainEqual(
      expect.objectContaining({ type: "draw", replacementKind: "kan" })
    );
    expectRejected(kan.state, { type: "discard", seat: 0, tile: "5m" });
    const extracted = step(kan.state, nextAutomaticNuki(kan.state)!).state;
    const result = completeNuki(extracted);
    expect(result.state.ippatsuEligible).toEqual([false, false, false]);
    expect(result.state.sanmaWall).toMatchObject({
      kanCount: 1,
      replacementsTaken: 2,
    });
    expect(result.state.nukiTiles[0]).toEqual(["5m"]);
    expect(result.state.melds[0]).toHaveLength(1);
    expect(result.state.doraIndicators).toEqual(kan.state.doraIndicators);
    expect(result.state.liveWall).toHaveLength(state.liveWall.length - 2);
    expect(result.state.deadWall).toHaveLength(10);
    expect(result.state.hands[0]).toHaveLength(11);
  });
});

describe("nuki scoring and resource boundaries", () => {
  it.each([
    ["online", false],
    ["online", true],
    ["kansai", false],
    ["kansai", true],
  ] as const)(
    "scores rinshan, never haitei, for %s nuki, Duplicate=%s",
    (variant, duplicate) => {
      const state = nukiState(variant, duplicate);
      state.hands[0] = [
        ...REPLACEMENT_WAIT,
        variant === "online" ? "4z" : "5m",
      ];
      if (duplicate) {
        state.liveWall = ["7z"];
      } else {
        state.liveWall = variant === "online" ? ["9s"] : [];
        setReplacement(state, "7z");
      }
      const completed = completeNuki(declareNuki(state).state).state;
      expect(completed.liveWall).toEqual([]);
      const win = winningEvent(step(completed, { type: "tsumo", seat: 0 }));
      expect(win.score.yaku["嶺上開花"]).toBeDefined();
      expect(win.score.yaku["海底摸月"]).toBeUndefined();
      expect(win.score.yaku["抜きドラ"]).toBeDefined();
      expect(win.delta).toHaveLength(3);
      expect(win.delta.reduce((sum, delta) => sum + delta, 0)).toBe(0);
    }
  );

  it.each(["online", "kansai"] as const)(
    "%s interruption controls new double riichi",
    (variant) => {
      const state = nukiState(variant);
      state.hands[0] = [
        ...REPLACEMENT_WAIT,
        variant === "online" ? "4z" : "5m",
      ];
      state.discards = [[], [], []];
      setReplacement(state, "9m");
      const completed = completeNuki(declareNuki(state).state).state;
      const declared = step(completed, { type: "riichi", seat: 0, tile: "9m" });
      expect(declared.state.riichiDeclared[0]).toBe(true);
      expect(declared.state.doubleRiichi[0]).toBe(variant === "kansai");
    }
  );

  it.each(["online", "kansai"] as const)(
    "%s interruption controls first-turn blessings",
    (variant) => {
      const state = nukiState(variant);
      state.discards = [[], [], []];
      state.hands[0] = [
        ...REPLACEMENT_WAIT,
        variant === "online" ? "4z" : "5m",
      ];
      setReplacement(state, "7z");
      const completed = completeNuki(declareNuki(state).state).state;
      const win = winningEvent(step(completed, { type: "tsumo", seat: 0 }));
      expect(win.score.yaku["天和"] !== undefined).toBe(variant === "kansai");
    }
  );

  it("preserves Kansai riichi ippatsu through mandatory extraction and rinshan", () => {
    const state = nukiState("kansai");
    state.hands[0] = [...REPLACEMENT_WAIT, "5m"];
    state.riichiDeclared[0] = true;
    state.ippatsuEligible[0] = true;
    setReplacement(state, "7z");
    const completed = completeNuki(declareNuki(state).state).state;
    const win = winningEvent(step(completed, { type: "tsumo", seat: 0 }));
    expect(win.score.yaku["一発"]).toBeDefined();
    expect(win.score.yaku["嶺上開花"]).toBeDefined();
  });

  it("does not qualify a later ordinary win using nuki bonus alone", () => {
    const state = nukiState();
    openNorthWait(state, 0);
    state.hands[0].push("4z");
    state.nukiTiles[0].push("4z");
    state.lastDrawFromDeadWall = false;
    expectRejected(state, { type: "tsumo", seat: 0 });
    state.hands[0].pop();
    state.lastDrawn[0] = null;
    state.phase = "awaiting_draw";
    state.lastDiscard = { seat: 1, tile: "4z" };
    expectRejected(state, { type: "ron", seat: 0 });
  });

  it("rejects unavailable Duplicate replacements atomically", () => {
    const state = declareNuki(nukiState("online", true)).state;
    expectRejected(state, { type: "complete_nuki" });
    expectRejected(state, { type: "complete_nuki", replacementTile: "7z" });
    expectRejected(state, { type: "complete_nuki", forceExhaustive: true });
    const standard = declareNuki(nukiState()).state;
    expectRejected(standard, { type: "complete_nuki", replacementTile: "7z" });
  });

  it.each(["online", "kansai"] as const)(
    "preflights a %s Duplicate queue peek without consuming it",
    (variant) => {
      const state = nukiState(variant, true);
      const tile = variant === "online" ? "4z" : "5m";
      const replacementTile = state.liveWall[5];
      const action = { type: "nuki", seat: 0, tile, replacementTile } as const;
      const before = structuredClone(state);
      expect(canDeclareNuki(state, action)).toBe(true);
      const declared = step(state, action).state;
      expect(declared.pendingNuki).toEqual({ seat: 0, tile, opening: false });
      expect(declared.liveWall).toEqual(state.liveWall);
      expect(declared.deadWall).toEqual(state.deadWall);
      expect(declared.sanmaWall).toEqual(state.sanmaWall);
      expect(state).toEqual(before);
      const completed = step(declared, {
        type: "complete_nuki",
        replacementTile,
      });
      expect(completed.events).toContainEqual({
        type: "draw",
        seat: 0,
        tile: replacementTile,
        wallRemaining: state.liveWall.length - 1,
        fromDeadWall: false,
        replacementKind: "nuki",
      });
      expectRejected(state, { ...action, replacementTile: "7z" });
      expectRejected(nukiState(variant), { ...action });
    }
  );

  it.each(["online", "kansai"] as const)(
    "permits nuki after four kans in %s",
    (variant) => {
      const state = nukiState(variant);
      for (let count = 0; count < 4; count++) {
        expect(takeSanmaReplacement(state, "kan")).toBeDefined();
      }
      const completed = completeNuki(declareNuki(state).state).state;
      expect(completed.sanmaWall).toMatchObject({
        kanCount: 4,
        replacementsTaken: 5,
      });
      expect(completed.nukiTiles[0]).toHaveLength(1);
    }
  );

  it.each(["online", "kansai"] as const)(
    "rejects a fifth nuki resource in %s",
    (variant) => {
      const state = nukiState(variant);
      for (let count = 0; count < 4; count++) {
        expect(takeSanmaReplacement(state, "nuki")).toBeDefined();
      }
      expectRejected(state, {
        type: "nuki",
        seat: 0,
        tile: variant === "online" ? "4z" : "5m",
      });
    }
  );

  it.each([
    ["online", false],
    ["online", true],
    ["kansai", false],
    ["kansai", true],
  ] as const)(
    "uses the eighth and final replacement in %s, Duplicate=%s",
    (variant, duplicate) => {
      const state = nukiState(variant, duplicate);
      for (let count = 0; count < 7; count++) {
        const kind = count < 4 ? "kan" : "nuki";
        expect(
          takeSanmaReplacement(
            state,
            kind,
            duplicate ? state.liveWall[0] : undefined
          )
        ).toBeDefined();
        if (kind === "nuki") {
          state.nukiTiles[1].push(variant === "online" ? "4z" : "5m");
        }
      }
      setReplacement(state, "7z");
      const result = completeNuki(declareNuki(state).state);
      expect(result.state.sanmaWall).toMatchObject({
        replacementsTaken: 8,
        kanCount: 4,
      });
      expect(result.state.nukiTiles.flat()).toHaveLength(4);
      expect(result.state.lastDrawn[0]).toBe("7z");
      expectRejected(result.state, {
        type: "nuki",
        seat: 0,
        tile: variant === "online" ? "4z" : "5m",
      });
      expectRejected(result.state, {
        type: "kan",
        seat: 0,
        kind: "ankan",
        tile: "1m",
      });
      expect(MatchStateSchema.parse(result.state)).toEqual(result.state);
    }
  );

  it.each([false, true])(
    "settles a forced Duplicate boundary without drawing, opening=%s",
    (opening) => {
      const state = nukiState("kansai", true);
      if (opening) {
        state.phase = "awaiting_draw";
        state.discards = [[], [], []];
        state.lastDrawn[0] = null;
        state.hands[0].shift();
      }
      const extracted = step(state, {
        type: "nuki",
        seat: 0,
        tile: "5m",
        opening,
      }).state;
      const result = step(extracted, {
        type: "complete_nuki",
        forceExhaustive: true,
      });
      expect(result.state.phase).toBe("awaiting_ryuukyoku_declarations");
      expect(result.state.pendingNuki).toBeNull();
      expect(result.state.pendingRyuukyoku?.declarations).toEqual([
        null,
        null,
        null,
      ]);
      expect(result.state.nukiTiles).toEqual([["5m"], [], []]);
      expect(result.state.hands[0]).not.toContain("5m");
      expect(result.state.liveWall).toEqual(state.liveWall);
      expect(result.state.deadWall).toEqual(state.deadWall);
      expect(result.state.sanmaWall).toEqual(state.sanmaWall);
      expect(result.events.some((event) => event.type === "draw")).toBe(false);
      expect(physicalTiles(result.state)).toEqual(physicalTiles(state));
      expect(MatchStateSchema.parse(result.state)).toEqual(result.state);
      let settling = result.state;
      for (let count = 0; count < 3; count++) {
        settling = step(settling, {
          type: "declare_ryuukyoku_status",
          seat: settling.turn,
          tenpai: false,
        }).state;
      }
      expect(settling.phase).toBe("awaiting_ryuukyoku_settlement");
      const ended = step(settling, { type: "complete_ryuukyoku" });
      expect(ended.state.lastHandResult).toMatchObject({
        reason: "exhaustive_draw",
        delta: [0, 0, 0],
        tenpai: [false, false, false],
      });
    }
  );

  it("ends an empty aggregate Duplicate source without waiting for a missing tile", () => {
    const state = nukiState("kansai", true);
    state.liveWall = [];
    const extracted = declareNuki(state).state;
    const result = step(extracted, { type: "complete_nuki" });
    expect(result.state.phase).toBe("awaiting_ryuukyoku_declarations");
    expect(result.state.pendingNuki).toBeNull();
    expect(result.events.some((event) => event.type === "draw")).toBe(false);
  });

  it.each(["kan", "nuki"] as const)(
    "extracts a final Duplicate %s replacement 5m before exhaustion",
    (cause) => {
      const state = nukiState("kansai", true);
      state.liveWall = ["5m"];
      if (cause === "kan") {
        state.hands[0] = [...tiles("9999p"), ...FILLER.slice(0, 10)];
        state.lastDrawn[0] = "9p";
      }
      const before = physicalTiles(state);
      const drawn =
        cause === "kan"
          ? step(state, {
              type: "kan",
              seat: 0,
              kind: "ankan",
              tile: "9p",
              replacementTile: "5m",
            }).state
          : completeNuki(declareNuki(state).state).state;
      expect(drawn.lastDrawn[0]).toBe("5m");
      expect(drawn.liveWall).toEqual([]);
      const action = nextAutomaticNuki(drawn);
      expect(action).toEqual({
        type: "nuki",
        seat: 0,
        tile: "5m",
        opening: false,
      });
      const extracted = step(drawn, action!).state;
      const result = step(extracted, {
        type: "complete_nuki",
        forceExhaustive: true,
      });
      expect(result.state.phase).toBe("awaiting_ryuukyoku_declarations");
      expect(result.state.hands[0]).not.toContain("5m");
      expect(result.state.nukiTiles[0]).toHaveLength(cause === "kan" ? 1 : 2);
      expect(result.state.sanmaWall?.replacementsTaken).toBe(1);
      expect(result.state.pendingNuki).toBeNull();
      expect(result.events.some((event) => event.type === "draw")).toBe(false);
      expect(physicalTiles(result.state)).toEqual(before);
      expect(MatchStateSchema.parse(result.state)).toEqual(result.state);
    }
  );

  it("rejects forced exhaustion of voluntary North or a standard Kansai reserve", () => {
    for (const state of [nukiState("online", true), nukiState("kansai")]) {
      expectRejected(declareNuki(state).state, {
        type: "complete_nuki",
        forceExhaustive: true,
      });
    }
    const state = declareNuki(nukiState("kansai", true)).state;
    expectRejected(state, {
      type: "complete_nuki",
      forceExhaustive: true,
      replacementTile: state.liveWall[0],
    });
  });
});

describe("three-seat exhaustion after nuki", () => {
  it.each([
    { tenpai: [false, false, false], delta: [0, 0, 0] },
    { tenpai: [true, false, false], delta: [3000, -1500, -1500] },
    { tenpai: [true, true, false], delta: [1500, 1500, -3000] },
    { tenpai: [true, true, true], delta: [0, 0, 0] },
  ])(
    "collects three declarations and distributes the noten pool: $tenpai",
    ({ tenpai, delta }) => {
      const state = nukiState("kansai", true);
      state.hands = activeSeats(3).map((seat) => [
        ...(tenpai[seat] ? REPLACEMENT_WAIT : FILLER),
      ]);
      state.hands[0].push("5m");
      state.dealer = 2;
      const extracted = declareNuki(state).state;
      let current = step(extracted, {
        type: "complete_nuki",
        forceExhaustive: true,
      }).state;
      expect(current.turn).toBe(2);
      expect(current.pendingRyuukyoku?.actualTenpai).toEqual(tenpai);
      expectRejected(current, {
        type: "declare_ryuukyoku_status",
        seat: 3,
        tenpai: false,
      });
      expectRejected(current, { type: "complete_ryuukyoku" });
      for (const seat of [2, 0, 1] as const) {
        expect(current.turn).toBe(seat);
        current = step(current, {
          type: "declare_ryuukyoku_status",
          seat,
          tenpai: tenpai[seat],
        }).state;
      }
      expect(current.phase).toBe("awaiting_ryuukyoku_settlement");
      const result = step(current, { type: "complete_ryuukyoku" });
      expect(result.state.lastHandResult).toMatchObject({
        reason: "exhaustive_draw",
        tenpai,
        delta,
      });
      expect(result.state.scores).toEqual(
        delta.map((change) => 45_000 + change)
      );
      expect(result.events).toEqual([
        { type: "hand_end", reason: "exhaustive_draw", delta },
      ]);
    }
  );

  it("rejects riichi and tenpai declarations that wait only on removed manzu", () => {
    const state = nukiState();
    const unplayableWait = tiles("123p123789s555z5m");
    state.hands[0] = [...unplayableWait, "9m"];
    state.lastDrawn[0] = "9m";
    expectRejected(state, { type: "riichi", seat: 0, tile: "9m" });
    state.hands[0].pop();
    state.lastDrawn[0] = null;
    state.liveWall = [];
    state.phase = "awaiting_draw";
    const ended = step(state, { type: "draw", seat: 0 }).state;
    expect(ended.pendingRyuukyoku?.actualTenpai[0]).toBe(false);
    expectRejected(ended, {
      type: "declare_ryuukyoku_status",
      seat: 0,
      tenpai: true,
    });
  });
});

describe("nuki persistence and helper contracts", () => {
  it("normalizes old four-player state and rejects concurrent pending declarations", () => {
    const legacy = { ...createInitialState(42) };
    delete (legacy as Partial<MatchState>).pendingNuki;
    expect(MatchStateSchema.parse(legacy).pendingNuki).toBeNull();
    const state = declareNuki(nukiState()).state;
    state.pendingShouminkan = { seat: 1, tile: "9p", ponIdx: 0 };
    expect(MatchStateSchema.safeParse(state).success).toBe(false);
    expect(getPendingRobbery(state)).toBeNull();
    expectRejected(state, { type: "complete_nuki" });
    expectRejected(state, { type: "complete_shouminkan" });
    expectRejected(state, { type: "ron", seat: 1 });
  });

  it.each([
    [
      "wrong tile",
      (state: MatchState) => {
        state.pendingNuki!.tile = "5m";
      },
    ],
    [
      "inactive declarer",
      (state: MatchState) => {
        state.pendingNuki!.seat = 3;
      },
    ],
    [
      "wrong phase",
      (state: MatchState) => {
        state.phase = "awaiting_discard";
      },
    ],
    [
      "opening Online nuki",
      (state: MatchState) => {
        state.pendingNuki!.opening = true;
      },
    ],
    [
      "five physical nuki",
      (state: MatchState) => {
        state.nukiTiles[1] = ["4z", "4z", "4z", "4z"];
      },
    ],
  ] as const)("rejects persisted %s", (_label, change) => {
    const state = declareNuki(nukiState()).state;
    change(state);
    expect(MatchStateSchema.safeParse(state).success).toBe(false);
  });

  it("resets robbed pending custody and extracted piles on the next hand", () => {
    const state = nukiState();
    state.hands[1] = [...NORTH_WAIT];
    const ended = step(declareNuki(state).state, {
      type: "ron",
      seat: 1,
    }).state;
    const result = step(ended, { type: "start_next_hand" });
    expect(result.state.phase).toBe("awaiting_draw");
    expect(result.state.pendingNuki).toBeNull();
    expect(result.state.pendingShouminkan).toBeNull();
    expect(result.state.nukiTiles).toEqual([[], [], []]);
    expect(result.state.lastDrawFromDeadWall).toBe(false);
    expect(MatchStateSchema.parse(result.state)).toEqual(result.state);
  });

  it("identifies only the active variant's extraction tiles", () => {
    const online = nukiState().ruleSet;
    const kansai = nukiState("kansai").ruleSet;
    expect(isNukiTile("4z", online)).toBe(true);
    expect(isNukiTile("5m", online)).toBe(false);
    expect(isNukiTile("5m", kansai)).toBe(true);
    expect(isNukiTile("0m", kansai)).toBe(true);
    expect(isNukiTile("4z", kansai)).toBe(false);
    expect(isNukiTile("4z", createInitialState(42).ruleSet)).toBe(false);
  });
});
