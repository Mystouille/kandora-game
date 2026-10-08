import { describe, expect, it } from "vitest";
import type { PlayerCount, Seat } from "../protocol/seat";
import { distributePayments } from "./payments";
import {
  buildRiichiInput,
  indicatorToDora,
  scoreHand,
  type ScoreInput,
  type ScoreResult,
} from "./score";
import type { Meld } from "./state";
import type { Tile } from "./types";

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

const hakuPon: Meld = {
  type: "pon",
  tiles: tiles("555z"),
  claimedTile: "5z",
  from: 2,
};

const oneHan: ScoreInput = {
  hand: tiles("123p1267899s"),
  winTile: "3s",
  tsumo: false,
  melds: [hakuPon],
};

const closedHand: ScoreInput = {
  hand: tiles("123p1267899s555z"),
  winTile: "3s",
  tsumo: false,
  riichi: true,
};

function expectBalancedPayments(
  score: ScoreResult,
  tsumo: boolean,
  dealerWinner: boolean
): void {
  const winner = dealerWinner ? 0 : 1;
  const delta = distributePayments({
    score,
    winner,
    dealer: 0,
    loser: tsumo ? null : 2,
    playerCount: 3,
  });
  expect(delta).toHaveLength(3);
  expect(delta.reduce((sum, amount) => sum + amount, 0)).toBe(0);
  expect(delta[winner]).toBe(score.ten);
  expect(delta.filter((amount) => amount < 0)).toHaveLength(tsumo ? 2 : 1);
  expect(score.text).toContain(` ${score.ten}点`);
  expect(score.raw).toMatchObject({
    ten: score.ten,
    oya: score.oya,
    ko: score.ko,
    text: score.text,
  });
}

describe("sanma indicator cycles", () => {
  it.each([
    ["online", "1m", "9m"],
    ["online", "9m", "1m"],
    ["kansai", "1m", "5m"],
    ["kansai", "5m", "9m"],
    ["kansai", "0m", "9m"],
    ["kansai", "9m", "1m"],
  ] as const)("%s: %s indicates %s", (sanmaType, indicator, dora) => {
    expect(indicatorToDora(indicator, { playerCount: 3, sanmaType })).toBe(
      dora
    );
  });

  it.each(["online", "kansai"] as const)(
    "preserves pin, sou, wind and dragon cycles in %s",
    (sanmaType) => {
      for (const [indicator, dora] of [
        ["9p", "1p"],
        ["0p", "6p"],
        ["9s", "1s"],
        ["0s", "6s"],
        ["1z", "2z"],
        ["2z", "3z"],
        ["3z", "4z"],
        ["4z", "1z"],
        ["5z", "6z"],
        ["6z", "7z"],
        ["7z", "5z"],
      ] as const) {
        expect(indicatorToDora(indicator, { playerCount: 3, sanmaType })).toBe(
          dora
        );
      }
    }
  );

  it("retains the legacy cycle unless three-player mode is explicit", () => {
    expect(indicatorToDora("1m")).toBe("2m");
    expect(indicatorToDora("1m", { sanmaType: "kansai" })).toBe("2m");
    expect(indicatorToDora("0m", { playerCount: 4, sanmaType: "kansai" })).toBe(
      "6m"
    );
  });

  it.each(["online", "kansai"] as const)(
    "translates indicators in the library input without appending nuki to the hand (%s)",
    (sanmaType) => {
      const input = {
        ...closedHand,
        playerCount: 3 as const,
        sanmaType,
        nukiTiles: tiles(sanmaType === "online" ? "44z" : "05m"),
        doraIndicators: tiles("19m"),
      };
      const encoded = buildRiichiInput(input);
      expect(encoded).toBe(
        `${buildRiichiInput(closedHand)}+d${sanmaType === "online" ? "19" : "15"}m`
      );
    }
  );

  it.each(["online", "kansai"] as const)(
    "counts variant dora in ordinary melds in %s",
    (sanmaType) => {
      const manzu = sanmaType === "online" ? "9m" : "1m";
      const score = scoreHand({
        hand: tiles("12678s99p"),
        winTile: "3s",
        tsumo: false,
        playerCount: 3,
        sanmaType,
        doraIndicators: [sanmaType === "online" ? "1m" : "9m"],
        melds: [
          hakuPon,
          {
            type: "pon",
            tiles: [manzu, manzu, manzu],
            claimedTile: manzu,
            from: 2,
          },
        ],
      });
      expect(score).toMatchObject({ han: 4, doraCount: 3 });
      expect(score.yaku["ドラ"]).toBe("3飜");
    }
  );
});

