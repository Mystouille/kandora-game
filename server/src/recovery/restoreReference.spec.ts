import { afterEach, describe, expect, it, vi } from "vitest";
import type { TimingMode } from "~/game/protocol/timing";
import { editMatchState } from "~/game/testing/matchState";
import { getPreset, presetToRuleSet } from "~/game/rules/presets";
import { MatchProcess, setReadyCheckMs } from "../match";
import { ephemeralMatchRepository } from "../repository";
import type { MatchRuntime } from "../runtime";
import { DecisionTiming } from "../timing/decisionTiming";
import { PromptWindows } from "../timing/promptWindows";
import { CheckpointInstaller } from "./checkpointInstaller";

async function checkpoint(timingMode: TimingMode = "legacy", buuMode = false) {
  let now = 1_000;
  const runtime: MatchRuntime = {
    clockEpoch: "restore-reference-source",
    now: () => now,
    random: () => 0.5,
    captureRandomState: () => 0,
    restoreRandomState: () => undefined,
    schedule: () => ({ cancel: () => undefined }),
    sleep: async (ms) => {
      now += ms;
    },
  };
  const match = new MatchProcess(
    "restore-reference",
    42,
    [0, 1, 2, 3].map((seat) => ({
      userId: `player-${seat}`,
      displayName: `Player ${seat}`,
      isBot: false,
    })),
    { repository: ephemeralMatchRepository, runtime, timingMode },
    undefined,
    buuMode ? presetToRuleSet(getPreset("buu-east")) : undefined,
    buuMode ? "buu-east" : "tenhou-hanchan"
  );
  setReadyCheckMs(0);
  await match.start();
  const saved = match.createCheckpoint();
  if (saved.status !== "playing" || saved.checkpointKind !== "action_window") {
    throw new Error("Expected an action checkpoint");
  }
  return { match, saved, runtime };
}

