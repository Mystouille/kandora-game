import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildAllTiles, dealMatch } from "./wall";
import type { PlayerCount, SanmaType } from "../protocol/seat";
import baseline from "../testing/fixtures/yonma-v7.json";

const sanmaTypes = ["online", "kansai"] as const;

describe("buildAllTiles", () => {
  it("yields 136 tiles by default", () => {
    expect(buildAllTiles()).toHaveLength(136);
  });

  it("contains exactly 4 of each of the 34 tile types", () => {
    const counts = new Map<string, number>();
    for (const t of buildAllTiles()) {
      counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    expect(counts.size).toBe(34);
    for (const c of counts.values()) {
      expect(c).toBe(4);
    }
  });

  it("builds the 144-tile MCR inventory with eight unique flowers", () => {
    const tiles = buildAllTiles({
      rulesFamily: "mcr",
      redFives: { m: 1, p: 1, s: 1 },
    });
    expect(tiles).toHaveLength(144);
    expect(tiles.filter((tile) => tile.endsWith("f"))).toEqual([
      "1f",
      "2f",
      "3f",
      "4f",
      "5f",
      "6f",
      "7f",
      "8f",
    ]);
    expect(tiles.some((tile) => tile.startsWith("0"))).toBe(false);
  });

  it("substitutes red fives per suit according to the per-suit counts", () => {
    const tiles = buildAllTiles({ redFives: { m: 1, p: 1, s: 1 } });
    expect(tiles).toHaveLength(136);
    expect(tiles.filter((t) => t === "0m")).toHaveLength(1);
    expect(tiles.filter((t) => t === "0p")).toHaveLength(1);
    expect(tiles.filter((t) => t === "0s")).toHaveLength(1);
    // Four total of each "5" slot — three regular + one red.
    expect(tiles.filter((t) => t === "5m")).toHaveLength(3);
    expect(tiles.filter((t) => t === "5p")).toHaveLength(3);
    expect(tiles.filter((t) => t === "5s")).toHaveLength(3);
  });

  it("supports asymmetric per-suit red-five counts", () => {
    const tiles = buildAllTiles({ redFives: { p: 2 } });
    expect(tiles).toHaveLength(136);
    expect(tiles.filter((t) => t === "0m")).toHaveLength(0);
    expect(tiles.filter((t) => t === "0p")).toHaveLength(2);
    expect(tiles.filter((t) => t === "0s")).toHaveLength(0);
    expect(tiles.filter((t) => t === "5m")).toHaveLength(4);
    expect(tiles.filter((t) => t === "5p")).toHaveLength(2);
    expect(tiles.filter((t) => t === "5s")).toHaveLength(4);
  });

  it.each(sanmaTypes)(
    "contains the exact %s inventory, including four Norths",
    (sanmaType) => {
      const manzu = sanmaType === "online" ? [1, 9] : [1, 5, 9];
      const expected = [
        ...manzu.map((rank) => `${rank}m`),
        ...Array.from({ length: 9 }, (_, rank) => `${rank + 1}p`),
        ...Array.from({ length: 9 }, (_, rank) => `${rank + 1}s`),
        ...Array.from({ length: 7 }, (_, rank) => `${rank + 1}z`),
      ].flatMap((tile) => Array<string>(4).fill(tile));
      const tiles = buildAllTiles({ playerCount: 3, sanmaType });
      expect(tiles).toHaveLength(sanmaType === "online" ? 108 : 112);
      expect([...tiles].sort()).toEqual(expected.sort());
      expect(tiles.filter((tile) => tile === "4z")).toHaveLength(4);
    }
  );

  describe.each(sanmaTypes)("%s red-five substitutions", (sanmaType) => {
    it.each([
      { label: "default", redFives: {}, expected: { m: 0, p: 0, s: 0 } },
      {
        label: "M-League",
        redFives: { m: 1, p: 1, s: 1 },
        expected: { m: 1, p: 1, s: 1 },
      },
      {
        label: "asymmetric",
        redFives: { m: 2, p: 3, s: 4 },
        expected: { m: 2, p: 3, s: 4 },
      },
      {
        label: "clamped",
        redFives: { m: 9, p: -1, s: 9 },
        expected: { m: 4, p: 0, s: 4 },
      },
      { label: "partial", redFives: { p: 2 }, expected: { m: 0, p: 2, s: 0 } },
    ])(
      "preserves $label suit settings without reintroducing absent tiles",
      ({ redFives, expected }) => {
        const tiles = buildAllTiles({ playerCount: 3, sanmaType, redFives });
        expect(tiles).toHaveLength(sanmaType === "online" ? 108 : 112);
        for (const suit of ["m", "p", "s"] as const) {
          const absent = suit === "m" && sanmaType === "online";
          const reds = absent ? 0 : expected[suit];
          expect(tiles.filter((tile) => tile === `0${suit}`)).toHaveLength(
            reds
          );
          expect(tiles.filter((tile) => tile === `5${suit}`)).toHaveLength(
            absent ? 0 : 4 - reds
          );
        }
      }
    );
  });

  it("ignores the inactive sanma variant for four players", () => {
    const redFives = { m: 1, p: 2, s: 3 };
    expect(
      buildAllTiles({
        playerCount: 4,
        sanmaType: "kansai",
        duplicate: true,
        redFives,
      })
    ).toEqual(buildAllTiles({ redFives }));
  });

  it("rejects unsupported player counts and active variants", () => {
    expect(() => buildAllTiles({ playerCount: 2 as PlayerCount })).toThrow();
    expect(() =>
      buildAllTiles({ playerCount: 3, sanmaType: "unknown" as SanmaType })
    ).toThrow();
  });
});

describe("dealMatch", () => {
  it.each(baseline.deals)(
    "matches the frozen pre-sanma deal digest for seed $seed",
    ({ seed, digest }) => {
      const dealt = dealMatch(seed, { redFives: { m: 1, p: 1, s: 1 } });
      expect(
        createHash("sha256").update(JSON.stringify(dealt)).digest("hex")
      ).toBe(digest);
    }
  );

  it("partitions all 136 tiles across hands + walls", () => {
    const dealt = dealMatch(42);
    const total =
      dealt.hands.reduce((n, h) => n + h.length, 0) +
      dealt.liveWall.length +
      dealt.deadWall.length;
    expect(total).toBe(136);
    expect(dealt.hands.map((h) => h.length)).toEqual([13, 13, 13, 13]);
    expect(dealt.deadWall).toHaveLength(14);
    expect(dealt.liveWall).toHaveLength(70);
  });

  it("deals and normalizes the complete MCR inventory", () => {
    const dealt = dealMatch(42, { rulesFamily: "mcr", dealer: 2 });
    expect(dealt.hands.map((hand) => hand.length)).toEqual([13, 13, 14, 13]);
    expect(dealt.hands.flat().some((tile) => tile.endsWith("f"))).toBe(false);
    expect(dealt.deadWall).toEqual([]);
    expect(dealt.doraIndicators).toEqual([]);
    expect(
      dealt.hands.flat().length +
        dealt.liveWall.length +
        (dealt.flowerTiles?.flat().length ?? 0)
    ).toBe(144);
    expect(dealt.flowerTiles?.flat().every((tile) => tile.endsWith("f"))).toBe(
      true
    );
  });

  it("assigns opening flower replacements in dealer order", () => {
    const seed = Array.from({ length: 500 }, (_, value) => value).find(
      (candidate) => {
        const east = dealMatch(candidate, {
          rulesFamily: "mcr",
          dealer: 0,
        });
        const south = dealMatch(candidate, {
          rulesFamily: "mcr",
          dealer: 1,
        });
        return (
          (east.flowerTiles?.flat().length ?? 0) >= 2 &&
          JSON.stringify(east.hands) !== JSON.stringify(south.hands)
        );
      }
    );
    expect(seed).toBeDefined();
    const first = dealMatch(seed as number, {
      rulesFamily: "mcr",
      dealer: 1,
    });
    expect(first.hands[1]).toHaveLength(14);
    expect(first.hands.flat().some((tile) => tile.endsWith("f"))).toBe(false);
  });

  it("is reproducible from the seed", () => {
    const a = dealMatch(2026);
    const b = dealMatch(2026);
    expect(a.hands).toEqual(b.hands);
    expect(a.liveWall).toEqual(b.liveWall);
    expect(a.deadWall).toEqual(b.deadWall);
    expect(a.doraIndicators).toEqual(b.doraIndicators);
  });

  it("differs across seeds", () => {
    const a = dealMatch(1);
    const b = dealMatch(2);
    expect(a.hands).not.toEqual(b.hands);
  });

  it("exposes one dora indicator at deadWall[4]", () => {
    const dealt = dealMatch(99);
    expect(dealt.doraIndicators).toEqual([dealt.deadWall[4]]);
  });

  it.each([
    { sanmaType: "online", duplicate: false, live: 55, dead: 14 },
    { sanmaType: "kansai", duplicate: false, live: 63, dead: 10 },
    { sanmaType: "online", duplicate: true, live: 55, dead: 14 },
    { sanmaType: "kansai", duplicate: true, live: 59, dead: 14 },
  ] as const)(
    "deals $sanmaType, Duplicate=$duplicate, with its exact reserve",
    (entry) => {
      const options = {
        playerCount: 3 as const,
        sanmaType: entry.sanmaType,
        duplicate: entry.duplicate,
        redFives: { m: 1, p: 1, s: 1 },
      };
      const dealt = dealMatch(42, options);
      expect(dealt.hands.map((hand) => hand.length)).toEqual([13, 13, 13]);
      expect(dealt.liveWall).toHaveLength(entry.live);
      expect(dealt.deadWall).toHaveLength(entry.dead);
      expect(dealt.doraIndicators).toEqual([
        dealt.deadWall[entry.duplicate ? 4 : 8],
      ]);
      expect(dealt.sanmaWall).toEqual({
        sanmaType: entry.sanmaType,
        mode: entry.duplicate ? "duplicate" : "standard",
        replacementsTaken: 0,
        kanCount: 0,
      });
      const allTiles = [
        ...dealt.hands.flat(),
        ...dealt.liveWall,
        ...dealt.deadWall,
      ];
      expect(allTiles.sort()).toEqual(buildAllTiles(options).sort());
      expect(dealMatch(42, options)).toEqual(dealt);
    }
  );

  it("defaults an explicit three-player deal to standard Online", () => {
    expect(dealMatch(99, { playerCount: 3 })).toEqual(
      dealMatch(99, { playerCount: 3, sanmaType: "online", duplicate: false })
    );
  });

  it("does not extract dealt Kansai fives before the engine initializes nuki", () => {
    const dealt = dealMatch(42, {
      playerCount: 3,
      sanmaType: "kansai",
      redFives: { m: 1 },
    });
    expect(dealt.hands.map((hand) => hand.length)).toEqual([13, 13, 13]);
    expect(
      dealt.hands.flat().some((tile) => tile === "5m" || tile === "0m")
    ).toBe(true);
    expect(dealt.liveWall).toHaveLength(63);
    expect(dealt.deadWall).toHaveLength(10);
    expect(dealt.sanmaWall?.replacementsTaken).toBe(0);
  });

  it.each([0, 1, 42, -7, 0xffffffff])(
    "preserves every default four-player field for seed %i",
    (seed) => {
      const options = { redFives: { m: 1, p: 1, s: 1 } };
      const legacy = dealMatch(seed, options);
      expect(legacy).not.toHaveProperty("sanmaWall");
      expect(
        dealMatch(seed, {
          ...options,
          playerCount: 4,
          sanmaType: "kansai",
          duplicate: true,
        })
      ).toEqual(legacy);
    }
  );
});
