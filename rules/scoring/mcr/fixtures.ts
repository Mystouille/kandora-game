import type { Tile } from "~/core/mahjong/rules/types";
import type {
  McrFanId,
  McrMeldInput,
  McrScoreInput,
  McrWinContext,
} from "./types";

const HONORS: Record<string, Tile> = {
  E: "1z",
  S: "2z",
  W: "3z",
  N: "4z",
  C: "5z",
  F: "6z",
  P: "7z",
};

function parseTiles(notation: string): Tile[] {
  const tiles: Tile[] = [];
  let ranks = "";
  for (const character of notation) {
    if (character >= "0" && character <= "9") {
      ranks += character;
    } else if (character === "m" || character === "p" || character === "s") {
      if (ranks.length === 0) {
        throw new Error(`Suit without ranks in ${notation}`);
      }
      for (const rank of ranks) {
        tiles.push(`${rank}${character}`);
      }
      ranks = "";
    } else if (HONORS[character]) {
      if (ranks.length > 0) {
        throw new Error(`Missing suit in ${notation}`);
      }
      tiles.push(HONORS[character]);
    } else if (!/\s/.test(character)) {
      throw new Error(`Invalid fixture character ${character}`);
    }
  }
  if (ranks.length > 0) {
    throw new Error(`Missing suit in ${notation}`);
  }
  return tiles;
}

function fixtureMeld(bodyWithOffer: string): McrMeldInput {
  const offerMatch = bodyWithOffer.match(/^(.*?)([1-7])?$/);
  if (!offerMatch) {
    throw new Error(`Invalid fixture meld ${bodyWithOffer}`);
  }
  const body = offerMatch[1];
  const offer = offerMatch[2] ? Number(offerMatch[2]) : 0;
  const tiles = parseTiles(body);
  const distinct = new Set(tiles);
  if (tiles.length === 4 && distinct.size === 1) {
    return {
      type: offer === 0 ? "ankan" : offer > 4 ? "shouminkan" : "daiminkan",
      tiles,
      claimedTile: offer === 0 ? null : tiles[0],
      from: offer === 0 ? null : ((offer & 3) as 1 | 2 | 3),
    };
  }
  if (tiles.length === 3 && distinct.size === 1) {
    return {
      type: "pon",
      tiles,
      claimedTile: tiles[0],
      from: (offer || 1) as 1 | 2 | 3,
    };
  }
  if (tiles.length === 3) {
    return {
      type: "chi",
      tiles,
      claimedTile: tiles[Math.max(0, (offer || 1) - 1)],
      from: 1,
    };
  }
  throw new Error(`Unsupported fixture meld ${bodyWithOffer}`);
}

export function mcrFixture(
  notation: string,
  context: Partial<McrWinContext> = {}
): McrScoreInput {
  const melds: McrMeldInput[] = [];
  const concealedNotation = notation.replace(/\[([^\]]+)\]/g, (_, body: string) => {
    melds.push(fixtureMeld(body));
    return "";
  });
  const tiles = parseTiles(concealedNotation);
  const winTile = tiles.pop();
  if (!winTile) {
    throw new Error(`Fixture has no winning tile: ${notation}`);
  }
  return {
    hand: tiles,
    winTile,
    melds,
    context: {
      method: "discard",
      prevalentWind: "E",
      seatWind: "E",
      ...context,
    },
  };
}

export interface ScoringFixture {
  name: string;
  input: McrScoreInput;
  totalFan?: number;
  nonFlowerFan?: number;
  fans?: Partial<Record<McrFanId, number>>;
  absent?: readonly McrFanId[];
}

export const CORRECTION_FIXTURES: readonly ScoringFixture[] = [
  {
    name: "mixed concealed and melded kong uses the six-point clause",
    input: mcrFixture("[1111m][2222s1]345pEE67s8s", {
      method: "self-draw",
    }),
    totalFan: 8,
    fans: { TWO_MELDED_KONGS: 1 },
    absent: ["CONCEALED_KONG", "MELDED_KONG"],
  },
  {
    name: "two concealed kongs use the Green Book eight-point value",
    input: mcrFixture("[1111m][2222s]345pEE67s8s", {
      method: "self-draw",
      flowerCount: 3,
    }),
    totalFan: 16,
    nonFlowerFan: 13,
    fans: { TWO_CONCEALED_KONGS: 1, FLOWER_TILES: 3 },
    absent: ["TWO_CONCEALED_PUNGS", "CONCEALED_KONG"],
  },
  {
    name: "three kongs with one concealed kong",
    input: mcrFixture("[2222s][3333s1][5555p1]67mEE8m"),
    totalFan: 34,
    fans: { THREE_KONGS: 1, CONCEALED_KONG: 1 },
  },
  {
    name: "three kongs with two concealed kongs",
    input: mcrFixture("[2222s][3333s][5555p1]67mEE8m"),
    totalFan: 40,
    fans: { THREE_KONGS: 1, TWO_CONCEALED_KONGS: 1 },
    absent: ["TWO_CONCEALED_PUNGS"],
  },
  {
    name: "three kongs with three concealed kongs",
    input: mcrFixture("[2222s][3333s][5555p]67mEE8m"),
    totalFan: 50,
    fans: { THREE_KONGS: 1, THREE_CONCEALED_PUNGS: 1 },
    absent: ["TWO_CONCEALED_KONGS", "CONCEALED_KONG"],
  },
  {
    name: "best corrected decomposition beats the raw upstream tie",
    input: mcrFixture("44556m445566s55p6m", { method: "self-draw" }),
    totalFan: 52,
    fans: {
      SEVEN_PAIRS: 1,
      MIDDLE_TILES: 1,
      FULLY_CONCEALED_HAND: 1,
    },
    absent: ["ALL_FIVE"],
  },
];

