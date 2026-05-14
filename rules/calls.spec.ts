/**
 * Tests for `enumerateCalls` — the pure helper the orchestrator uses
 * to surface chi/pon/kan/ron buttons after a discard. Each test
 * crafts a deterministic post-discard `MatchState` and asserts the
 * per-seat option lists.
 */

import { describe, expect, it } from "vitest";
import { createInitialState, type MatchState } from "./state";
import { enumerateCalls } from "./calls";
import type { Tile } from "./types";

function tiles(s: string): Tile[] {
  const out: Tile[] = [];
  let digits = "";
  for (const ch of s) {
    if (ch >= "0" && ch <= "9") {
      digits += ch;
    } else {
      for (const d of digits) {
        out.push(`${d}${ch}`);
      }
      digits = "";
    }
  }
  return out;
}

function craft(opts: {
  hands: Tile[][];
  discarder: 0 | 1 | 2 | 3;
  tile: Tile;
  dealer?: 0 | 1 | 2 | 3;
  riichiDeclared?: [boolean, boolean, boolean, boolean];
}): MatchState {
  const base = createInitialState(0);
  return {
    ...base,
    hands: opts.hands.map((h) => [...h]),
    discards: [[], [], [], []],
    turn: ((opts.discarder + 1) % 4) as 0 | 1 | 2 | 3,
    phase: "awaiting_draw",
    dealer: opts.dealer ?? 0,
    lastDrawn: [null, null, null, null],
    lastDiscard: { seat: opts.discarder, tile: opts.tile },
    riichiDeclared: opts.riichiDeclared ?? [false, false, false, false],
  };
}

const FILLER = tiles("1m2m3m4m5m6m7m8m9m1p2p3p4p"); // 13 inert tiles

describe("enumerateCalls — chi", () => {
  it("offers all three run shapes when partners are present", () => {
    // Discarded 5p by seat 0 → seat 1 (next) holds 34p, 46p, 67p → 3 chis.
    const seat1 = tiles("3p4p6p7p1m2m3m4m5m6m7m8m9m"); // 13
    const out = enumerateCalls(
      craft({
        hands: [FILLER, seat1, FILLER, FILLER],
        discarder: 0,
        tile: "5p",
      })
    );
    const s1 = out.find((o) => o.seat === 1);
    expect(s1?.options.filter((o) => o.kind === "chi").length).toBe(3);
  });

  it("does not offer chi to non-left seats", () => {
    const handWithPartners = tiles("3p4p6p7p1m2m3m4m5m6m7m8m9m");
    const out = enumerateCalls(
      craft({
        hands: [FILLER, FILLER, handWithPartners, FILLER],
        discarder: 0,
        tile: "5p",
      })
    );
    // Seat 2 is across, not left of discarder — must not get chi.
    const s2 = out.find((o) => o.seat === 2);
    expect(s2?.options.some((o) => o.kind === "chi") ?? false).toBe(false);
  });

  it("never offers chi on an honor discard", () => {
    const seat1 = tiles("5z6z7z1m2m3m4m5m6m7m8m9m1p");
    const out = enumerateCalls(
      craft({
        hands: [FILLER, seat1, FILLER, FILLER],
        discarder: 0,
        tile: "5z",
      })
    );
    const s1 = out.find((o) => o.seat === 1);
    expect(s1?.options.some((o) => o.kind === "chi") ?? false).toBe(false);
  });
});

