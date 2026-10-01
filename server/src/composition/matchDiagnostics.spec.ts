import { describe, expect, it } from "vitest";
import type { LegalAction, ServerMessage } from "~/game/protocol/messages";
import { MatchProcess, type MatchProcessDependencies } from "../match";
import { ephemeralMatchRepository } from "../repository";
import type { MatchRuntime } from "../runtime";
import type { TimingDiagnostic } from "../timing/timingDiagnostics";

const actions: LegalAction[] = [
  { id: "discard:1m", type: "discard", tile: "1m" },
];

function diagnosticMatch(
  options: Pick<
    MatchProcessDependencies,
    "timingMode" | "timingShadow" | "onTimingDiagnostic"
  > = {}
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
  it("keeps default matches entirely legacy with shadow disabled", () => {
    const match = diagnosticMatch();
    openDiscard(match);
    expect(match.timingMode).toBe("legacy");
    expect(match.owners.timing.diagnostics.shadow).toBe(false);
    expect(match.owners.timing.metadata(0, 0)).toEqual({});
    expect(match.owners.timing.diagnostics.recent()).toEqual([]);
    expect(match.owners.actionWindows.timedView(0)).toBeNull();
    expect(match.owners.actionWindows.view(0).deadline).toBe(6_000);
    expect(match.owners.timeBank.balance(0)).toBe(20_000);
  });

  it("passes shadow comparisons to the observer without changing legacy windows or wire poses", () => {
    const observed: Readonly<TimingDiagnostic>[] = [];
    const frames: ServerMessage[] = [];
    const match = diagnosticMatch({
      timingShadow: true,
      onTimingDiagnostic: (event) => {
        observed.push(event);
      },
    });
    match.attachHuman(0, (frame) => {
      frames.push(frame);
    });
    openDiscard(match);
    expect(observed[0]).toMatchObject({
      outcome: "shadow",
      matchId: "diagnostic-match",
      clockEpoch: "diagnostic-epoch",
      opensAt: 1_300,
      legacyOpensAt: 1_000,
      baseEndsAt: 6_300,
    });
    expect(match.owners.actionWindows.timedView(0)).toBeNull();
    expect(match.owners.actionWindows.view(0).deadline).toBe(6_000);
    expect(match.owners.timing.metadata(0, 0)).toEqual({
      clock: { clockEpoch: "diagnostic-epoch", serverNow: 1_000 },
    });
    match.owners.broadcast.flushLegalsToSeat(0);
    const frame = frames.at(-1);
    expect(frame).toMatchObject({
      type: "event",
      clock: { clockEpoch: "diagnostic-epoch", serverNow: 1_000 },
      events: [],
      legalActions: actions,
      deadline: 6_000,
      bufferMs: 20_000,
    });
    expect(frame).not.toHaveProperty("actionWindow");
    expect(frame).not.toHaveProperty("promptWindow");
    expect(frame).not.toHaveProperty("presentation");
    match.reserveAction(0, actions[0].id, { receivedAt: 1_100 });
    expect(observed.at(-1)).toMatchObject({
      outcome: "shadow",
      receivedAt: 1_100,
    });
    expect(match.owners.actionWindows.hasReservedInput(0)).toBe(false);
    expect(match.owners.timeBank.balance(0)).toBe(20_000);
    expect(JSON.stringify(observed)).not.toContain("1m");
  });

  it("delivers readonly sanitized new-mode diagnostics with a bounded owner history", () => {
    const observed: Readonly<TimingDiagnostic>[] = [];
    const match = diagnosticMatch({
      timingMode: "windows-v2",
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