export const FOUR_KONG_FIXTURES: readonly ScoringFixture[] = [
  {
    name: "four exposed kongs",
    input: mcrFixture("[2222m1][8888m1][4444s1][7777p1]EE"),
    totalFan: 94,
  },
  {
    name: "four kongs, one concealed",
    input: mcrFixture("[2222m][8888m1][4444s1][7777p1]EE"),
    totalFan: 90,
    fans: { CONCEALED_KONG: 1 },
  },
  {
    name: "four kongs, two concealed",
    input: mcrFixture("[2222m][8888m][4444s1][7777p1]EE"),
    totalFan: 96,
    fans: { TWO_CONCEALED_KONGS: 1 },
    absent: ["TWO_CONCEALED_PUNGS"],
  },
  {
    name: "four kongs, three concealed",
    input: mcrFixture("[2222m][8888m][4444s][7777p1]EE"),
    totalFan: 104,
    fans: { THREE_CONCEALED_PUNGS: 1 },
  },
  {
    name: "four concealed kongs",
    input: mcrFixture("[2222m][8888m][4444s][7777p]EE", {
      method: "self-draw",
    }),
    totalFan: 156,
    fans: { FOUR_CONCEALED_PUNGS: 1, FULLY_CONCEALED_HAND: 1 },
    absent: ["SELF_DRAWN"],
  },
];

export const KNITTED_FIXTURES: readonly ScoringFixture[] = [
  {
    name: "knitted straight with edge wait",
    input: mcrFixture("1233369m147s258p3m"),
    totalFan: 19,
    fans: { KNITTED_STRAIGHT: 1, EDGE_WAIT: 1 },
    absent: ["CLOSED_WAIT", "SINGLE_WAIT"],
  },
  {
    name: "knitted straight with closed wait",
    input: mcrFixture("2333469m147s258p3m"),
    totalFan: 19,
    fans: { KNITTED_STRAIGHT: 1, CLOSED_WAIT: 1 },
    absent: ["EDGE_WAIT", "SINGLE_WAIT"],
  },
  {
    name: "knitted straight with single wait",
    input: mcrFixture("3369m147s258pEEE3m"),
    totalFan: 19,
    fans: { KNITTED_STRAIGHT: 1, SINGLE_WAIT: 1 },
    absent: ["EDGE_WAIT", "CLOSED_WAIT"],
  },
  {
    name: "knitted-body-only completion has no residual wait fan",
    input: mcrFixture("45669m147s258pEE3m"),
    fans: { KNITTED_STRAIGHT: 1 },
    absent: ["EDGE_WAIT", "CLOSED_WAIT", "SINGLE_WAIT"],
  },
  {
    name: "ambiguous knitted residual wait has no wait fan",
    input: mcrFixture("1234447m258s369p4m"),
    fans: { KNITTED_STRAIGHT: 1 },
    absent: ["EDGE_WAIT", "CLOSED_WAIT", "SINGLE_WAIT"],
  },
];

