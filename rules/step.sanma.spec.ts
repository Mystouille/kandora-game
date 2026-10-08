import { describe, expect, it } from "vitest";
import { createInitialState, MatchStateSchema, type MatchState } from "./state";
import { step, seatWind } from "./step";
import { enumerateCalls } from "./calls";
import { activeSeats } from "./seats";
import type { SanmaType } from "../protocol/seat";
import type { Tile } from "./types";
import { dealMatch } from "./wall";
import { getSanmaIndicatorPair, takeSanmaReplacement } from "./wallTransitions";

describe("three-player engine topology", () => {
  it("initializes only three participants and validates their cardinality", () => {
    const state = createInitialState(42, { ruleSet: { playerCount: 3 } });
    expect(state.hands.map((hand) => hand.length)).toEqual([13, 13, 13]);
    expect(state.scores).toEqual([25_000, 25_000, 25_000]);
    for (const values of [
      state.discards,
      state.lastDrawn,
      state.riichiDeclared,
      state.doubleRiichi,
      state.ippatsuEligible,
      state.melds,
      state.furitenLocked,
      state.furitenTemp,
      state.paoDaisangen,
      state.paoDaisuushii,
      state.chips,
      state.dabuken,
    ]) {
      expect(values).toHaveLength(3);
    }
    expect(MatchStateSchema.parse(state)).toEqual(state);
    expect(MatchStateSchema.safeParse({ ...state, turn: 3 }).success).toBe(
      false
    );
    expect(
      MatchStateSchema.safeParse({
        ...state,
        scores: [25_000, 25_000, 25_000, 0],
      }).success
    ).toBe(false);
  });

  it("cycles through East, South and West without a fourth turn", () => {
    let state = createInitialState(42, { ruleSet: { playerCount: 3 } });
    for (let cycle = 0; cycle < 2; cycle++) {
      for (const seat of activeSeats(3)) {
        expect(state.turn).toBe(seat);
        state = step(state, { type: "draw", seat }).state;
        const tile = state.lastDrawn[seat];
        if (tile === null) {
          throw new Error("Expected a drawn tile");
        }
        state = step(state, {
          type: "discard",
          seat,
          tile,
          discardSource: "draw",
        }).state;
      }
    }
    expect(state.turn).toBe(0);
    expect(state.discards.map((tiles) => tiles.length)).toEqual([2, 2, 2]);
    expect(step(state, { type: "draw", seat: 3 })).toEqual({
      state,
      events: [],
    });
  });

  const wallCases = [
    { sanmaType: "online", duplicate: false, live: 55, dead: 14, kanCost: 1 },
    { sanmaType: "kansai", duplicate: false, live: 63, dead: 10, kanCost: 2 },
    { sanmaType: "online", duplicate: true, live: 55, dead: 14, kanCost: 1 },
    { sanmaType: "kansai", duplicate: true, live: 59, dead: 14, kanCost: 1 },
  ] as const;
  type KanKind = "ankan" | "daiminkan" | "shouminkan";
  const kanKinds = ["ankan", "daiminkan", "shouminkan"] as const;

  function kanState(
    sanmaType: SanmaType,
    duplicate: boolean,
    kind: KanKind = "ankan",
    instant = true
  ): MatchState {
    const state = createInitialState(42, {
      ruleSet: {
        playerCount: 3,
        sanmaType,
        instantlyRevealDoraForAnkan: instant,
        instantlyRevealDoraForMinkan: instant,
      },
      wall: { duplicate },
    });
    const prefix: Tile[] = ["1z", "2z", "3z", "4z", "5z", "6z", "7z", "1m"];
    state.deadWall = [
      ...prefix,
      "1p",
      "2p",
      ...(sanmaType === "online" || duplicate ? ["3p", "4p", "5p", "6p"] : []),
    ];
    state.liveWall = [
      "1s",
      "2s",
      "3s",
      "4s",
      "5s",
      "6s",
      "7s",
      "8s",
      "9s",
      "9m",
    ];
    state.doraIndicators = [state.deadWall[duplicate ? 4 : 8]];
    state.uraDoraIndicators = [state.deadWall[duplicate ? 5 : 9]];
    const rest: Tile[] = [
      "1p",
      "2p",
      "3p",
      "4p",
      "5p",
      "6p",
      "1s",
      "2s",
      "3s",
      "5z",
    ];
    const held = kind === "ankan" ? 4 : kind === "daiminkan" ? 3 : 1;
    state.hands[0] = [...Array<Tile>(held).fill("9p"), ...rest];
    state.turn = 0;
    state.phase = kind === "daiminkan" ? "awaiting_draw" : "awaiting_discard";
    state.lastDrawn[0] = kind === "daiminkan" ? null : "5z";
    if (kind === "daiminkan") {
      state.lastDiscard = { seat: 2, tile: "9p" };
      state.discards[2] = ["9p"];
    } else if (kind === "shouminkan") {
      state.melds[0] = [
        {
          type: "pon",
          tiles: ["9p", "9p", "9p"],
          claimedTile: "9p",
          from: 1,
        },
      ];
    }
    return state;
  }

  function endForNextHand(state: MatchState): void {
    state.phase = "hand_ended";
    state.lastHandResult = {
      reason: "abort",
      winner: null,
      loser: null,
      delta: [0, 0, 0],
      tenpai: null,
      abortKind: null,
      winHan: null,
      winYakuman: null,
    };
  }

  describe.each(wallCases)(
    "sanma wall state: $sanmaType, Duplicate=$duplicate",
    (entry) => {
      it("persists the explicit wall cursor and correct opening dora/ura pair", () => {
        const state = createInitialState(42, {
          ruleSet: { playerCount: 3, sanmaType: entry.sanmaType },
          wall: { duplicate: entry.duplicate },
        });
        expect(state.sanmaWall).toEqual({
          sanmaType: entry.sanmaType,
          mode: entry.duplicate ? "duplicate" : "standard",
          replacementsTaken: 0,
          kanCount: 0,
        });
        expect(state.liveWall).toHaveLength(entry.live);
        expect(state.deadWall).toHaveLength(entry.dead);
        expect(state.doraIndicators).toEqual([
          state.deadWall[entry.duplicate ? 4 : 8],
        ]);
        expect(state.uraDoraIndicators).toEqual([
          state.deadWall[entry.duplicate ? 5 : 9],
        ]);
        expect(
          MatchStateSchema.parse(JSON.parse(JSON.stringify(state)))
        ).toEqual(state);
      });

      it("clones the cursor on ordinary draws without aliasing earlier states", () => {
        const state = createInitialState(42, {
          ruleSet: { playerCount: 3, sanmaType: entry.sanmaType },
          wall: { duplicate: entry.duplicate },
        });
        const before = structuredClone(state);
        const drawn = step(state, { type: "draw", seat: 0 }).state;
        expect(drawn.sanmaWall).toEqual(state.sanmaWall);
        expect(drawn.sanmaWall).not.toBe(state.sanmaWall);
        expect(state).toEqual(before);
        expect(MatchStateSchema.parse(drawn)).toEqual(drawn);
      });

      it.each([-1, 1])(
        "rejects a reserve with a %i-tile count discrepancy",
        (difference) => {
          const state = kanState(entry.sanmaType, entry.duplicate);
          if (difference < 0) {
            state.deadWall.pop();
          } else {
            state.deadWall.push("7z");
          }
          expect(MatchStateSchema.safeParse(state).success).toBe(false);
        }
      );

      it.each([false, true])(
        "resets the fresh deal and cursor on next hand, supplied=%s",
        (supplied) => {
          const state = kanState(entry.sanmaType, entry.duplicate);
          expect(
            takeSanmaReplacement(
              state,
              "nuki",
              entry.duplicate ? state.liveWall[0] : undefined
            )
          ).toBeDefined();
          state.nukiTiles[0].push(entry.sanmaType === "online" ? "4z" : "5m");
          endForNextHand(state);
          const before = structuredClone(state);
          const deal = supplied
            ? dealMatch(9876, {
                playerCount: 3,
                sanmaType: entry.sanmaType,
                duplicate: entry.duplicate,
              })
            : undefined;
          const result = step(state, { type: "start_next_hand", deal });
          const next = result.state;
          expect(next).not.toBe(state);
          expect(next.sanmaWall).toEqual({
            sanmaType: entry.sanmaType,
            mode: entry.duplicate ? "duplicate" : "standard",
            replacementsTaken: 0,
            kanCount: 0,
          });
          expect(next.sanmaWall).not.toBe(state.sanmaWall);
          if (deal) {
            expect(next.sanmaWall).not.toBe(deal.sanmaWall);
            expect(next.hands).toEqual(deal.hands);
          }
          expect(next.liveWall).toHaveLength(entry.live);
          expect(next.deadWall).toHaveLength(entry.dead);
          expect(next.doraIndicators).toEqual([
            next.deadWall[entry.duplicate ? 4 : 8],
          ]);
          expect(next.uraDoraIndicators).toEqual([
            next.deadWall[entry.duplicate ? 5 : 9],
          ]);
          expect(next.nukiTiles).toEqual([[], [], []]);
          expect(MatchStateSchema.parse(next)).toEqual(next);
          expect(state).toEqual(before);
        }
      );

      describe.each([false, true])("instant kan-dora=%s", (instant) => {
        it.each(kanKinds)(
          "uses the sanma replacement and reserved pair for %s",
          (kind) => {
            const state = kanState(
              entry.sanmaType,
              entry.duplicate,
              kind,
              instant
            );
            const before = structuredClone(state);
            const expectedWall = structuredClone(state);
            const replacementTile = entry.duplicate ? "4s" : undefined;
            const expectedDraw = takeSanmaReplacement(
              expectedWall,
              "kan",
              replacementTile
            )!;
            expect(expectedDraw).toBeDefined();
            const declared = step(state, {
              type: "kan",
              seat: 0,
              kind,
              tile: "9p",
              replacementTile:
                kind === "shouminkan" ? undefined : replacementTile,
            });
            if (kind === "shouminkan") {
              expect(declared.state.phase).toBe("awaiting_chankan");
              expect(declared.state.sanmaWall).toEqual(state.sanmaWall);
              expect(declared.state.sanmaWall).not.toBe(state.sanmaWall);
              expect(declared.state.deadWall).toEqual(state.deadWall);
              expect(declared.state.liveWall).toEqual(state.liveWall);
              expect(declared.state.doraIndicators).toEqual(
                state.doraIndicators
              );
              expect(MatchStateSchema.parse(declared.state)).toEqual(
                declared.state
              );
            }
            const result =
              kind === "shouminkan"
                ? step(declared.state, {
                    type: "complete_shouminkan",
                    replacementTile,
                  })
                : declared;
            expect(result.state.sanmaWall).toEqual(expectedWall.sanmaWall);
            expect(result.state.liveWall).toEqual(expectedWall.liveWall);
            expect(result.state.deadWall).toEqual(expectedWall.deadWall);
            expect(result.state.liveWall).toHaveLength(
              state.liveWall.length - entry.kanCost
            );
            expect(result.state.lastDrawn[0]).toBe(expectedDraw.tile);
            expect(result.state.lastDrawFromDeadWall).toBe(true);
            expect(result.events).toContainEqual({
              type: "draw",
              seat: 0,
              tile: expectedDraw.tile,
              wallRemaining: result.state.liveWall.length,
              fromDeadWall: !entry.duplicate,
              replacementKind: "kan",
            });
            const pair = expectedDraw.indicators!;
            if (instant) {
              expect(result.state.doraIndicators).toEqual([
                ...state.doraIndicators,
                pair.dora,
              ]);
              expect(result.state.uraDoraIndicators).toEqual([
                ...state.uraDoraIndicators,
                pair.ura,
              ]);
              expect(result.events).toContainEqual({
                type: "new_dora",
                indicator: pair.dora,
              });
            } else {
              expect(
                result.events.some((event) => event.type === "new_dora")
              ).toBe(false);
              expect(result.state.doraIndicators).toEqual(state.doraIndicators);
              expect(result.state.pendingKanDora).toEqual([pair.dora]);
              expect(result.state.pendingKanUraDora).toEqual([pair.ura]);
              const discarded = step(result.state, {
                type: "discard",
                seat: 0,
                tile: "1p",
              });
              expect(discarded.state.doraIndicators).toEqual([
                ...state.doraIndicators,
                pair.dora,
              ]);
              expect(discarded.state.uraDoraIndicators).toEqual([
                ...state.uraDoraIndicators,
                pair.ura,
              ]);
              expect(discarded.state.pendingKanDora).toEqual([]);
              expect(discarded.state.sanmaWall).toEqual(result.state.sanmaWall);
            }
            expect(MatchStateSchema.parse(result.state)).toEqual(result.state);
            expect(state).toEqual(before);
          }
        );
      });

      it("keeps kan indicators stable after an earlier nuki replacement", () => {
        const state = kanState(entry.sanmaType, entry.duplicate);
        expect(
          takeSanmaReplacement(
            state,
            "nuki",
            entry.duplicate ? state.liveWall[0] : undefined
          )
        ).toBeDefined();
        const expected = structuredClone(state);
        const replacementTile = entry.duplicate ? state.liveWall[0] : undefined;
        const draw = takeSanmaReplacement(expected, "kan", replacementTile)!;
        const result = step(state, {
          type: "kan",
          seat: 0,
          kind: "ankan",
          tile: "9p",
          replacementTile,
        });
        expect(result.state.sanmaWall).toMatchObject({
          replacementsTaken: 2,
          kanCount: 1,
        });
        expect(result.state.lastDrawn[0]).toBe(draw.tile);
        expect(result.state.doraIndicators).toEqual([
          ...state.doraIndicators,
          draw.indicators!.dora,
        ]);
        expect(result.state.uraDoraIndicators).toEqual([
          ...state.uraDoraIndicators,
          draw.indicators!.ura,
        ]);
        expect(getSanmaIndicatorPair(result.state)).toEqual(draw.indicators);
      });

      it.each(kanKinds)(
        "rejects %s atomically when its live reserve is unavailable",
        (kind) => {
          const state = kanState(entry.sanmaType, entry.duplicate, kind);
          state.liveWall = state.liveWall.slice(0, entry.kanCost - 1);
          const before = structuredClone(state);
          expect(
            step(state, {
              type: "kan",
              seat: 0,
              kind,
              tile: "9p",
              replacementTile: entry.duplicate ? "4s" : undefined,
            })
          ).toEqual({ state, events: [] });
          expect(state).toEqual(before);
        }
      );

      it("accepts a kan on the final required live-tail tiles without marking it haitei", () => {
        const state = kanState(entry.sanmaType, entry.duplicate);
        state.liveWall = state.liveWall.slice(0, entry.kanCost);
        const result = step(state, {
          type: "kan",
          seat: 0,
          kind: "ankan",
          tile: "9p",
          replacementTile: entry.duplicate ? state.liveWall[0] : undefined,
        });
        expect(result.state.liveWall).toEqual([]);
        expect(result.state.lastDrawFromDeadWall).toBe(true);
        expect(result.state.sanmaWall).toMatchObject({
          kanCount: 1,
          replacementsTaken: 1,
        });
        expect(result.events).toContainEqual(
          expect.objectContaining({
            type: "draw",
            wallRemaining: 0,
            fromDeadWall: !entry.duplicate,
            replacementKind: "kan",
          })
        );
      });

      it.each(kanKinds)(
        "rejects a fifth %s without changing hands, walls, or indicators",
        (kind) => {
          const state = kanState(entry.sanmaType, entry.duplicate, kind);
          for (let index = 0; index < 4; index++) {
            expect(
              takeSanmaReplacement(
                state,
                "kan",
                entry.duplicate ? state.liveWall[0] : undefined
              )
            ).toBeDefined();
          }
          const before = structuredClone(state);
          expect(
            step(state, {
              type: "kan",
              seat: 0,
              kind,
              tile: "9p",
              replacementTile: entry.duplicate ? state.liveWall[0] : undefined,
            })
          ).toEqual({ state, events: [] });
          expect(state).toEqual(before);
        }
      );

      it("reserves future pairs even when kan dora presentation is disabled", () => {
        const initial = kanState(entry.sanmaType, entry.duplicate);
        const state = {
          ...initial,
          ruleSet: { ...initial.ruleSet, kanDora: false },
        };
        state.hands[0] = [
          "9p",
          "9p",
          "9p",
          "9p",
          "8p",
          "8p",
          "8p",
          "8p",
          "1s",
          "2s",
          "3s",
          "5z",
          "5z",
          "6z",
        ];
        state.lastDrawn[0] = "6z";
        const first = step(state, {
          type: "kan",
          seat: 0,
          kind: "ankan",
          tile: "9p",
          replacementTile: entry.duplicate ? state.liveWall[0] : undefined,
        });
        expect(first.state.sanmaWall).toMatchObject({
          kanCount: 1,
          replacementsTaken: 1,
        });
        expect(first.state.doraIndicators).toEqual(state.doraIndicators);
        expect(first.state.pendingKanDora).toEqual([]);
        const enabled = {
          ...first.state,
          ruleSet: { ...first.state.ruleSet, kanDora: true },
        };
        const expected = structuredClone(enabled);
        const replacementTile = entry.duplicate
          ? enabled.liveWall[0]
          : undefined;
        const draw = takeSanmaReplacement(expected, "kan", replacementTile)!;
        const second = step(enabled, {
          type: "kan",
          seat: 0,
          kind: "ankan",
          tile: "8p",
          replacementTile,
        });
        expect(second.state.doraIndicators).toEqual([
          ...state.doraIndicators,
          draw.indicators!.dora,
        ]);
        expect(second.state.uraDoraIndicators).toEqual([
          ...state.uraDoraIndicators,
          draw.indicators!.ura,
        ]);
        expect(second.state.sanmaWall).toMatchObject({
          kanCount: 2,
          replacementsTaken: 2,
        });
      });
    }
  );

  describe("strict sanma wall persistence and illegal requests", () => {
    it("requires sanma metadata only for three players and leaves legacy four-player clones unchanged", () => {
      const sanma = createInitialState(42, { ruleSet: { playerCount: 3 } });
      delete sanma.sanmaWall;
      expect(MatchStateSchema.safeParse(sanma).success).toBe(false);
      const yonma = createInitialState(42);
      expect(yonma).not.toHaveProperty("sanmaWall");
      expect(step(yonma, { type: "draw", seat: 0 }).state).not.toHaveProperty(
        "sanmaWall"
      );
      expect(MatchStateSchema.parse(yonma)).toEqual(yonma);
      expect(
        MatchStateSchema.safeParse({
          ...yonma,
          sanmaWall: {
            sanmaType: "online",
            mode: "standard",
            replacementsTaken: 0,
            kanCount: 0,
          },
        }).success
      ).toBe(false);
    });

    it.each([
      { replacementsTaken: -1 },
      { replacementsTaken: 0.5 },
      { replacementsTaken: 9 },
      { replacementsTaken: 5, kanCount: 0 },
      { kanCount: -1 },
      { kanCount: 1 },
      { replacementsTaken: 5, kanCount: 5 },
      { mode: "unknown" },
      { sanmaType: "kansai" },
      { unexpected: true },
    ])("rejects inconsistent or unknown metadata %j", (invalid) => {
      const state = createInitialState(42, { ruleSet: { playerCount: 3 } });
      state.sanmaWall = { ...state.sanmaWall!, ...invalid } as NonNullable<
        MatchState["sanmaWall"]
      >;
      expect(MatchStateSchema.safeParse(state).success).toBe(false);
    });

    it.each(["mode", "dora", "ura", "extra pair", "unpaired ura"] as const)(
      "rejects a %s mismatch between the reserve and indicator state",
      (invalid) => {
        const state = kanState("online", false);
        if (invalid === "mode") {
          state.sanmaWall!.mode = "duplicate";
        } else if (invalid === "dora") {
          state.doraIndicators[0] = "7z";
        } else if (invalid === "ura") {
          state.uraDoraIndicators[0] = "7z";
        } else if (invalid === "extra pair") {
          state.pendingKanDora.push("3p");
          state.pendingKanUraDora.push("4p");
        } else {
          state.pendingKanUraDora.push("4p");
        }
        expect(MatchStateSchema.safeParse(state).success).toBe(false);
      }
    );

    it.each(kanKinds)(
      "does not fall back to yonma %s when sanma metadata is absent",
      (kind) => {
        const state = kanState("online", false, kind);
        delete state.sanmaWall;
        const before = structuredClone(state);
        expect(step(state, { type: "kan", seat: 0, kind, tile: "9p" })).toEqual(
          { state, events: [] }
        );
        expect(state).toEqual(before);
      }
    );

    it.each(["online", "kansai"] as const)(
      "rejects invalid supplied %s replacements without changing the declaration",
      (sanmaType) => {
        const standard = kanState(sanmaType, false);
        const duplicate = kanState(sanmaType, true);
        for (const [state, replacementTile] of [
          [standard, standard.liveWall[0]],
          [duplicate, undefined],
          [duplicate, "0s"],
        ] as const) {
          const before = structuredClone(state);
          expect(
            step(state, {
              type: "kan",
              seat: 0,
              kind: "ankan",
              tile: "9p",
              replacementTile,
            })
          ).toEqual({ state, events: [] });
          expect(state).toEqual(before);
        }
        const added = kanState(sanmaType, true, "shouminkan");
        const pending = step(added, {
          type: "kan",
          seat: 0,
          kind: "shouminkan",
          tile: "9p",
        });
        expect(pending.state.phase).toBe("awaiting_chankan");
        const before = structuredClone(pending.state);
        expect(step(pending.state, { type: "complete_shouminkan" })).toEqual({
          state: pending.state,
          events: [],
        });
        expect(pending.state).toEqual(before);
      }
    );

    it.each(["missing", "variant", "cursor", "reserve", "indicator"] as const)(
      "rejects a %s-invalid supplied sanma deal",
      (invalid) => {
        const deal = dealMatch(9876, { playerCount: 3 });
        if (invalid === "missing") {
          delete deal.sanmaWall;
        } else if (invalid === "variant") {
          deal.sanmaWall!.sanmaType = "kansai";
        } else if (invalid === "cursor") {
          takeSanmaReplacement(deal, "nuki");
        } else if (invalid === "indicator") {
          deal.doraIndicators[0] =
            deal.doraIndicators[0] === "1z" ? "2z" : "1z";
        } else {
          deal.deadWall.pop();
        }
        expect(() =>
          createInitialState(42, { ruleSet: { playerCount: 3 }, deal })
        ).toThrow();
        const state = kanState("online", false);
        endForNextHand(state);
        const before = structuredClone(state);
        expect(step(state, { type: "start_next_hand", deal })).toEqual({
          state,
          events: [],
        });
        expect(state).toEqual(before);
      }
    );

    it("rejects a supplied next deal that changes Duplicate reserve mode", () => {
      const state = kanState("kansai", true);
      endForNextHand(state);
      const deal = dealMatch(9876, { playerCount: 3, sanmaType: "kansai" });
      expect(step(state, { type: "start_next_hand", deal })).toEqual({
        state,
        events: [],
      });
    });
  });

  it("calculates logical winds independently of the empty physical side", () => {
    expect(activeSeats(3).map((seat) => seatWind(seat, 0, 3))).toEqual([
      "E",
      "S",
      "W",
    ]);
    expect(activeSeats(3).map((seat) => seatWind(seat, 1, 3))).toEqual([
      "W",
      "E",
      "S",
    ]);
    expect(activeSeats(3).map((seat) => seatWind(seat, 2, 3))).toEqual([
      "S",
      "W",
      "E",
    ]);
    expect(seatWind(0, 2)).toBe("W");
  });

  it("does not offer or accept chii, even with the necessary tiles", () => {
    const state = createInitialState(0, { ruleSet: { playerCount: 3 } });
    state.lastDiscard = { seat: 0, tile: "1p" };
    state.discards[0] = ["1p"];
    state.turn = 1;
    state.hands[1] = [
      "2p",
      "3p",
      "5p",
      "5p",
      "5p",
      "7p",
      "8p",
      "9p",
      "1s",
      "1s",
      "2s",
      "2s",
      "4z",
    ];
    expect(
      enumerateCalls(state)
        .flatMap((entry) => entry.options)
        .some((option) => option.kind === "chi")
    ).toBe(false);
    expect(step(state, { type: "chi", seat: 1, tiles: ["2p", "3p"] })).toEqual({
      state,
      events: [],
    });
  });

  it("rotates from East 3 to South 1 after the dealer loses", () => {
    const state = createInitialState(42, { ruleSet: { playerCount: 3 } });
    state.phase = "hand_ended";
    state.dealer = 2;
    state.roundNumber = 3;
    state.lastHandResult = {
      reason: "ron",
      winner: 0,
      loser: 2,
      delta: [1000, 0, -1000],
      tenpai: null,
      abortKind: null,
      winHan: 1,
      winYakuman: false,
    };
    const next = step(state, { type: "start_next_hand" }).state;
    expect([next.roundWind, next.roundNumber, next.dealer]).toEqual([
      "S",
      1,
      0,
    ]);
    expect(next.hands).toHaveLength(3);
    expect(next.scores).toEqual([25_000, 25_000, 25_000]);
  });
});