describe("Online scoring", () => {
  it.each([
    { tsumo: false, seatWind: "E", ten: 1500, oya: [1500], ko: [1000] },
    { tsumo: false, seatWind: "S", ten: 1000, oya: [1500], ko: [1000] },
    { tsumo: true, seatWind: "E", ten: 1000, oya: [500, 500], ko: [500, 300] },
    { tsumo: true, seatWind: "S", ten: 800, oya: [500, 500], ko: [500, 300] },
  ] as const)(
    "uses only actual opponents: tsumo=$tsumo, wind=$seatWind",
    ({ tsumo, seatWind, ten, oya, ko }) => {
      const score = scoreHand({ ...oneHan, playerCount: 3, tsumo, seatWind });
      expect(score).toMatchObject({
        isAgari: true,
        han: 1,
        fu: 30,
        ten,
        oya,
        ko,
      });
      expectBalancedPayments(score, tsumo, seatWind === "E");
      const legacy = scoreHand({ ...oneHan, tsumo, seatWind });
      expect(score.han).toBe(legacy.han);
      expect(score.fu).toBe(legacy.fu);
      if (!tsumo) {
        expect(score.ten).toBe(legacy.ten);
      }
    }
  );

  it.each([false, true])("retains M-League kiriage with tsumo=%s", (tsumo) => {
    const input: ScoreInput = {
      ...oneHan,
      playerCount: 3,
      tsumo,
      doraIndicators: ["7z"],
    };
    const before = scoreHand(input);
    const promoted = scoreHand({ ...input, kiriageMangan: true });
    expect(before).toMatchObject({ han: 4, fu: 30, ten: tsumo ? 5900 : 7700 });
    expect(promoted).toMatchObject({
      han: 4,
      fu: 30,
      ten: tsumo ? 6000 : 8000,
    });
    expect(promoted.text).toContain("満貫");
    expectBalancedPayments(promoted, tsumo, false);
  });

  it("retains the 3-han 60-fu kiriage boundary", () => {
    const score = scoreHand({
      hand: tiles("12678s99p"),
      winTile: "3s",
      tsumo: true,
      playerCount: 3,
      kiriageMangan: true,
      doraIndicators: ["5s", "6s"],
      melds: [
        hakuPon,
        { type: "ankan", tiles: tiles("1111m"), claimedTile: null, from: null },
      ],
    });
    expect(score).toMatchObject({ han: 3, fu: 60, ten: 6000 });
    expect(score.ko).toEqual([4000, 2000]);
    expectBalancedPayments(score, true, false);
  });
});

const kansaiRows = [
  {
    han: 1,
    dealerRon: 2000,
    dealerEach: 1000,
    ron: 1000,
    other: 1000,
    dealer: 1000,
  },
  {
    han: 2,
    dealerRon: 3000,
    dealerEach: 2000,
    ron: 2000,
    other: 1000,
    dealer: 1000,
  },
  {
    han: 3,
    dealerRon: 6000,
    dealerEach: 3000,
    ron: 4000,
    other: 1000,
    dealer: 3000,
  },
  {
    han: 4,
    dealerRon: 12000,
    dealerEach: 6000,
    ron: 8000,
    other: 3000,
    dealer: 5000,
  },
  {
    han: 5,
    dealerRon: 12000,
    dealerEach: 6000,
    ron: 8000,
    other: 3000,
    dealer: 5000,
  },
  {
    han: 6,
    dealerRon: 18000,
    dealerEach: 9000,
    ron: 12000,
    other: 4000,
    dealer: 8000,
  },
  {
    han: 7,
    dealerRon: 18000,
    dealerEach: 9000,
    ron: 12000,
    other: 4000,
    dealer: 8000,
  },
  {
    han: 8,
    dealerRon: 24000,
    dealerEach: 12000,
    ron: 16000,
    other: 6000,
    dealer: 10000,
  },
  {
    han: 9,
    dealerRon: 24000,
    dealerEach: 12000,
    ron: 16000,
    other: 6000,
    dealer: 10000,
  },
  {
    han: 10,
    dealerRon: 24000,
    dealerEach: 12000,
    ron: 16000,
    other: 6000,
    dealer: 10000,
  },
  {
    han: 11,
    dealerRon: 36000,
    dealerEach: 18000,
    ron: 24000,
    other: 8000,
    dealer: 16000,
  },
  {
    han: 12,
    dealerRon: 36000,
    dealerEach: 18000,
    ron: 24000,
    other: 8000,
    dealer: 16000,
  },
  {
    han: 13,
    dealerRon: 48000,
    dealerEach: 24000,
    ron: 32000,
    other: 12000,
    dealer: 20000,
  },
  {
    han: 14,
    dealerRon: 48000,
    dealerEach: 24000,
    ron: 32000,
    other: 12000,
    dealer: 20000,
  },
  {
    han: 16,
    dealerRon: 48000,
    dealerEach: 24000,
    ron: 32000,
    other: 12000,
    dealer: 20000,
  },
] as const;