export const STANDARD_FIXTURES: readonly ScoringFixture[] = [
  {
    name: "self-drawn Thirteen Orphans adds Fully Concealed Hand",
    input: mcrFixture("19m19s19pESWNCFPN", { method: "self-draw" }),
    totalFan: 92,
    fans: { THIRTEEN_ORPHANS: 1, FULLY_CONCEALED_HAND: 1 },
    absent: ["SELF_DRAWN"],
  },
  {
    name: "self-drawn Seven Shifted Pairs adds Fully Concealed Hand",
    input: mcrFixture("11223344556677m", { method: "self-draw" }),
    totalFan: 92,
    fans: { SEVEN_SHIFTED_PAIRS: 1, FULLY_CONCEALED_HAND: 1 },
    absent: ["SELF_DRAWN"],
  },
  {
    name: "self-drawn Seven Pairs adds Fully Concealed Hand",
    input: mcrFixture("1133557799m22s44p", { method: "self-draw" }),
    totalFan: 29,
    fans: { SEVEN_PAIRS: 1, FULLY_CONCEALED_HAND: 1 },
    absent: ["SELF_DRAWN"],
  },
  {
    name: "self-drawn Nine Gates adds Fully Concealed Hand",
    input: mcrFixture("1112345678999p9p", { method: "self-draw" }),
    totalFan: 110,
    fans: { NINE_GATES: 1, FULLY_CONCEALED_HAND: 1 },
    absent: ["SELF_DRAWN"],
  },
  {
    name: "self-drawn all-honor Seven Pairs adds Fully Concealed Hand",
    input: mcrFixture("EESSWWNNCCFFPP", { method: "self-draw" }),
    totalFan: 92,
    fans: {
      ALL_HONORS: 1,
      SEVEN_PAIRS: 1,
      FULLY_CONCEALED_HAND: 1,
    },
    absent: ["SELF_DRAWN"],
  },
  {
    name: "self-drawn Greater Honors and Knitted Tiles is fully concealed",
    input: mcrFixture("69m258s1pESWNCFP3m", { method: "self-draw" }),
    totalFan: 28,
    fans: {
      GREATER_HONORS_AND_KNITTED_TILES: 1,
      FULLY_CONCEALED_HAND: 1,
    },
    absent: ["SELF_DRAWN"],
  },
  {
    name: "self-drawn Lesser Honors and Knitted Tiles is fully concealed",
    input: mcrFixture("69m258s17pEWNCFP3m", { method: "self-draw" }),
    totalFan: 16,
    fans: {
      LESSER_HONORS_AND_KNITTED_TILES: 1,
      FULLY_CONCEALED_HAND: 1,
    },
    absent: ["SELF_DRAWN"],
  },
  {
    name: "All Terminals may add two Double Pungs",
    input: mcrFixture("[111m][111s][999m]99s1p1p9s"),
    totalFan: 68,
    fans: { ALL_TERMINALS: 1, DOUBLE_PUNG: 2 },
  },
  {
    name: "Triple Pung absorbs its Double Pungs",
    input: mcrFixture("[111m][111p][111s]99s99p9p"),
    fans: { ALL_TERMINALS: 1, TRIPLE_PUNG: 1 },
    absent: ["DOUBLE_PUNG"],
  },
  {
    name: "All Green with green dragons retains Half Flush",
    input: mcrFixture("223344668888sFF", { method: "self-draw" }),
    totalFan: 124,
    fans: {
      ALL_GREEN: 1,
      SEVEN_PAIRS: 1,
      HALF_FLUSH: 1,
      TILE_HOG: 1,
      FULLY_CONCEALED_HAND: 1,
    },
  },
  {
    name: "pure-suit All Green keeps Full Flush, not Half Flush",
    input: mcrFixture("22334466888866s", { method: "self-draw" }),
    fans: { ALL_GREEN: 1, FULL_FLUSH: 1 },
    absent: ["HALF_FLUSH"],
  },
  {
    name: "All Green without green dragons does not invent Half Flush",
    input: mcrFixture("[234s][234s][234s][234s]6s6s"),
    fans: { ALL_GREEN: 1 },
    absent: ["HALF_FLUSH"],
  },
];

export const CONCEALED_KONG_SERIES_FIXTURES: readonly ScoringFixture[] = [
  {
    name: "three kongs combine one concealed kong and a concealed pung",
    input: mcrFixture("[2222m][5555s1][8888p1]44mEE4m", {
      method: "self-draw",
    }),
    totalFan: 43,
    fans: {
      THREE_KONGS: 1,
      CONCEALED_KONG: 1,
      TWO_CONCEALED_PUNGS: 1,
    },
    absent: ["TWO_CONCEALED_KONGS"],
  },
  {
    name: "three kongs combine two concealed kongs and three concealed pungs",
    input: mcrFixture("[2222m][5555s][8888p1]44mEE4m", {
      method: "self-draw",
    }),
    totalFan: 63,
    fans: {
      THREE_KONGS: 1,
      TWO_CONCEALED_KONGS: 1,
      THREE_CONCEALED_PUNGS: 1,
    },
    absent: ["TWO_CONCEALED_PUNGS"],
  },
  {
    name: "three concealed kongs plus concealed pung make four concealed pungs",
    input: mcrFixture("[2222m][5555s][8888p]44mEE4m", {
      method: "self-draw",
    }),
    totalFan: 100,
    fans: {
      THREE_KONGS: 1,
      FOUR_CONCEALED_PUNGS: 1,
      FULLY_CONCEALED_HAND: 1,
    },
    absent: ["CONCEALED_KONG", "SELF_DRAWN"],
  },
];
