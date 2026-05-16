/**
 * Pao (sekinin barai) tests:
 *   - Detection: completing the third dragon pon/kan via a call
 *     (pon or daiminkan, NOT shouminkan or ankan) marks the
 *     discarder as the daisangen pao payer for the caller.
 *   - Same for the fourth distinct wind → daisuushii.
 *   - Payment redirect:
 *       · ron: discarder pays nothing, pao payer pays full ron.
 *       · tsumo: pao payer absorbs all three non-winners' shares.
 *       · pao payer == discarder: no change.
 */

import { describe, expect, it } from "vitest";
import { createInitialState, type MatchState, type Meld } from "./state";
import { step } from "./step";
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
  melds?: Meld[][];
  turn: 0 | 1 | 2 | 3;
  phase: "awaiting_draw" | "awaiting_discard";
  dealer?: 0 | 1 | 2 | 3;
  lastDiscard?: { seat: 0 | 1 | 2 | 3; tile: Tile };
  lastDrawn?: Tile;
  paoDaisangen?: (0 | 1 | 2 | 3 | null)[];
  paoDaisuushii?: (0 | 1 | 2 | 3 | null)[];
}): MatchState {
  const base = createInitialState(0);
  const dealer = opts.dealer ?? 0;
  return {
    ...base,
    hands: opts.hands.map((h) => [...h]),
    discards: [[], [], [], []],
    liveWall: Array.from({ length: 30 }, () => "1m" as Tile),
    melds: opts.melds ?? [[], [], [], []],
    turn: opts.turn,
    phase: opts.phase,
    dealer,
    lastDiscard: opts.lastDiscard ?? null,
    lastDrawn: [null, null, null, null].map((_, i) =>
      i === opts.turn && opts.lastDrawn ? opts.lastDrawn : null
    ) as (Tile | null)[],
    doraIndicators: [],
    uraDoraIndicators: [],
    scores: [25000, 25000, 25000, 25000],
    lastHandResult: null,
    furitenLocked: [false, false, false, false],
    furitenTemp: [false, false, false, false],
    paoDaisangen: opts.paoDaisangen ?? [null, null, null, null],
    paoDaisuushii: opts.paoDaisuushii ?? [null, null, null, null],
  };
}

describe("pao — detection", () => {
  it("marks daisangen pao when third dragon pon is called", () => {
    // Seat 1 already has pons of 5z and 6z; pons 7z from seat 0.
    const haku: Meld = {
      type: "pon",
      tiles: ["5z", "5z", "5z"],
      claimedTile: "5z",
      from: 2,
    };
    const hatsu: Meld = {
      type: "pon",
      tiles: ["6z", "6z", "6z"],
      claimedTile: "6z",
      from: 3,
    };
    const state = craft({
      hands: [
        tiles("9p9p9p9p9p9p9p9p9p9p9p9p9p"),
        tiles("7z7z1m2m3m4m5m"), // need 7z + 7z to pon
        tiles("9p9p9p9p9p9p9p9p9p9p9p9p9p"),
        tiles("9p9p9p9p9p9p9p9p9p9p9p9p9p"),
      ],
      melds: [[], [haku, hatsu], [], []],
      turn: 1,
      phase: "awaiting_draw",
      dealer: 0,
      lastDiscard: { seat: 0, tile: "7z" },
    });
    const { state: next } = step(state, {
      type: "pon",
      seat: 1,
      tiles: ["7z", "7z"],
    });
    expect(next.paoDaisangen[1]).toBe(0);
    expect(next.paoDaisuushii[1]).toBe(null);
  });

  it("marks daisuushii pao when fourth wind pon is called", () => {
    const east: Meld = {
      type: "pon",
      tiles: ["1z", "1z", "1z"],
      claimedTile: "1z",
      from: 0,
    };
    const south: Meld = {
      type: "pon",
      tiles: ["2z", "2z", "2z"],
      claimedTile: "2z",
      from: 0,
    };
    const west: Meld = {
      type: "pon",
      tiles: ["3z", "3z", "3z"],
      claimedTile: "3z",
      from: 0,
    };
    const state = craft({
      hands: [
        tiles("9p9p9p9p9p9p9p9p9p9p9p9p9p"),
        tiles("4z4z1m2m3m4m"),
        tiles("9p9p9p9p9p9p9p9p9p9p9p9p9p"),
        tiles("9p9p9p9p9p9p9p9p9p9p9p9p9p"),
      ],
      melds: [[], [east, south, west], [], []],
      turn: 1,
      phase: "awaiting_draw",
      dealer: 0,
      lastDiscard: { seat: 2, tile: "4z" },
    });
    const { state: next } = step(state, {
      type: "pon",
      seat: 1,
      tiles: ["4z", "4z"],
    });
    expect(next.paoDaisuushii[1]).toBe(2);
    expect(next.paoDaisangen[1]).toBe(null);
  });

  it("does NOT mark pao on a third dragon ankan (concealed)", () => {
    // Ankan goes through the kan handler with no `lastDiscard`;
    // detectPao isn't called from that path.
    const haku: Meld = {
      type: "pon",
      tiles: ["5z", "5z", "5z"],
      claimedTile: "5z",
      from: 0,
    };
    const hatsu: Meld = {
      type: "pon",
      tiles: ["6z", "6z", "6z"],
      claimedTile: "6z",
      from: 0,
    };
    const state = craft({
      hands: [
        tiles("9p9p9p9p9p9p9p9p9p9p9p9p9p"),
        tiles("7z7z7z7z1m2m3m"), // 4 of 7z in hand → ankan
        tiles("9p9p9p9p9p9p9p9p9p9p9p9p9p"),
        tiles("9p9p9p9p9p9p9p9p9p9p9p9p9p"),
      ],
      melds: [[], [haku, hatsu], [], []],
      turn: 1,
      phase: "awaiting_discard",
      dealer: 0,
      lastDrawn: "7z",
    });
    const { state: next } = step(state, {
      type: "kan",
      seat: 1,
      kind: "ankan",
      tile: "7z",
    });
    expect(next.paoDaisangen[1]).toBe(null);
  });
});

