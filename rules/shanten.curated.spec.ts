/**
 * Hand-curated shanten regression cases. Each row is `(hand, expected)`
 * with the hand in tenhou-style suit-grouped notation.
 *
 * These exercise tricky corner cases (chiitoitsu vs standard, deep
 * 1-shanten in chinitsu, kokushi-friendly hands, etc.) that random
 * fuzzing rarely produces.
 */
import { describe, expect, it } from "vitest";
import { shanten } from "./shanten";

function tiles(s: string): string[] {
  const out: string[] = [];
  let buf = "";
  for (const ch of s) {
    if (ch === "m" || ch === "p" || ch === "s" || ch === "z") {
      for (const n of buf) {
        out.push(`${n}${ch}`);
      }
      buf = "";
    } else {
      buf += ch;
    }
  }
  return out;
}

const CASES: Array<[string, number]> = [
  ["456p111m246s1122z", 1],
  ["456p111m246s1233z", 2],
  ["457p111m246s1233z", 3],
  ["3678m22s33456899p", 1],
  ["367m22s334568899p", 2],
  ["67m22s3345668899p", 1],
  ["3677m28s33568899p", 2],
  ["589m1158s2799p12z", 4],
  ["688m2466s1222348p", 2],
  ["333m222346s678p11z", 0],
  ["3445m2478p123s123z", 2],
  ["4678m2367p114799s", 2],
  ["89m128p369s233456z", 4],
  ["89m128p3369s23345z", 4],
  ["89m128p3669s23345z", 4],
  ["889m128p369s23346z", 4],
  ["147m28p13468s1235z", 6],
  ["233444556m", 2],
  ["35678m289p17s1123z", 3],
  ["77m688s33568899p", 1],
  ["22m4466p12377s135z", 2],
  ["225588m336699p22z", -1],
  ["19m139p15s123456z", 2],
  ["1112345678999s", 0],
  ["11112345678999s", -1],
  ["11122345678999s", -1],
  ["11123345678999s", -1],
  ["11123445678999s", -1],
  ["11123455678999s", -1],
  ["11123456678999s", -1],
  ["11123456778999s", -1],
  ["11123456788999s", -1],
  ["11123456789999s", -1],
  ["3467m2478p123s123z", 3],
  ["1145m125799p123s1z", 2],
];

describe("shanten — curated hands", () => {
  for (const [hand, expected] of CASES) {
    it(`${hand} → ${expected}`, () => {
      expect(shanten(tiles(hand))).toBe(expected);
    });
  }
});
