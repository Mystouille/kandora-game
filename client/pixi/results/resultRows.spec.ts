import { describe, expect, it } from "vitest";
import type { HandResult } from "../scene/renderTypes";
import { buildNonWinResultRows, buildWinResultRows } from "./resultRows";
import { DEFAULT_RESULT_LABELS } from "./resultTypes";

describe("source-anchored result row plans", () => {
  const wins: NonNullable<HandResult["wins"]> = [
    {
      seat: 2,
      han: 2,
      fu: 30,
      ten: 2_000,
      yaku: { Riichi: "1飜", Pinfu: "1飜" },
      hand: ["3m", "1m", "2m", "4m"],
      winTile: "4m",
      melds: [
        { type: "pon", tiles: ["1p", "1p", "1p"], claimedTile: "1p", from: 3 },
      ],
      doraIndicators: ["9p"],
    },
  ];
  const result = { reason: "ron" as const, wins };

  it("reserves final row geometry from the first reveal frame", () => {
    const hidden = buildWinResultRows(result, 0, true, 0, null, true);
    const revealed = buildWinResultRows(result, 0, true, 3_500, null, true);
    expect(hidden.rows.map((row) => row.kind)).toEqual(
      revealed.rows.map((row) => row.kind)
    );
    expect(hidden.rows.filter((row) => row.kind === "yaku")).toMatchObject([
      { hidden: true },
      { hidden: true },
    ]);
    expect(hidden.rows.find((row) => row.kind === "scoreRow")).toMatchObject({
      han: "2 han 30 fu",
      pts: "2000pts",
      hidden: true,
    });
    expect(revealed.scoreDeltaRevealed).toBe(true);
    expect(revealed.scoreSummaryRevealed).toBe(true);
  });

  it("keeps winning hand sorting, the separate agari and seat-relative meld attribution", () => {
    const plan = buildWinResultRows(result, 0, false, Infinity, null, true);
    expect(plan.rows.find((row) => row.kind === "hand")).toEqual({
      kind: "hand",
      concealed: ["1m", "2m", "3m", "4m"],
      winTile: "4m",
      melds: [
        { type: "pon", tiles: ["1p", "1p", "1p"], claimedTile: "1p", from: 1 },
      ],
    });
    expect(wins[0].melds?.[0].from).toBe(3);
  });

  it("removes only the final agari copy from a complete concealed portion", () => {
    const complete = {
      ...result,
      wins: [{ ...wins[0], hand: ["3m", "1m", "2m", "4m", "4m"] }],
    };
    expect(
      buildWinResultRows(complete, 0, false, Infinity, null, true).rows.find(
        (row) => row.kind === "hand"
      )
    ).toMatchObject({ concealed: ["1m", "2m", "3m", "4m"], winTile: "4m" });
  });

  it("keeps five dora slots and uses shared indicators from any winner", () => {
    const multi = { ...result, wins: [{ seat: 0 as const }, ...wins] };
    const plan = buildWinResultRows(multi, 0, false, Infinity, null, true);
    expect(plan.rows[0]).toMatchObject({ kind: "label", text: "1 / 2" });
    expect(plan.rows.at(-1)).toEqual({
      kind: "tiles",
      tiles: ["9p", null, null, null, null],
    });
  });

  it("keeps reserved zero ura hidden after its indicators become visible", () => {
    const ura = {
      ...result,
      wins: [{ ...wins[0], uraDoraIndicators: ["2p"], uraDoraCount: 0 }],
    };
    const hidden = buildWinResultRows(ura, 0, true, 3_499, null, true);
    const revealed = buildWinResultRows(ura, 0, true, 3_500, null, true);
    expect(hidden.rows.at(-1)).toEqual({
      kind: "tiles",
      tiles: [null, null, null, null, null],
    });
    expect(revealed.rows.at(-1)).toEqual({
      kind: "tiles",
      tiles: ["2p", null, null, null, null],
    });
    expect(
      revealed.rows.find(
        (row) => row.kind === "yaku" && row.name === "Ura Dora"
      )
    ).toMatchObject({ hidden: true });
    expect(revealed.hasUraYaku).toBe(false);
    expect(revealed.uraIndicatorsRevealed).toBe(true);
  });

  it("keeps the dedicated ura beat out of the regular positive-yaku cadence", () => {
    const ura = {
      ...result,
      wins: [{ ...wins[0], uraDoraIndicators: ["2p"], uraDoraCount: 1 }],
    };
    expect(
      buildWinResultRows(ura, 0, true, 2_250, null, true).revealedYakuCount
    ).toBe(2);
    const revealed = buildWinResultRows(ura, 0, true, 3_500, null, true);
    expect(revealed.revealedYakuCount).toBe(3);
    expect(revealed.hasUraYaku).toBe(true);
    expect(revealed.uraIndicatorsRevealed).toBe(true);
  });

  it("omits ura entirely and uses the shorter summary beat for no-ura rules", () => {
    const ura = {
      ...result,
      wins: [{ ...wins[0], uraDoraIndicators: ["2p"], uraDoraCount: 1 }],
    };
    const plan = buildWinResultRows(ura, 0, true, 2_250, null, false);
    expect(plan.rows.filter((row) => row.kind === "tiles")).toHaveLength(1);
    expect(plan.scoreSummaryRevealed).toBe(true);
    expect(plan.hasUraYaku).toBe(false);
  });

  it("uses two equal yaku columns for lists of five or more entries", () => {
    const many = {
      ...result,
      wins: [
        {
          seat: 0 as const,
          yaku: {
            Riichi: "1飜",
            Pinfu: "1飜",
            Tanyao: "1飜",
            Ippatsu: "1飜",
            Dora: "1飜",
          },
        },
      ],
    };
    const plan = buildWinResultRows(many, 0, true, 0, null, true);
    const rows = plan.rows.filter((row) => row.kind === "yaku2");
    expect(rows).toHaveLength(3);
    expect(rows).toMatchObject([
      { leftHidden: true, rightHidden: true },
      { leftHidden: true, rightHidden: true },
      { leftHidden: true, right: null },
    ]);
  });

  it("uses the server points value and cap label rather than recalculating payouts", () => {
    const capped = {
      ...result,
      wins: [{ seat: 0 as const, han: 8, fu: 40, ten: 8_000 }],
    };
    const plan = buildWinResultRows(capped, 0, false, Infinity, "mangan", true);
    expect(plan.rows.find((row) => row.kind === "scoreRow")).toMatchObject({
      han: "Mangan",
      pts: "8000pts",
    });
    const yakuman = {
      ...result,
      wins: [{ seat: 0 as const, yakumanCount: 2 }],
    };
    expect(
      buildWinResultRows(yakuman, 0, false, Infinity, null, true).rows.find(
        (row) => row.kind === "scoreRow"
      )
    ).toMatchObject({ han: "2× Yakuman", pts: null });
  });

  it("localizes every abort kind and substitutes the unknown fallback", () => {
    for (const [kind, label] of [
      ["kyuushuu", "Nine Terminals"],
      ["suufon_renda", "Four Winds Discarded"],
      ["suucha_riichi", "Four Players Riichi"],
      ["sanchahou", "Triple Ron"],
    ] as const) {
      expect(
        buildNonWinResultRows(
          { reason: "abort", abortKind: kind },
          null,
          DEFAULT_RESULT_LABELS
        )
      ).toEqual([{ kind: "title", text: `Abort: ${label}`, size: 28 }]);
    }
    expect(
      buildNonWinResultRows({ reason: "abort" }, null, DEFAULT_RESULT_LABELS)
    ).toEqual([{ kind: "title", text: "Abort: Unknown", size: 28 }]);
    expect(
      buildNonWinResultRows({ reason: "exhaustive_draw" }, null, {
        ...DEFAULT_RESULT_LABELS,
        exhaustiveDraw: "Translated draw",
      })
    ).toEqual([{ kind: "title", text: "Translated draw", size: 32 }]);
  });

  it("prioritizes transient chombo metadata, names and signed chip totals over the win reason", () => {
    const chombo: HandResult = {
      reason: "ron",
      buuChombo: {
        seat: 0,
        reason: "sinking_win_not_floating",
        chips: [0, 4, 5, 6],
        chipDelta: [-3, 1, 1, 1],
      },
    };
    const plan = buildNonWinResultRows(
      chombo,
      ["Alpha", "", "Gamma", "Delta"],
      DEFAULT_RESULT_LABELS
    );
    expect(plan[0]).toMatchObject({
      text: "Chombo: sinking win without tenpai",
    });
    expect(plan[1]).toMatchObject({ text: "Alpha: 0 (-3)", color: 0xff6b6b });
    expect(plan[2]).toMatchObject({
      text: "Player 2: 4 (+1)",
      color: 0x86efac,
    });
  });
});