describe("literal Kansai han-only payments", () => {
  for (const tsumo of [false, true]) {
    for (const seatWind of ["E", "S"] as const) {
      it.each(kansaiRows)(
        `$han han, tsumo=${tsumo}, wind=${seatWind}`,
        ({ han, dealerRon, dealerEach, ron, other, dealer }) => {
          const doraIndicators: Tile[] = [
            ...Array<Tile>(Math.floor((han - 1) / 3)).fill("7z"),
            ...Array<Tile>((han - 1) % 3).fill("2p"),
          ];
          const score = scoreHand({
            ...oneHan,
            playerCount: 3,
            sanmaType: "kansai",
            tsumo,
            seatWind,
            doraIndicators,
          });
          const ten = tsumo
            ? seatWind === "E"
              ? dealerEach * 2
              : other + dealer
            : seatWind === "E"
              ? dealerRon
              : ron;
          expect(score).toMatchObject({
            isAgari: true,
            han,
            ten,
            yakumanCount: 0,
          });
          expect(score.oya).toEqual(
            tsumo ? [dealerEach, dealerEach] : [dealerRon]
          );
          expect(score.ko).toEqual(tsumo ? [dealer, other] : [ron]);
          expect(score.text).not.toContain("符");
          if (tsumo) {
            expect(score.text).toContain(
              seatWind === "E" ? `(${dealerEach}all)` : `(${dealer},${other})`
            );
          }
          expectBalancedPayments(score, tsumo, seatWind === "E");
        }
      );
    }
  }

  it.each([false, true])(
    "prices 30-fu and 40-fu hands identically, tsumo=%s",
    (tsumo) => {
      const input = {
        ...oneHan,
        playerCount: 3 as const,
        sanmaType: "kansai" as const,
        tsumo,
      };
      const lowFu = scoreHand(input);
      const highFu = scoreHand({
        ...input,
        melds: [{ ...hakuPon, type: "daiminkan", tiles: tiles("5555z") }],
        kiriageMangan: true,
      });
      expect(lowFu.fu).toBe(30);
      expect(highFu.fu).toBe(40);
      expect(highFu.han).toBe(lowFu.han);
      expect(highFu.ten).toBe(lowFu.ten);
      expect(highFu.text).toBe(lowFu.text);
    }
  );
});

