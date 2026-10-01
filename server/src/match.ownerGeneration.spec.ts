import { afterEach, describe, expect, it, vi } from "vitest";
import type { InputReceipt } from "~/game/protocol/timing";
import { MatchProcess, setReadyCheckMs } from "./match";
import { ephemeralMatchRepository } from "./repository";
import type { MatchRuntime } from "./runtime";
import { DecisionWindowError } from "./timing/actionWindows";

function fixture() {
  const clock = { now: 1_000 };
  const runtime: MatchRuntime = {
    clockEpoch: "owner-generation",
    now: () => clock.now,
    random: () => 0.5,
    captureRandomState: () => 0,
    restoreRandomState: () => undefined,
    schedule: () => ({ cancel: () => undefined }),
    sleep: async (ms) => {
      clock.now += ms;
    },
  };
  const match = new MatchProcess(
    "owner-generation",
    42,
    [0, 1, 2, 3].map((seat) => ({
      userId: `player-${seat}`,
      displayName: `Player ${seat}`,
      isBot: seat !== 0,
    })),
    {
      repository: ephemeralMatchRepository,
      runtime,
      timingMode: "windows-v2",
    }
  );
  match.configurePlayerTiming(0, "direct", () => null);
  match.attachHuman(0, () => undefined, undefined, {
    clientSessionId: "first",
  });
  return { match, clock, runtime };
}

function vote(match: MatchProcess): Promise<boolean> {
  return match.owners.lifecycle.votes.runContinueVote([
    { seat: 0, score: 25_000, place: 1 },
    { seat: 1, score: 25_000, place: 2 },
    { seat: 2, score: 25_000, place: 3 },
    { seat: 3, score: 25_000, place: 4 },
  ]);
}

