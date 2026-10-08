import { describe, expect, it } from "vitest";
import type { SanmaType } from "../protocol/seat";
import type { Tile } from "./types";
import { buildAllTiles, dealMatch } from "./wall";
import {
  canTakeSanmaReplacement,
  getSanmaIndicatorPair,
  takeSanmaReplacement,
  type SanmaIndicatorPair,
  type SanmaReplacementKind,
  type SanmaWallContext,
  type SanmaWallState,
} from "./wallTransitions";

const variants = ["online", "kansai"] as const;
const kinds = ["kan", "nuki"] as const;
const modes = ["standard", "duplicate"] as const;

function labelledWall(
  sanmaType: SanmaType,
  mode: SanmaWallState["mode"] = "standard",
  liveCount = sanmaType === "online" ? 55 : mode === "duplicate" ? 59 : 63
): SanmaWallContext {
  const deadCount = mode === "standard" && sanmaType === "kansai" ? 10 : 14;
  return {
    liveWall: Array.from(
      { length: liveCount },
      (_, index) => `live-${index}` as Tile
    ),
    deadWall: Array.from(
      { length: deadCount },
      (_, index) => `dead-${index}` as Tile
    ),
    sanmaWall: { sanmaType, mode, replacementsTaken: 0, kanCount: 0 },
  };
}

function mixedOrders(
  kans = 0,
  nukis = 0,
  prefix: SanmaReplacementKind[] = []
): SanmaReplacementKind[][] {
  if (kans === 4 && nukis === 4) {
    return [prefix];
  }
  const orders: SanmaReplacementKind[][] = [];
  if (kans < 4) {
    orders.push(...mixedOrders(kans + 1, nukis, [...prefix, "kan"]));
  }
  if (nukis < 4) {
    orders.push(...mixedOrders(kans, nukis + 1, [...prefix, "nuki"]));
  }
  return orders;
}

const orderCases = mixedOrders().map((order) => ({
  label: order.map((kind) => (kind === "kan" ? "K" : "N")).join(""),
  order,
}));

function allWallTiles(wall: SanmaWallContext, drawn: Tile[] = []): Tile[] {
  return [...wall.liveWall, ...wall.deadWall, ...drawn].sort();
}

function expectRejected(
  wall: SanmaWallContext,
  kind: SanmaReplacementKind,
  suppliedTile?: Tile
): void {
  const before = structuredClone(wall);
  expect(canTakeSanmaReplacement(wall, kind, suppliedTile)).toBe(false);
  expect(wall).toEqual(before);
  expect(takeSanmaReplacement(wall, kind, suppliedTile)).toBeUndefined();
  expect(wall).toEqual(before);
}