describe("nuki bonuses", () => {
  it.each(["online", "kansai"] as const)(
    "only applies ura to a menzen riichi win in %s",
    (sanmaType) => {
      const variant = {
        playerCount: 3 as const,
        sanmaType,
        nukiTiles: tiles(sanmaType === "online" ? "4z" : "5m"),
        uraDoraIndicators: [sanmaType === "online" ? "3z" : "1m"] as Tile[],
      };
      for (const flags of [{}, { riichi: true }, { doubleRiichi: true }]) {
        const open = scoreHand({ ...oneHan, ...variant, ...flags });
        expect(open).toMatchObject({ han: 2, uraDoraCount: 0 });
        expect(open.yaku["裏ドラ"]).toBeUndefined();
      }
      const unriichi = scoreHand({ ...closedHand, ...variant, riichi: false });
      expect(unriichi).toMatchObject({ han: 2, uraDoraCount: 0 });
      const doubleRiichi = scoreHand({
        ...closedHand,
        ...variant,
        doubleRiichi: true,
      });
      expect(doubleRiichi).toMatchObject({ han: 5, uraDoraCount: 1 });
      expect(doubleRiichi.yaku).toMatchObject({
        ダブル立直: "2飜",
        裏ドラ: "1飜",
      });
    }
  );

  it("adds North nuki, repeated ordinary dora and ura without opening the hand", () => {
    const nukiTiles = Object.freeze(tiles("44z"));
    const score = scoreHand({
      ...closedHand,
      playerCount: 3,
      nukiTiles,
      doraIndicators: ["3z", "3z"],
      uraDoraIndicators: ["3z"],
    });
    expect(score).toMatchObject({
      han: 10,
      doraCount: 4,
      uraDoraCount: 2,
      akaDoraCount: 0,
    });
    expect(score.yaku).toMatchObject({
      立直: "1飜",
      役牌白: "1飜",
      ドラ: "4飜",
      裏ドラ: "2飜",
      抜きドラ: "2飜",
    });
    expect(nukiTiles).toEqual(tiles("44z"));
  });

  it.each([false, true])(
    "counts red Kansai nuki with indicator/ura, noAka=%s",
    (noAka) => {
      const score = scoreHand({
        ...closedHand,
        playerCount: 3,
        sanmaType: "kansai",
        nukiTiles: tiles("05m"),
        doraIndicators: ["1m"],
        uraDoraIndicators: ["1m"],
        noAka,
      });
      expect(score).toMatchObject({
        han: noAka ? 8 : 9,
        doraCount: 2,
        uraDoraCount: 2,
        akaDoraCount: noAka ? 0 : 1,
      });
      expect(score.yaku).toMatchObject({
        立直: "1飜",
        ドラ: "2飜",
        裏ドラ: "2飜",
        抜きドラ: "2飜",
      });
      expect(score.yaku["赤ドラ"]).toBe(noAka ? undefined : "1飜");
      expect(Object.keys(score.yaku).at(-1)).toBe("抜きドラ");
    }
  );

  it.each(["online", "kansai"] as const)(
    "adds one han for every extraction in %s",
    (sanmaType) => {
      const tile = sanmaType === "online" ? "4z" : "5m";
      const base = scoreHand({ ...oneHan, playerCount: 3, sanmaType });
      for (let count = 1; count <= 4; count++) {
        const score = scoreHand({
          ...oneHan,
          playerCount: 3,
          sanmaType,
          nukiTiles: Array<Tile>(count).fill(tile),
        });
        expect(score.han).toBe(base.han + count);
        expect(score.yaku["抜きドラ"]).toBe(`${count}飜`);
      }
    }
  );

  it.each(["online", "kansai"] as const)(
    "cannot qualify an otherwise yaku-less hand in %s",
    (sanmaType) => {
      const score = scoreHand({
        hand: tiles("12678p12399s"),
        winTile: "3p",
        tsumo: true,
        playerCount: 3,
        sanmaType,
        melds: [
          { type: "pon", tiles: tiles("111m"), claimedTile: "1m", from: 2 },
        ],
        nukiTiles: tiles(sanmaType === "online" ? "4444z" : "0555m"),
        doraIndicators: ["9m", "1m", "3z"],
        uraDoraIndicators: ["1m", "3z"],
      });
      expect(score.han).toBe(0);
      expect(score.yakumanCount).toBe(0);
      expect(score.ten).toBe(0);
      expect(score.yaku).toEqual({});
      expect(
        distributePayments({
          score,
          winner: 1,
          dealer: 0,
          loser: null,
          playerCount: 3,
        })
      ).toEqual([0, 0, 0]);
    }
  );

  it("does not turn a North pair, pon or kan into nuki", () => {
    const pair = scoreHand({
      hand: tiles("123p12678s44555z"),
      winTile: "3s",
      tsumo: false,
      playerCount: 3,
      doraIndicators: ["3z"],
    });
    expect(pair).toMatchObject({ han: 3, doraCount: 2 });
    expect(pair.yaku["抜きドラ"]).toBeUndefined();
    for (const type of ["pon", "daiminkan", "ankan"] as const) {
      const score = scoreHand({
        hand: tiles("12678s99p"),
        winTile: "3s",
        tsumo: false,
        playerCount: 3,
        doraIndicators: ["3z"],
        melds: [
          hakuPon,
          {
            type,
            tiles: tiles(type === "pon" ? "444z" : "4444z"),
            claimedTile: type === "ankan" ? null : "4z",
            from: type === "ankan" ? null : 2,
          },
        ],
      });
      expect(score.doraCount).toBe(type === "pon" ? 3 : 4);
      expect(score.han).toBe(1 + score.doraCount);
      expect(score.yaku["抜きドラ"]).toBeUndefined();
    }
  });

  it("does not extract or count aka from an indicator", () => {
    const score = scoreHand({
      ...closedHand,
      playerCount: 3,
      sanmaType: "kansai",
      doraIndicators: ["0m"],
    });
    expect(score.han).toBe(2);
    expect(score.akaDoraCount).toBe(0);
    expect(score.yaku["抜きドラ"]).toBeUndefined();
  });

  it.each(["online", "kansai"] as const)(
    "honors nuki replacement rinshan and North robbery chankan flags in %s",
    (sanmaType) => {
      const replacement = scoreHand({
        ...closedHand,
        tsumo: true,
        playerCount: 3,
        sanmaType,
        rinshanOrChankan: true,
        nukiTiles: tiles(sanmaType === "online" ? "4z" : "5m"),
      });
      expect(replacement.yaku).toMatchObject({
        立直: "1飜",
        門前清自摸和: "1飜",
        嶺上開花: "1飜",
        抜きドラ: "1飜",
      });
      const robbery = scoreHand({
        ...closedHand,
        playerCount: 3,
        sanmaType,
        rinshanOrChankan: true,
      });
      expect(robbery.yaku["搶槓"]).toBe("1飜");
      expect(robbery.yaku["嶺上開花"]).toBeUndefined();
    }
  );

  it.each([false, true])(
    "allows the declared replacement/robbery yaku to qualify an open hand, tsumo=%s",
    (tsumo) => {
      const score = scoreHand({
        hand: tiles("12678p12399s"),
        winTile: "3p",
        tsumo,
        playerCount: 3,
        melds: [
          { type: "pon", tiles: tiles("111m"), claimedTile: "1m", from: 2 },
        ],
        nukiTiles: tsumo ? ["4z"] : [],
        rinshanOrChankan: true,
        haiteiOrHoutei: true,
      });
      expect(score.han).toBe(tsumo ? 2 : 1);
      expect(score.yaku[tsumo ? "嶺上開花" : "搶槓"]).toBe("1飜");
      expectBalancedPayments(score, tsumo, false);
    }
  );

  it("retains Kansai ippatsu on a nuki replacement and does not add haitei", () => {
    const score = scoreHand({
      ...closedHand,
      tsumo: true,
      playerCount: 3,
      sanmaType: "kansai",
      nukiTiles: ["5m"],
      ippatsu: true,
      rinshanOrChankan: true,
      haiteiOrHoutei: true,
    });
    expect(score.han).toBe(6);
    expect(score.yaku).toMatchObject({
      一発: "1飜",
      嶺上開花: "1飜",
      抜きドラ: "1飜",
    });
    expect(score.yaku["海底摸月"]).toBeUndefined();
  });

  it("does not double-count ordinary kan rinshan in a hand with nuki", () => {
    const score = scoreHand({
      ...oneHan,
      melds: [{ ...hakuPon, type: "daiminkan", tiles: tiles("5555z") }],
      tsumo: true,
      playerCount: 3,
      nukiTiles: ["4z"],
      rinshanOrChankan: true,
    });
    expect(score.han).toBe(3);
    expect(score.yaku).toMatchObject({
      役牌白: "1飜",
      嶺上開花: "1飜",
      抜きドラ: "1飜",
    });
  });
});