describe("pao — payment override", () => {
  it("ron with daisangen pao: pao payer pays full, discarder pays 0", () => {
    // Seat 1 wins daisangen by ron. paoDaisangen[1] = 2; discarder = 0.
    // Pao payer (2) should bear the full payment.
    // Hand: 5z5z5z 6z6z6z 7z7z 1m1m 2m2m + ron on 1m? Need a valid
    // daisangen agari shape. Use three open dragon pons + pair + ron.
    const haku: Meld = {
      type: "pon",
      tiles: ["5z", "5z", "5z"],
      claimedTile: "5z",
      from: 2,
    };
    const hatsu: Meld = {
      type: "pon",
      tiles: ["6z", "6z", "6z"],
      claimedTile: "6z",
      from: 2,
    };
    const chun: Meld = {
      type: "pon",
      tiles: ["7z", "7z", "7z"],
      claimedTile: "7z",
      from: 2,
    };
    // Concealed portion: 13 - 3*3 = 4 tiles. Need pair + something
    // that completes on the win tile. Use 1m1m + 2m + ron 2m? That
    // leaves 222m as a triplet → valid.
    const state = craft({
      hands: [
        tiles("9p9p9p9p9p9p9p9p9p9p9p9p9p"),
        tiles("1m1m2m2m"),
        tiles("9p9p9p9p9p9p9p9p9p9p9p9p9p"),
        tiles("9p9p9p9p9p9p9p9p9p9p9p9p9p"),
      ],
      melds: [[], [haku, hatsu, chun], [], []],
      turn: 1,
      phase: "awaiting_draw",
      dealer: 0,
      lastDiscard: { seat: 0, tile: "1m" },
      paoDaisangen: [null, 2, null, null],
    });
    const { state: next } = step(state, { type: "ron", seat: 1 });
    expect(next.lastHandResult?.reason).toBe("ron");
    const delta = next.lastHandResult?.delta;
    // Daisangen yakuman ron, non-dealer winner: 32000.
    expect(delta?.[1]).toBe(32000);
    expect(delta?.[2]).toBe(-32000);
    expect(delta?.[0]).toBe(0); // discarder is exempt under pao
    expect(delta?.[3]).toBe(0);
  });

  it("tsumo with daisuushii pao: payer absorbs full amount", () => {
    // Seat 1 wins daisuushii by tsumo. paoDaisuushii[1] = 0.
    // Non-dealer tsumo yakuman: 32000 split (16000 from dealer +
    // 8000 from each non-dealer). Pao redirects: pao payer pays
    // 32000, others pay 0.
    const east: Meld = {
      type: "pon",
      tiles: ["1z", "1z", "1z"],
      claimedTile: "1z",
      from: 0,
    };
    const south: Meld = {
      type: "pon",
      tiles: ["2z", "2z", "2z"],
      claimedTile: "2z",
      from: 0,
    };
    const west: Meld = {
      type: "pon",
      tiles: ["3z", "3z", "3z"],
      claimedTile: "3z",
      from: 0,
    };
    const north: Meld = {
      type: "pon",
      tiles: ["4z", "4z", "4z"],
      claimedTile: "4z",
      from: 0,
    };
    // Concealed: 13 - 12 = 1 tile + draw = 2-tile pair. Use 1m1m.
    const state = craft({
      hands: [
        tiles("9p9p9p9p9p9p9p9p9p9p9p9p9p"),
        tiles("1m1m"),
        tiles("9p9p9p9p9p9p9p9p9p9p9p9p9p"),
        tiles("9p9p9p9p9p9p9p9p9p9p9p9p9p"),
      ],
      melds: [[], [east, south, west, north], [], []],
      turn: 1,
      phase: "awaiting_discard",
      dealer: 0,
      lastDrawn: "1m",
      paoDaisuushii: [null, 0, null, null],
    });
    const { state: next } = step(state, { type: "tsumo", seat: 1 });
    const delta = next.lastHandResult?.delta;
    expect(delta?.[1]).toBe(64000);
    expect(delta?.[0]).toBe(-64000); // pao payer absorbs all
    expect(delta?.[2]).toBe(0);
    expect(delta?.[3]).toBe(0);
  });

  it("pao does not apply when winner agaris on a different yaku", () => {
    // Recorded paoDaisangen but the winning shape is chiitoitsu
    // (no daisangen). Ensure pao redirect does NOT trigger.
    const concealed = tiles("11m22p33s44m55p66s");
    const state = craft({
      hands: [
        tiles("9p9p9p9p9p9p9p9p9p9p9p9p9p"),
        [...concealed, "7z"], // 13 closed tenpai on 7z
        tiles("9p9p9p9p9p9p9p9p9p9p9p9p9p"),
        tiles("9p9p9p9p9p9p9p9p9p9p9p9p9p"),
      ],
      turn: 1,
      phase: "awaiting_draw",
      dealer: 0,
      lastDiscard: { seat: 0, tile: "7z" },
      paoDaisangen: [null, 2, null, null], // recorded but irrelevant
    });
    const { state: next } = step(state, { type: "ron", seat: 1 });
    expect(next.lastHandResult?.reason).toBe("ron");
    const delta = next.lastHandResult?.delta;
    // Discarder (seat 0) pays the full chiitoitsu non-dealer ron.
    expect(delta?.[0]).toBeLessThan(0);
    expect(delta?.[2]).toBe(0); // pao payer untouched
  });
});