describe("standard sanma wall transitions", () => {
  it("enumerates all 70 distinct orders of four kans and four nukis", () => {
    expect(orderCases).toHaveLength(70);
    expect(new Set(orderCases.map(({ label }) => label)).size).toBe(70);
  });

  describe.each(variants)("%s", (sanmaType) => {
    describe.each(["full", "last eight live tiles"] as const)(
      "%s reserve",
      (size) => {
        it.each(orderCases)(
          "keeps replacement and indicator identities through $label",
          ({ order }) => {
            const wall = labelledWall(
              sanmaType,
              "standard",
              size === "full" ? undefined : 8
            );
            const initial = structuredClone(wall);
            const indicatorTiles = [
              ...initial.deadWall.slice(8),
              ...[...initial.liveWall]
                .reverse()
                .slice(0, sanmaType === "online" ? 4 : 8),
            ];
            const expectedPairs = Array.from({ length: 5 }, (_, index) => ({
              dora: indicatorTiles[index * 2],
              ura: indicatorTiles[index * 2 + 1],
            }));
            const capturedPairs: SanmaIndicatorPair[] = [
              getSanmaIndicatorPair(wall)!,
            ];
            const drawn: Tile[] = [];
            let kanCount = 0;
            expect(capturedPairs).toEqual([expectedPairs[0]]);

            for (const [index, kind] of order.entries()) {
              const before = structuredClone(wall);
              expect(canTakeSanmaReplacement(wall, kind)).toBe(true);
              expect(wall).toEqual(before);
              const result = takeSanmaReplacement(wall, kind)!;
              drawn.push(result.tile);
              expect(result.tile).toBe(initial.deadWall[index]);
              expect(indicatorTiles).not.toContain(result.tile);
              if (kind === "kan") {
                kanCount++;
                expect(result.indicators).toEqual(expectedPairs[kanCount]);
                capturedPairs.push(result.indicators!);
              } else {
                expect(result.indicators).toBeUndefined();
              }
              const reserved =
                sanmaType === "online" ? 1 : kind === "kan" ? 2 : 0;
              expect(wall.liveWall).toHaveLength(
                before.liveWall.length - reserved
              );
              expect(wall.deadWall).toHaveLength(
                sanmaType === "online" ? 14 : 10 - (index + 1) + 2 * kanCount
              );
              expect(wall.sanmaWall).toEqual({
                sanmaType,
                mode: "standard",
                replacementsTaken: index + 1,
                kanCount,
              });
              expect(wall.deadWall.slice(0, 8 - (index + 1))).toEqual(
                initial.deadWall.slice(index + 1, 8)
              );
              expect(capturedPairs).toEqual(
                expectedPairs.slice(0, kanCount + 1)
              );
              for (let pair = 0; pair <= kanCount; pair++) {
                expect(getSanmaIndicatorPair(wall, pair)).toEqual(
                  capturedPairs[pair]
                );
              }
              expect(allWallTiles(wall, drawn)).toEqual(allWallTiles(initial));
            }
            expect(wall.liveWall).toHaveLength(initial.liveWall.length - 8);
            expectRejected(wall, "kan");
            expectRejected(wall, "nuki");
          }
        );
      }
    );
  });

  it.each(kinds)(
    "rejects Online %s without a live-tail tile, atomically",
    (kind) => {
      expectRejected(labelledWall("online", "standard", 0), kind);
    }
  );

  it.each(kinds)(
    "permits Online %s with exactly one live-tail tile",
    (kind) => {
      const wall = labelledWall("online", "standard", 1);
      const initial = structuredClone(wall);
      const result = takeSanmaReplacement(wall, kind);
      expect(result?.tile).toBe(initial.deadWall[0]);
      expect(wall.liveWall).toHaveLength(0);
      expect(wall.deadWall).toHaveLength(14);
      expect(wall.deadWall.at(-1)).toBe(initial.liveWall[0]);
      expectRejected(wall, "kan");
      expectRejected(wall, "nuki");
    }
  );

  it.each([0, 1])(
    "rejects a Kansai kan with only %i live-tail tiles",
    (liveCount) => {
      expectRejected(labelledWall("kansai", "standard", liveCount), "kan");
    }
  );

  it("reserves the last two Kansai live tiles only when a kan commits", () => {
    const wall = labelledWall("kansai", "standard", 2);
    const before = structuredClone(wall);
    expect(getSanmaIndicatorPair(wall, 1)).toBeUndefined();
    expect(canTakeSanmaReplacement(wall, "kan")).toBe(true);
    expect(wall).toEqual(before);
    expect(takeSanmaReplacement(wall, "kan")).toEqual({
      tile: "dead-0",
      indicators: { dora: "live-1", ura: "live-0" },
    });
    expect(wall.liveWall).toHaveLength(0);
    expect(wall.deadWall).toHaveLength(11);
    expectRejected(wall, "kan");
    expect(canTakeSanmaReplacement(wall, "nuki")).toBe(true);
  });

  it("allows four Kansai nukis with no live tiles and never removes a live tile", () => {
    const wall = labelledWall("kansai", "standard", 0);
    for (let index = 0; index < 4; index++) {
      expect(takeSanmaReplacement(wall, "nuki")).toEqual({
        tile: `dead-${index}`,
      });
      expect(wall.liveWall).toHaveLength(0);
      expect(wall.deadWall).toHaveLength(9 - index);
      expect(getSanmaIndicatorPair(wall)).toEqual({
        dora: "dead-8",
        ura: "dead-9",
      });
    }
    expectRejected(wall, "nuki");
    expectRejected(wall, "kan");
  });

  it("keeps unreserved future Kansai indicators available for ordinary draws", () => {
    const wall = labelledWall("kansai", "standard", 3);
    expect(wall.liveWall.shift()).toBe("live-0");
    expect(wall.liveWall.shift()).toBe("live-1");
    expectRejected(wall, "kan");
    expect(takeSanmaReplacement(wall, "nuki")).toEqual({ tile: "dead-0" });
    expect(wall.liveWall).toEqual(["live-2"]);
  });
});

