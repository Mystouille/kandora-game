import { describe, expect, it, vi } from "vitest";
import type { TimingMode } from "~/game/protocol/timing";
import { MatchProcess } from "./match";
import { ephemeralMatchRepository } from "./repository";
import type { MatchRuntime } from "./runtime";
import { DecisionWindowError } from "./timing/actionWindows";

function promptMatch(timingMode: TimingMode = "windows-v2"): MatchProcess {
  const runtime: MatchRuntime = {
    clockEpoch: "facade-prompts",
    now: () => 1_000,
    random: () => 0.5,
    captureRandomState: () => 0,
    restoreRandomState: () => undefined,
    schedule: () => ({ cancel: () => undefined }),
    sleep: async () => undefined,
  };
  const match = new MatchProcess(
    "facade-prompts",
    42,
    [0, 1, 2, 3].map((seat) => ({
      userId: `player-${seat}`,
      displayName: `Player ${seat}`,
      isBot: seat !== 0,
    })),
    { repository: ephemeralMatchRepository, runtime, timingMode }
  );
  match.configurePlayerTiming(0, "direct", () => null);
  return match;
}

function openVote(match: MatchProcess): Promise<boolean> {
  return match.owners.lifecycle.votes.runContinueVote([
    { seat: 0, score: 25_000, place: 1 },
    { seat: 1, score: 25_000, place: 2 },
    { seat: 2, score: 25_000, place: 3 },
    { seat: 3, score: 25_000, place: 4 },
  ]);
}

describe("MatchProcess fixed prompt facade", () => {
  it("keeps receipt-free legacy ready and vote calls unchanged", async () => {
    const match = promptMatch("legacy");
    expect(match.promptReceipt(0, 1_234)).toEqual({ receivedAt: 1_234 });
    const checking = match.owners.lifecycle.ready.runReadyCheck(5_000);
    await match.handleReady(0);
    await checking;
    const voting = openVote(match);
    await match.handleVoteContinue(0, "yes");
    expect(await voting).toBe(true);
    expect(match.owners.timeBank.balance(0)).toBe(20_000);
  });

  it("requires an authoritative receipt for new-mode ready and vote calls", async () => {
    const match = promptMatch();
    const checking = match.owners.lifecycle.ready.runReadyCheck(5_000);
    try {
      await expect(match.handleReady(0)).rejects.toThrow(
        "An authoritative ready receipt is required"
      );
      expect(match.owners.lifecycle.ready.snapshot().acked[0]).toBe(false);
    } finally {
      match.owners.lifecycle.ready.finishReadyCheck();
      await checking;
    }
    const voting = openVote(match);
    try {
      await expect(match.handleVoteContinue(0, "yes")).rejects.toThrow(
        "An authoritative continue-vote receipt is required"
      );
      expect(match.owners.lifecycle.votes.snapshot().votes[0]).toBeNull();
    } finally {
      match.owners.lifecycle.votes.finishContinueVote(false);
      await voting;
    }
  });

  it("checks the pause barrier before routing any prompt reservation", async () => {
    const match = promptMatch();
    await match.pauseAndSaveCheckpoint();
    const readyReserve = vi.spyOn(match.owners.lifecycle.ready, "reserve");
    const voteReserve = vi.spyOn(match.owners.lifecycle.votes, "reserve");
    for (const reply of ["ready", "yes", "no"] as const) {
      expect(() =>
        match.reservePrompt(0, reply, { receivedAt: 1_000 })
      ).toThrow(DecisionWindowError);
    }
    expect(readyReserve).not.toHaveBeenCalled();
    expect(voteReserve).not.toHaveBeenCalled();
  });

  it.each(["ready", "yes", "no"] as const)(
    "releases the %s reservation when the command rejects",
    async (reply) => {
      const match = promptMatch();
      const waiting =
        reply === "ready"
          ? match.owners.lifecycle.ready.runReadyCheck(5_000)
          : openVote(match);
      const timing = match.owners.timing.promptTiming;
      if (!timing) {
        throw new Error("Expected fixed-prompt timing");
      }
      const kind = reply === "ready" ? "ready" : "session_vote";
      const failure = new Error("command rejected");
      const command =
        reply === "ready"
          ? vi.spyOn(match.owners.commands, "handleReady")
          : vi.spyOn(match.owners.commands, "handleVoteContinue");
      command.mockImplementationOnce(async () => {
        expect(timing.hasReserved(kind)).toBe(true);
        throw failure;
      });
      try {
        const receipt = match.promptReceipt(0, 1_000);
        const submitted =
          reply === "ready"
            ? match.handleReady(0, receipt)
            : match.handleVoteContinue(0, reply, receipt);
        await expect(submitted).rejects.toBe(failure);
        expect(timing.hasReserved(kind)).toBe(false);
        expect(match.owners.timeBank.balance(0)).toBe(20_000);
      } finally {
        command.mockRestore();
        if (reply === "ready") {
          match.owners.lifecycle.ready.finishReadyCheck();
        } else {
          match.owners.lifecycle.votes.finishContinueVote(false);
        }
        await waiting;
      }
    }
  );

  it("rejects a receipt from the previous ready window without consuming the new one", async () => {
    const match = promptMatch();
    const first = match.owners.lifecycle.ready.runReadyCheck(5_000);
    const receipt = match.promptReceipt(0, 1_000);
    match.owners.lifecycle.ready.finishReadyCheck();
    await first;
    const second = match.owners.lifecycle.ready.runReadyCheck(5_000);
    try {
      await expect(match.handleReady(0, receipt)).rejects.toThrow(
        DecisionWindowError
      );
      expect(match.owners.lifecycle.ready.snapshot().acked[0]).toBe(false);
      expect(match.owners.timing.promptTiming?.hasReserved("ready")).toBe(
        false
      );
    } finally {
      match.owners.lifecycle.ready.finishReadyCheck();
      await second;
    }
  });

  it("keeps a queued ready receipt valid across unrelated event-sequence changes", async () => {
    const match = promptMatch();
    const checking = match.owners.lifecycle.ready.runReadyCheck(5_000);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const automatic = match.owners.commands.runAutomaticDefault(async () => {
      await gate;
    });
    const received = match.handleReady(0, match.promptReceipt(0, 1_000));
    try {
      await match.owners.publisher.emitEvent({
        type: "new_dora",
        indicator: "1m",
      });
      release();
      await automatic;
      await received;
      expect(match.owners.lifecycle.ready.snapshot().acked[0]).toBe(true);
      await checking;
    } finally {
      release();
      match.owners.lifecycle.ready.finishReadyCheck();
      await automatic;
      await received;
      await checking;
    }
  });
});