describe("MatchProcess internal receipt owner generation", () => {
  afterEach(() => setReadyCheckMs(5_000));

  it.each(["act", "ready", "yes", "no"] as const)(
    "stamps and preserves the first-reserve generation for %s",
    async (reply) => {
      const { match, clock } = fixture();
      let waiting: Promise<void | boolean> | undefined;
      let actionId = "";
      if (reply === "act") {
        setReadyCheckMs(0);
        await match.start();
        const window = match.owners.actionWindows.timedView(0);
        if (!window) {
          throw new Error("Expected an action window");
        }
        clock.now = window.opensAt;
        const action = match
          .buildSnapshotForSeat(0)
          .legalActions?.find((candidate) => candidate.type === "discard");
        if (!action) {
          throw new Error("Expected a discard");
        }
        actionId = action.id;
      } else {
        waiting =
          reply === "ready"
            ? match.owners.lifecycle.ready.runReadyCheck(5_000)
            : vote(match);
      }
      const receipt: InputReceipt =
        reply === "act"
          ? match.actionReceipt(0, clock.now)
          : match.promptReceipt(0, clock.now);
      expect(receipt.ownerGeneration).toBeUndefined();
      try {
        if (reply === "act") {
          match.reserveAction(0, actionId, receipt);
          match.reserveAction(0, actionId, receipt);
        } else {
          match.reservePrompt(0, reply, receipt);
          match.reservePrompt(0, reply, receipt);
        }
        expect(receipt.ownerGeneration).toBe(
          match.owners.connections.view(0).generation
        );
        match.attachHuman(0, () => undefined, undefined, {
          clientSessionId: "replacement",
          takeover: true,
        });
        if (reply === "act") {
          expect(() => match.reserveAction(0, actionId, receipt)).toThrow(
            DecisionWindowError
          );
          expect(match.owners.actionWindows.hasReservedInput(0)).toBe(false);
        } else {
          expect(() => match.reservePrompt(0, reply, receipt)).toThrow(
            DecisionWindowError
          );
          expect(
            match.owners.timing.promptTiming?.hasReserved(
              reply === "ready" ? "ready" : "session_vote"
            )
          ).toBe(false);
        }
        expect(receipt.ownerGeneration).not.toBe(
          match.owners.connections.view(0).generation
        );
      } finally {
        match.owners.actionWindows.releaseReservation(0, receipt);
        match.owners.lifecycle.ready.releaseReceipt(0, receipt);
        match.owners.lifecycle.votes.releaseReceipt(0, receipt);
        match.owners.lifecycle.ready.finishReadyCheck();
        match.owners.lifecycle.votes.finishContinueVote(false);
        await waiting;
      }
    }
  );

  it.each([
    ["act", "queued"],
    ["ready", "queued"],
    ["yes", "queued"],
    ["no", "queued"],
    ["act", "before-execute"],
    ["ready", "before-execute"],
    ["yes", "before-execute"],
    ["no", "before-execute"],
  ] as const)(
    "rejects a prior-owner %s after takeover at %s without poisoning recovery",
    async (reply, phase) => {
      const { match, clock, runtime } = fixture();
      let waiting: Promise<void | boolean> | undefined;
      let actionId = "";
      if (reply === "act") {
        setReadyCheckMs(0);
        await match.start();
        const window = match.owners.actionWindows.timedView(0);
        if (!window) {
          throw new Error("Expected an action window");
        }
        clock.now = window.opensAt;
        const action = match
          .buildSnapshotForSeat(0)
          .legalActions?.find((candidate) => candidate.type === "discard");
        if (!action) {
          throw new Error("Expected a discard");
        }
        actionId = action.id;
      } else {
        waiting =
          reply === "ready"
            ? match.owners.lifecycle.ready.runReadyCheck(5_000)
            : vote(match);
      }
      const receipt =
        reply === "act"
          ? match.actionReceipt(0, clock.now)
          : match.promptReceipt(0, clock.now);
      const execute =
        reply === "act"
          ? vi.spyOn(match.owners.gameplay.actions, "handleActDirect")
          : reply === "ready"
            ? vi.spyOn(match.owners.lifecycle.ready, "handleReadyDirect")
            : vi.spyOn(
                match.owners.lifecycle.votes,
                "handleVoteContinueDirect"
              );
      const schedule = vi.spyOn(runtime, "schedule");
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const automatic =
        phase === "queued"
          ? match.owners.commands.runAutomaticDefault(async () => {
              await gate;
            })
          : Promise.resolve();
      const submitted =
        reply === "act"
          ? match.handleAct(0, actionId, receipt)
          : reply === "ready"
            ? match.handleReady(0, receipt)
            : match.handleVoteContinue(0, reply, receipt);
      const rejected = expect(submitted).rejects.toThrow(DecisionWindowError);
      try {
        match.attachHuman(0, () => undefined, undefined, {
          clientSessionId: "replacement",
          takeover: true,
        });
        release();
        await automatic;
        await rejected;
        expect(execute).not.toHaveBeenCalled();
        expect(match.pendingCommandRecoveryError).toBeNull();
        expect(match.isPaused).toBe(false);
        expect(match.owners.timeBank.balance(0)).toBe(20_000);
        if (reply === "act") {
          expect(match.owners.actionWindows.hasReservedInput(0)).toBe(false);
          const window = match.owners.actionWindows.timedView(0);
          if (!window) {
            throw new Error("Expected the original action window");
          }
          expect(schedule).toHaveBeenCalledTimes(1);
          expect(schedule.mock.calls[0][1]).toBe(window.expiresAt - clock.now);
        } else {
          expect(
            match.owners.timing.promptTiming?.hasReserved(
              reply === "ready" ? "ready" : "session_vote"
            )
          ).toBe(false);
          const fresh = match.promptReceipt(0, clock.now);
          if (reply === "ready") {
            await match.handleReady(0, fresh);
          } else {
            await match.handleVoteContinue(0, reply, fresh);
          }
          expect(execute).toHaveBeenCalledTimes(1);
          expect(fresh.ownerGeneration).toBe(
            match.owners.connections.view(0).generation
          );
        }
      } finally {
        release();
        execute.mockRestore();
        schedule.mockRestore();
        match.owners.lifecycle.ready.finishReadyCheck();
        match.owners.lifecycle.votes.finishContinueVote(false);
        await automatic;
        await waiting;
      }
    }
  );
});