describe("owned recovery restore reference", () => {
  afterEach(() => {
    setReadyCheckMs(5_000);
    vi.restoreAllMocks();
  });

  it("uses the event/start reference for legacy window deadlines even when clock reads advance", async () => {
    const { saved, runtime } = await checkpoint();
    const reference = 50_000;
    let next = reference;
    const restored = MatchProcess.restoreCheckpoint(saved, {
      repository: ephemeralMatchRepository,
      runtime: {
        ...runtime,
        clockEpoch: "restore-reference-target",
        now: () => next++,
      },
    });
    expect(restored.sessionSnapshot().startedReferenceAt).toBe(
      reference - saved.startedAgoMs
    );
    expect(
      restored.owners.publisher.history().map((entry) => entry.emittedAt)
    ).toEqual(saved.eventLog.map((entry) => reference - entry.emittedAgoMs));
    expect(
      restored.owners.actionWindows.view(saved.actionWindow.seat).deadline
    ).toBe(reference + saved.actionWindow.visibleRemainingMs);
  });

  it("forwards the same captured reference to continuation and decision restore owners", async () => {
    const { saved, runtime } = await checkpoint("windows-v2");
    const install = vi.spyOn(CheckpointInstaller.prototype, "install");
    const timing = vi.spyOn(DecisionTiming.prototype, "restore");
    const reference = 75_000;
    let next = reference;
    const restored = MatchProcess.restoreCheckpoint(saved, {
      repository: ephemeralMatchRepository,
      runtime: {
        ...runtime,
        clockEpoch: "restore-reference-target",
        now: () => next++,
      },
    });
    expect(install).toHaveBeenCalledWith(
      expect.objectContaining({ matchId: saved.matchId }),
      true,
      reference
    );
    expect(timing).toHaveBeenCalledWith(
      saved.decisionTiming,
      saved.savedAt,
      reference
    );
    expect(restored.sessionSnapshot().startedReferenceAt).toBe(
      reference - saved.startedAgoMs
    );
    const window = saved.decisionTiming?.windows[saved.actionWindow.seat];
    if (!window) {
      throw new Error("Expected a timed decision");
    }
    expect(
      restored.owners.actionWindows.timedView(saved.actionWindow.seat)
    ).toMatchObject({
      id: window.id,
      opensAt: reference + window.opensAt - saved.savedAt,
      baseEndsAt: reference + window.baseEndsAt - saved.savedAt,
      expiresAt: reference + window.expiresAt - saved.savedAt,
      allowanceMs: window.allowanceMs,
      generation: window.generation,
    });
  });

  it.each(["ready", "session_vote"] as const)(
    "restores %s prompts once using the event/start reference",
    async (kind) => {
      const { match, runtime } = await checkpoint(
        "windows-v2",
        kind === "session_vote"
      );
      match.owners.actionWindows.resetForRestore();
      editMatchState(match, (state) => {
        state.phase = kind === "ready" ? "hand_ended" : "match_ended";
      });
      const waiting =
        kind === "ready"
          ? match.owners.lifecycle.ready.runReadyCheck(5_000, "next_hand")
          : match.owners.lifecycle.votes.runContinueVote(
              [0, 1, 2, 3].map((seat) => ({
                seat: seat as 0 | 1 | 2 | 3,
                score: 25_000,
                place: (seat + 1) as 1 | 2 | 3 | 4,
              }))
            );
      await Promise.resolve();
      if (kind === "ready") {
        await match.handleReady(0, match.promptReceipt(0, runtime.now()));
      } else {
        await match.handleVoteContinue(
          0,
          "yes",
          match.promptReceipt(0, runtime.now())
        );
      }
      const saved = match.createCheckpoint();
      if (
        saved.status !== "playing" ||
        (saved.checkpointKind !== "ready_check" &&
          saved.checkpointKind !== "continue_vote")
      ) {
        throw new Error("Expected a fixed-prompt checkpoint");
      }
      const prompts = saved.decisionTiming?.prompts;
      if (!prompts) {
        throw new Error("Expected captured prompt identities");
      }
      const restore = vi.spyOn(PromptWindows.prototype, "restore");
      const reference = 75_000;
      let next = reference;
      const deadlines: { at: number; cancelled: boolean }[] = [];
      const restored = MatchProcess.restoreCheckpoint(saved, {
        repository: ephemeralMatchRepository,
        runtime: {
          ...runtime,
          clockEpoch: "fixed-restore-reference-target",
          now: () => next,
          schedule: (_callback, delayMs) => {
            const timer = { at: next + delayMs, cancelled: false };
            deadlines.push(timer);
            next += 37;
            return {
              cancel: () => {
                timer.cancelled = true;
              },
            };
          },
        },
      });
      expect(restore).toHaveBeenCalledExactlyOnceWith(
        prompts,
        saved.savedAt,
        reference
      );
      for (const seat of [0, 1, 2, 3] as const) {
        const before = prompts.windows[seat];
        if (!before) {
          throw new Error("Expected a human prompt");
        }
        expect(restored.owners.timing.promptTiming?.view(seat)).toMatchObject({
          id: before.id,
          clockEpoch: "fixed-restore-reference-target",
          state: before.state,
          generation: before.generation,
          baseEndsAt: reference + before.baseEndsAt - saved.savedAt,
          expiresAt: reference + before.expiresAt - saved.savedAt,
          allowanceMs: before.allowanceMs,
        });
      }
      const deadline = restored.owners.timing.promptTiming?.deadline(kind);
      expect(
        deadlines.filter((timer) => !timer.cancelled).map(({ at }) => at)
      ).toContain(deadline);
      if (kind === "ready") {
        expect(restored.owners.lifecycle.ready.snapshot().acked[0]).toBe(true);
        match.owners.lifecycle.ready.finishReadyCheck();
      } else {
        expect(restored.owners.lifecycle.votes.snapshot().votes[0]).toBe("yes");
        match.owners.lifecycle.votes.finishContinueVote(false);
      }
      await waiting;
    }
  );

  it("allows a pause rollback caller to supply its captured reference", async () => {
    const { match } = await checkpoint();
    const saved = await match.pauseAndSaveCheckpoint();
    if (
      saved.status !== "playing" ||
      saved.checkpointKind !== "action_window"
    ) {
      throw new Error("Expected a paused action checkpoint");
    }
    match.owners.recovery.resumeCheckpoint(saved, false, 100_000);
    expect(match.isPaused).toBe(false);
    expect(
      match.owners.actionWindows.view(saved.actionWindow.seat).deadline
    ).toBe(100_000 + saved.actionWindow.visibleRemainingMs);
  });
});