describe("Duplicate sanma fixed reserve", () => {
  describe.each(variants)("%s", (sanmaType) => {
    it.each(orderCases)(
      "uses only supplied queue tiles through $label",
      ({ order }) => {
        const wall = labelledWall(sanmaType, "duplicate");
        const initial = structuredClone(wall);
        const physicalReserve = wall.deadWall;
        const queues: Tile[][] = [[], [], []];
        initial.liveWall.forEach((tile, index) => {
          queues[index % 3].push(tile);
        });
        expect(queues.map((queue) => queue.length)).toEqual(
          sanmaType === "online" ? [19, 18, 18] : [20, 20, 19]
        );
        const drawn: Tile[] = [];
        let kanCount = 0;
        expect(getSanmaIndicatorPair(wall)).toEqual({
          dora: "dead-4",
          ura: "dead-5",
        });

        for (const [index, kind] of order.entries()) {
          const queue = queues[index % 3];
          const suppliedTile = queue[0];
          const before = structuredClone(wall);
          const queuesBefore = structuredClone(queues);
          expect(canTakeSanmaReplacement(wall, kind, suppliedTile)).toBe(true);
          expect(wall).toEqual(before);
          const result = takeSanmaReplacement(wall, kind, suppliedTile)!;
          expect(queues).toEqual(queuesBefore);
          expect(result.tile).toBe(suppliedTile);
          drawn.push(result.tile);
          queue.shift();
          if (kind === "kan") {
            kanCount++;
            expect(result.indicators).toEqual({
              dora: initial.deadWall[4 + 2 * kanCount],
              ura: initial.deadWall[5 + 2 * kanCount],
            });
          } else {
            expect(result.indicators).toBeUndefined();
          }
          expect(wall.sanmaWall).toEqual({
            sanmaType,
            mode: "duplicate",
            replacementsTaken: index + 1,
            kanCount,
          });
          expect(wall.deadWall).toBe(physicalReserve);
          expect(wall.deadWall).toEqual(initial.deadWall);
          expect(wall.liveWall).toEqual(
            initial.liveWall.filter((tile) => !drawn.includes(tile))
          );
          expect(allWallTiles(wall, drawn)).toEqual(allWallTiles(initial));
          for (let pair = 0; pair <= kanCount; pair++) {
            expect(getSanmaIndicatorPair(wall, pair)).toEqual({
              dora: initial.deadWall[4 + 2 * pair],
              ura: initial.deadWall[5 + 2 * pair],
            });
          }
        }
        expectRejected(wall, "kan", wall.liveWall[0]);
        expectRejected(wall, "nuki", wall.liveWall[0]);
      }
    );
  });

  it.each(variants)(
    "requires a supplied %s queue tile and never falls back to the reserve",
    (sanmaType) => {
      const wall = labelledWall(sanmaType, "duplicate");
      expectRejected(wall, "kan");
      expectRejected(wall, "nuki");
      expectRejected(wall, "kan", "missing");
      expectRejected(wall, "nuki", wall.deadWall[0]);
      expectRejected(labelledWall(sanmaType, "duplicate", 0), "nuki", "live-0");
    }
  );

  it.each(kinds)(
    "permits %s with the final queue tile without reserving any other tile",
    (kind) => {
      const wall = labelledWall("kansai", "duplicate", 1);
      expect(takeSanmaReplacement(wall, kind, "live-0")?.tile).toBe("live-0");
      expect(wall.liveWall).toHaveLength(0);
      expect(wall.deadWall).toHaveLength(14);
      expectRejected(wall, "nuki", "live-0");
    }
  );

  it("removes exactly one matching live tile, retaining order and physical reserve", () => {
    const wall = labelledWall("kansai", "duplicate");
    wall.liveWall = ["5p", "1m", "0p", "5p", "4z"];
    wall.deadWall[0] = "5p";
    const physicalReserve = [...wall.deadWall];
    expect(takeSanmaReplacement(wall, "nuki", "5p")).toEqual({ tile: "5p" });
    expect(wall.liveWall).toEqual(["1m", "0p", "5p", "4z"]);
    expect(wall.deadWall).toEqual(physicalReserve);
    expect(takeSanmaReplacement(wall, "nuki", "0p")).toEqual({ tile: "0p" });
    expect(wall.liveWall).toEqual(["1m", "5p", "4z"]);
    expectRejected(wall, "nuki", "0p");
  });
});