describe("enumerateCalls — pon / daiminkan", () => {
  it("offers pon to any seat holding ≥2 matching tiles", () => {
    const seat2 = tiles("5p5p1m2m3m4m5m6m7m8m9m1p2p"); // two 5p
    const out = enumerateCalls(
      craft({
        hands: [FILLER, FILLER, seat2, FILLER],
        discarder: 0,
        tile: "5p",
      })
    );
    const s2 = out.find((o) => o.seat === 2);
    const pon = s2?.options.find((o) => o.kind === "pon");
    expect(pon).toBeDefined();
  });

  it("offers daiminkan (and pon) to any seat holding ≥3 matching tiles", () => {
    const seat2 = tiles("5p5p5p1m2m3m4m5m6m7m8m9m1p"); // three 5p
    const out = enumerateCalls(
      craft({
        hands: [FILLER, FILLER, seat2, FILLER],
        discarder: 0,
        tile: "5p",
      })
    );
    const s2 = out.find((o) => o.seat === 2);
    expect(s2?.options.some((o) => o.kind === "pon")).toBe(true);
    expect(s2?.options.some((o) => o.kind === "daiminkan")).toBe(true);
  });

  it("treats red 5 and white 5 as the same identity for pon", () => {
    // Caller has a red 5p plus a regular 5p; discard is a regular 5p.
    // Note: `tiles("05p")` parses as "0p" + "5p" (red 5p + white 5p).
    const seat2 = tiles("05p1m2m3m4m5m6m7m8m9m1p2p");
    const out = enumerateCalls(
      craft({
        hands: [FILLER, FILLER, seat2, FILLER],
        discarder: 0,
        tile: "5p",
      })
    );
    const s2 = out.find((o) => o.seat === 2);
    const pon = s2?.options.find((o) => o.kind === "pon");
    expect(pon).toBeDefined();
    if (pon?.kind === "pon") {
      // Red 5 preferred — should appear in the meld tiles.
      // (Red 5 of pinzu encodes as "0p".)
      expect(pon.tiles).toContain("0p");
    }
  });

  it("never offers chi/pon/daiminkan to a seat in riichi", () => {
    const ponable = tiles("5p5p5p1m2m3m4m5m6m7m8m9m1p");
    const out = enumerateCalls(
      craft({
        hands: [FILLER, FILLER, ponable, FILLER],
        discarder: 0,
        tile: "5p",
        riichiDeclared: [false, false, true, false],
      })
    );
    const s2 = out.find((o) => o.seat === 2);
    // Riichi locks: no chi/pon/daiminkan options.
    const callKinds = s2?.options
      .filter((o) => o.kind !== "ron")
      .map((o) => o.kind);
    expect(callKinds ?? []).toEqual([]);
  });
});

describe("enumerateCalls — ron", () => {
  it("offers ron when a non-discarder can win on the discard", () => {
    // Seat 2: tanyao tenpai waiting on 5p (33m 44p 55p 66s 77p 88m … etc).
    // Simplest reliable shape: pinfu-able 234m 234p 234s 567s 22m + ron 5p?
    // Use a chiitoitsu wait so yaku is guaranteed.
    // Chiitoitsu requires 6 pairs + a wait → win tile completes the 7th pair.
    const seat2 = tiles("1m1m2p2p3s3s4m4m5p6p6p7s7s"); // 13, missing 5p partner
    const out = enumerateCalls(
      craft({
        hands: [FILLER, FILLER, seat2, FILLER],
        discarder: 0,
        tile: "5p",
      })
    );
    const s2 = out.find((o) => o.seat === 2);
    expect(s2?.options.some((o) => o.kind === "ron")).toBe(true);
  });

  it("offers ron even when seat is in riichi", () => {
    const seat2 = tiles("1m1m2p2p3s3s4m4m5p6p6p7s7s");
    const out = enumerateCalls(
      craft({
        hands: [FILLER, FILLER, seat2, FILLER],
        discarder: 0,
        tile: "5p",
        riichiDeclared: [false, false, true, false],
      })
    );
    const s2 = out.find((o) => o.seat === 2);
    expect(s2?.options.some((o) => o.kind === "ron")).toBe(true);
  });

  it("does not offer ron when no yaku is available", () => {
    // 11m pair (terminal → no tanyao) + 33p + 234s + 567s + 567p,
    // winning on 3p via shanpon (pinfu fails). No honors, no
    // matching sanshoku, no riichi → no yaku.
    const seat2 = tiles("1m1m3p3p2s3s4s5s6s7s5p6p7p");
    const out = enumerateCalls(
      craft({
        hands: [FILLER, FILLER, seat2, FILLER],
        discarder: 0,
        tile: "3p",
      })
    );
    const s2 = out.find((o) => o.seat === 2);
    expect(s2?.options.some((o) => o.kind === "ron") ?? false).toBe(false);
  });
});

describe("enumerateCalls — preconditions", () => {
  it("returns [] when state is not in awaiting_draw", () => {
    const base = craft({
      hands: [FILLER, FILLER, FILLER, FILLER],
      discarder: 0,
      tile: "5p",
    });
    const out = enumerateCalls({ ...base, phase: "awaiting_discard" });
    expect(out).toEqual([]);
  });

  it("returns [] when no lastDiscard is set", () => {
    const base = craft({
      hands: [FILLER, FILLER, FILLER, FILLER],
      discarder: 0,
      tile: "5p",
    });
    const out = enumerateCalls({ ...base, lastDiscard: null });
    expect(out).toEqual([]);
  });

  it("excludes the discarder from the output", () => {
    const ponable = tiles("5p5p1m2m3m4m5m6m7m8m9m1p2p");
    const out = enumerateCalls(
      craft({
        hands: [ponable, FILLER, FILLER, FILLER],
        discarder: 0,
        tile: "5p",
      })
    );
    expect(out.every((o) => o.seat !== 0)).toBe(true);
  });
});
