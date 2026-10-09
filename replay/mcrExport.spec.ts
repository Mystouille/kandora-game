import { describe, expect, it } from "vitest";
import type { ReplayLog } from "./types";
import {
  UnsupportedMcrExportError,
  replayLogToTenhou5Json,
} from "./replayLogToTenhou5Json";

describe("MCR external replay guards", () => {
  it("rejects the Riichi-only Tenhou/NAGA format", () => {
    const replay: ReplayLog = {
      rulesFamily: "mcr",
      source: "ingame",
      sourceGameId: "mcr-game",
      ruleSet: "mcr-ema",
      startedAt: 1,
      endedAt: 2,
      seats: [0, 1, 2, 3].map((seat) => ({
        seat: seat as 0 | 1 | 2 | 3,
        displayName: `Player ${seat + 1}`,
        finalScore: 0,
        place: (seat + 1) as 1 | 2 | 3 | 4,
      })),
      events: [],
      schemaVersion: 11,
    };

    expect(() => replayLogToTenhou5Json(replay)).toThrow(
      UnsupportedMcrExportError
    );
  });
});