describe("true yakuman and compatibility", () => {
  for (const sanmaType of ["online", "kansai"] as const) {
    for (const tsumo of [false, true]) {
      for (const seatWind of ["E", "S"] as const) {
        it(`${sanmaType} preserves single/double yakuman with tsumo=${tsumo}, wind=${seatWind}`, () => {
          for (const multiple of [1, 2]) {
            const score = scoreHand({
              hand: tiles(
                multiple === 2 ? "19m19p19s1234567z" : "19m19p19s1123567z"
              ),
              winTile: multiple === 2 ? "1z" : "4z",
              tsumo,
              seatWind,
              riichi: true,
              rinshanOrChankan: tsumo,
              playerCount: 3,
              sanmaType,
              nukiTiles: tiles(sanmaType === "online" ? "444z" : "0555m"),
              doraIndicators: ["1m", "3z"],
              uraDoraIndicators: ["1m", "3z"],
            });
            const expectedBase = !tsumo
              ? seatWind === "E"
                ? 48000
                : 32000
              : sanmaType === "online"
                ? seatWind === "E"
                  ? 32000
                  : 24000
                : seatWind === "E"
                  ? 48000
                  : 32000;
            expect(score).toMatchObject({
              han: 0,
              yakumanCount: multiple,
              isYakuman: true,
              ten: expectedBase * multiple,
            });
            for (const bonus of ["ドラ", "裏ドラ", "赤ドラ", "抜きドラ"]) {
              expect(score.yaku[bonus]).toBeUndefined();
            }
            expectBalancedPayments(score, tsumo, seatWind === "E");
          }
        });
      }
    }
  }

  it("does not activate sanma options in legacy or explicit four-player scoring", () => {
    const baseline = scoreHand(closedHand);
    for (const playerCount of [undefined, 4] as const) {
      const score = scoreHand({
        ...closedHand,
        playerCount,
        sanmaType: "kansai",
        nukiTiles: tiles("0555m"),
      });
      expect(score).toEqual(baseline);
    }
  });

  it.each(["online", "kansai"] as const)(
    "caps only the price and retains true yakuman in %s",
    (sanmaType) => {
      const tiers = [
        { cap: "mangan", base: 2000, kansai: kansaiRows[3] },
        { cap: "haneman", base: 3000, kansai: kansaiRows[5] },
        { cap: "baiman", base: 4000, kansai: kansaiRows[7] },
        { cap: "sanbaiman", base: 6000, kansai: kansaiRows[10] },
      ] as const;
      for (const { cap, base, kansai } of tiers) {
        for (const tsumo of [false, true]) {
          for (const seatWind of ["E", "S"] as const) {
            const score = scoreHand({
              hand: tiles("19m19p19s1234567z"),
              winTile: "1z",
              tsumo,
              seatWind,
              playerCount: 3,
              sanmaType,
              scoreCap: cap,
            });
            const dealerWinner = seatWind === "E";
            const ten =
              sanmaType === "online"
                ? base * (tsumo ? (dealerWinner ? 4 : 3) : dealerWinner ? 6 : 4)
                : tsumo
                  ? dealerWinner
                    ? kansai.dealerEach * 2
                    : kansai.dealer + kansai.other
                  : dealerWinner
                    ? kansai.dealerRon
                    : kansai.ron;
            expect(score).toMatchObject({
              han: 0,
              yakumanCount: 2,
              isYakuman: true,
              ten,
            });
            expectBalancedPayments(score, tsumo, dealerWinner);
          }
        }
      }
    }
  );
});

