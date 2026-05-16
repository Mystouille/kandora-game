import { describe, expect, it } from "vitest";
import { buildAllTiles, dealMatch } from "./wall";

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
});

describe("dealMatch", () => {
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
});
