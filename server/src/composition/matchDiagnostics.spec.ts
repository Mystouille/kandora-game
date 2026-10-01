import { describe, expect, it } from "vitest";
import type { LegalAction } from "~/game/protocol/messages";
import { MatchProcess, type MatchProcessDependencies } from "../match";
import { ephemeralMatchRepository } from "../repository";
import type { MatchRuntime } from "../runtime";
import type { TimingDiagnostic } from "../timing/timingDiagnostics";

const actions: LegalAction[] = [
  { id: "discard:1m", type: "discard", tile: "1m" },
];

function diagnosticMatch(
  options: Pick<MatchProcessDependencies, "onTimingDiagnostic"> = {}
): MatchProcess {
  const runtime: MatchRuntime = {
    clockEpoch: "diagnostic-epoch",
    now: () => 1_000,
    random: () => 0.5,
    captureRandomState: () => 0,
    restoreRandomState: () => undefined,
    schedule: () => ({ cancel: () => undefined }),
    sleep: async () => undefined,
  };
  return new MatchProcess(
    "diagnostic-match",
    42,
    [0, 1, 2, 3].map((seat) => ({
      userId: `player-${seat}`,
      displayName: `Player ${seat}`,
      isBot: false,
    })),
    { repository: ephemeralMatchRepository, runtime, ...options }
  );
}

function openDiscard(match: MatchProcess): void {
  match.owners.timing.record(
    { type: "draw", seat: 0, tile: "1m", wallRemaining: 69 },
    0
  );
  match.owners.gameplay.effects.setSeatLegals(0, actions);
}

describe("MatchProcess diagnostic composition", () => {
  it("delivers readonly sanitized diagnostics with a bounded owner history", () => {
    const observed: Readonly<TimingDiagnostic>[] = [];
    const match = diagnosticMatch({
      onTimingDiagnostic: (event) => {
        observed.push(event);
      },
    });
    openDiscard(match);
    expect(observed[0]).toMatchObject({
      outcome: "opened",
      matchId: "diagnostic-match",
      clockEpoch: "diagnostic-epoch",
      opensAt: 1_300,
    });
    expect(Object.isFrozen(observed[0])).toBe(true);
    expect(observed[0]).not.toHaveProperty("legalActionIds");
    expect(JSON.stringify(observed)).not.toContain("1m");
    for (let index = 0; index < 80; index++) {
      match.owners.timing.diagnostics.record("cancelled", 1_000 + index);
    }
    const recent = match.owners.timing.diagnostics.recent();
    expect(recent).toHaveLength(64);
    expect(recent.at(-1)?.at).toBe(1_079);
    expect(recent.every((event) => Object.isFrozen(event))).toBe(true);
  });
});