describe("active-seat payment distribution", () => {
  it.each(["online", "kansai"] as const)(
    "rotates payer roles over the three real seats in %s",
    (sanmaType) => {
      for (const dealer of [0, 1, 2] as const) {
        for (const winner of [0, 1, 2] as const) {
          const score = scoreHand({
            ...oneHan,
            playerCount: 3,
            sanmaType,
            tsumo: true,
            seatWind: winner === dealer ? "E" : "S",
            doraIndicators: ["7z"],
          });
          const delta = distributePayments({
            score,
            winner,
            dealer,
            loser: null,
            playerCount: 3,
          });
          const payerAmounts = winner === dealer ? score.oya : score.ko;
          expect(delta).toHaveLength(3);
          expect(delta[winner]).toBe(score.ten);
          expect(delta.reduce((sum, amount) => sum + amount, 0)).toBe(0);
          for (const seat of [0, 1, 2] as const) {
            if (seat !== winner) {
              expect(delta[seat]).toBe(
                -(winner === dealer || seat === dealer
                  ? payerAmounts[0]
                  : payerAmounts[1])
              );
            }
          }
        }
      }
    }
  );

  it.each(["winner", "dealer", "loser"] as const)(
    "rejects absent %s instead of extending the ledger",
    (field) => {
      expect(() =>
        distributePayments({
          score: scoreHand({ ...oneHan, playerCount: 3 }),
          winner: 1,
          dealer: 0,
          loser: 2,
          playerCount: 3,
          [field]: 3 as Seat,
        })
      ).toThrow(/seat|active/i);
    }
  );

  it("keeps the default four-seat ledger and supports a dynamic count", () => {
    const score = scoreHand({ ...oneHan, tsumo: true });
    expect(
      distributePayments({ score, winner: 1, dealer: 0, loser: null })
    ).toEqual([-500, 1100, -300, -300]);
    const counts: PlayerCount[] = [3, 4];
    for (const playerCount of counts) {
      const variantScore = scoreHand({ ...oneHan, tsumo: true, playerCount });
      const delta = distributePayments({
        score: variantScore,
        winner: 1,
        dealer: 0,
        loser: null,
        playerCount,
      });
      expect(delta).toHaveLength(playerCount);
      expect(delta[1]).toBe(variantScore.ten);
    }
  });
});