describe("sanma replacement validation and recovery", () => {
  describe.each(variants)("%s", (sanmaType) => {
    describe.each(modes)("%s", (mode) => {
      it.each(kinds)(
        "limits %s to four independently of the other replacement cause",
        (kind) => {
          const wall = labelledWall(sanmaType, mode);
          for (let index = 0; index < 4; index++) {
            expect(
              takeSanmaReplacement(
                wall,
                kind,
                mode === "duplicate" ? wall.liveWall[0] : undefined
              )
            ).toBeDefined();
          }
          const suppliedTile =
            mode === "duplicate" ? wall.liveWall[0] : undefined;
          expectRejected(wall, kind, suppliedTile);
          expect(
            canTakeSanmaReplacement(
              wall,
              kind === "kan" ? "nuki" : "kan",
              suppliedTile
            )
          ).toBe(true);
        }
      );

      it("resumes a serialized mixed cursor without confusing nukis and kans", () => {
        const wall = labelledWall(sanmaType, mode);
        const order: SanmaReplacementKind[] = [
          "nuki",
          "kan",
          "nuki",
          "kan",
          "kan",
          "nuki",
          "nuki",
          "kan",
        ];
        for (const kind of order.slice(0, 3)) {
          takeSanmaReplacement(
            wall,
            kind,
            mode === "duplicate" ? wall.liveWall[0] : undefined
          );
        }
        const restored = JSON.parse(JSON.stringify(wall)) as SanmaWallContext;
        for (const kind of order.slice(3)) {
          const suppliedTile =
            mode === "duplicate" ? wall.liveWall[0] : undefined;
          expect(takeSanmaReplacement(restored, kind, suppliedTile)).toEqual(
            takeSanmaReplacement(wall, kind, suppliedTile)
          );
          expect(restored).toEqual(wall);
        }
      });

      it("preserves the original state when taking a replacement on a shallow clone", () => {
        const original = labelledWall(sanmaType, mode);
        const before = structuredClone(original);
        const next = { ...original };
        expect(
          takeSanmaReplacement(
            next,
            "kan",
            mode === "duplicate" ? next.liveWall[0] : undefined
          )
        ).toBeDefined();
        expect(original).toEqual(before);
        expect(next).not.toEqual(before);
      });

      it("conserves all real dealt tiles, including red fives", () => {
        const options = {
          playerCount: 3 as const,
          sanmaType,
          duplicate: mode === "duplicate",
          redFives: { m: 1, p: 1, s: 1 },
        };
        const deal = dealMatch(42, options);
        const drawn: Tile[] = [];
        for (const kind of [
          "nuki",
          "kan",
          "kan",
          "nuki",
          "nuki",
          "kan",
          "kan",
          "nuki",
        ] as const) {
          const result = takeSanmaReplacement(
            deal,
            kind,
            mode === "duplicate" ? deal.liveWall[0] : undefined
          )!;
          drawn.push(result.tile);
          expect(
            [...deal.hands.flat(), ...allWallTiles(deal, drawn)].sort()
          ).toEqual(buildAllTiles(options).sort());
        }
      });

      it.each([-1, 1])(
        "rejects a reserve with a %i-tile layout discrepancy",
        (difference) => {
          const wall = labelledWall(sanmaType, mode);
          if (difference === -1) {
            wall.deadWall.pop();
          } else {
            wall.deadWall.push("extra");
          }
          expectRejected(
            wall,
            "kan",
            mode === "duplicate" ? wall.liveWall[0] : undefined
          );
          expect(getSanmaIndicatorPair(wall)).toBeUndefined();
        }
      );
    });
  });

  it.each([
    { replacementsTaken: -1 },
    { replacementsTaken: 0.5 },
    { replacementsTaken: NaN },
    { replacementsTaken: Infinity },
    { replacementsTaken: 9 },
    { replacementsTaken: 5, kanCount: 0 },
    { kanCount: -1 },
    { kanCount: 0.5 },
    { kanCount: NaN },
    { kanCount: Infinity },
    { kanCount: 1 },
    { replacementsTaken: 5, kanCount: 5 },
    { mode: "unknown" },
    { sanmaType: "unknown" },
  ])("rejects malformed wall metadata %j without mutation", (invalid) => {
    const wall = labelledWall("online");
    Object.assign(wall.sanmaWall!, invalid);
    expectRejected(wall, "kan");
    expectRejected(wall, "nuki");
    expect(getSanmaIndicatorPair(wall)).toBeUndefined();
  });

  it("does not interpret missing sanma state as a legacy replacement request", () => {
    const wall = labelledWall("online");
    delete wall.sanmaWall;
    expectRejected(wall, "kan");
    expectRejected(wall, "nuki", wall.liveWall[0]);
    expect(getSanmaIndicatorPair(wall)).toBeUndefined();
  });

  it("rejects unknown replacement causes", () => {
    expectRejected(labelledWall("online"), "unknown" as SanmaReplacementKind);
  });

  it.each(variants)(
    "rejects a supplied queue tile in standard %s instead of switching sources",
    (sanmaType) => {
      const wall = labelledWall(sanmaType);
      expectRejected(wall, "kan", wall.liveWall[0]);
      expectRejected(wall, "nuki", wall.deadWall[0]);
    }
  );

  it.each(["replacement", "indicator", "live tail"] as const)(
    "rejects a missing %s without consuming anything",
    (missing) => {
      const wall = labelledWall("online");
      if (missing === "replacement") {
        delete wall.deadWall[0];
      } else if (missing === "indicator") {
        delete wall.deadWall[9];
      } else {
        delete wall.liveWall[wall.liveWall.length - 1];
      }
      expectRejected(wall, "kan");
      expectRejected(wall, "nuki");
    }
  );

  it.each([-1, 1, 1.5, NaN, Infinity, 5])(
    "does not expose an invalid or uncommitted indicator pair %s",
    (index) => {
      for (const mode of modes) {
        const wall = labelledWall("online", mode);
        const before = structuredClone(wall);
        expect(getSanmaIndicatorPair(wall, index)).toBeUndefined();
        expect(wall).toEqual(before);
      }
    }
  );
});
