import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { MatchProcess, setReadyCheckMs } from "../match";
import {
  ephemeralMatchRepository,
  type ArchiveReplayLogArgs,
  type MatchRepository,
} from "../repository";
import type { MatchRuntime } from "../runtime";

const concernFiles = [
  "composition/dependencies.ts",
  "composition/matchComposition.ts",
  "composition/matchGameplay.ts",
  "composition/matchLifecycle.ts",
  "recovery/checkpointInstaller.ts",
  "recovery/matchRecovery.ts",
  "relay/relayMatch.ts",
  "session/eventReplay.ts",
  "session/gameArchive.ts",
  "session/gameplayEffects.ts",
  "session/matchBroadcast.ts",
  "session/matchViewDetails.ts",
  "session/roomViews.ts",
  "session/spectatorStreams.ts",
  "session/viewerPresence.ts",
];

function sourceLines(relativePath: string): number {
  const source = readFileSync(
    new URL(`../${relativePath}`, import.meta.url),
    "utf8"
  );
  return source.trimEnd().split(/\r?\n/u).length;
}

function clockRuntime(
  clock: { reference: number; calendar: number },
  clockEpoch: string
): MatchRuntime {
  return {
    clockEpoch,
    now: () => clock.reference,
    wallNow: () => clock.calendar,
    random: () => 0.5,
    captureRandomState: () => 0,
    restoreRandomState: () => undefined,
    schedule: () => ({ cancel: () => undefined }),
    sleep: async (ms) => {
      clock.reference += ms;
      clock.calendar += ms;
    },
  };
}

function ownedMatch(
  matchId: string,
  runtime: MatchRuntime,
  repository: MatchRepository = ephemeralMatchRepository
): MatchProcess {
  return new MatchProcess(
    matchId,
    42,
    [0, 1, 2, 3].map((seat) => ({
      userId: `player-${seat}`,
      displayName: `Player ${seat}`,
      isBot: seat !== 0,
    })),
    { repository, runtime }
  );
}

describe("MatchProcess owned composition", () => {
  afterEach(() => setReadyCheckMs(5_000));

  it("keeps the public facade within its physical source-line budget", () => {
    expect(sourceLines("match.ts")).toBeLessThanOrEqual(800);
  });

  it("keeps every extracted concern within its physical source-line budget", () => {
    for (const file of concernFiles) {
      expect(sourceLines(file), file).toBeLessThanOrEqual(500);
    }
  });

  it("retains waiting-room composition through the roster owner", () => {
    const match = MatchProcess.createWaitingRoom("owned-room", 42, {
      repository: ephemeralMatchRepository,
    });
    expect(match.owners.roster.players().size).toBe(4);
    expect([...match.owners.roster.players().values()]).toEqual([
      null,
      null,
      null,
      null,
    ]);
    const seat = match.claimSeat("human", "Human");
    expect(seat).toBe(0);
    expect(match.owners.roster.humanSeats()).toEqual([0]);
    expect(match.buildRoomState(seat).hostSeat).toBe(0);
  });

  it("exposes captured roster, sequence and hand metadata without writable aliases", async () => {
    let now = 1_000;
    const runtime: MatchRuntime = {
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
      "owned-snapshots",
      42,
      [0, 1, 2, 3].map((seat) => ({
        userId: `human-${seat}`,
        displayName: `Human ${seat}`,
        isBot: false,
      })),
      { repository: ephemeralMatchRepository, runtime }
    );
    setReadyCheckMs(0);
    await match.start();

    const sequences = match.owners.publisher.seatSequences();
    sequences[0] = 999;
    expect(match.owners.publisher.seatSequences()[0]).not.toBe(999);
    const metadata = match.owners.metadata.snapshot();
    metadata.dice[0] = 1;
    expect(match.owners.metadata.snapshot().dice[0]).toBe(4);
    const player = match.owners.roster.player(0);
    expect(player?.displayName).toBe("Human 0");
    expect(match.buildSnapshotForSeat(0).state.hands[0].length).toBe(14);
  });

  it("shares the decision timing owner with readiness and continue votes", async () => {
    const clock = { reference: 1_000, calendar: Date.UTC(2026, 9, 1) };
    const match = ownedMatch(
      "owned-prompts",
      clockRuntime(clock, "prompt-epoch"),
      ephemeralMatchRepository
    );
    match.configurePlayerTiming(0, "direct", () => null);
    const ready = match.owners.lifecycle.ready;
    const checking = ready.runReadyCheck(5_000);
    try {
      const window = match.owners.timing.metadata(0, 0).promptWindow;
      expect(window).toMatchObject({
        kind: "ready",
        clockEpoch: "prompt-epoch",
        baseEndsAt: 6_000,
        bankAtOpenMs: 0,
        allowanceMs: 0,
      });
      if (!window) {
        throw new Error("Expected the shared readiness window");
      }
      const receipt = match.promptReceipt(0, clock.reference);
      expect(receipt.windowId).toBe(window.id);
      await match.handleReady(0, receipt);
    } finally {
      ready.finishReadyCheck();
      await checking;
    }
    expect(match.owners.timing.metadata(0, 0).promptWindow).toBeNull();

    const votes = match.owners.lifecycle.votes;
    const voting = votes.runContinueVote([
      { seat: 0, score: 25_000, place: 1 },
      { seat: 1, score: 25_000, place: 2 },
      { seat: 2, score: 25_000, place: 3 },
      { seat: 3, score: 25_000, place: 4 },
    ]);
    try {
      const window = match.owners.timing.metadata(0, 0).promptWindow;
      expect(window).toMatchObject({
        kind: "session_vote",
        clockEpoch: "prompt-epoch",
        bankAtOpenMs: 0,
        allowanceMs: 0,
      });
      if (!window) {
        throw new Error("Expected the shared continue-vote window");
      }
      const receipt = match.promptReceipt(0, clock.reference);
      expect(receipt.windowId).toBe(window.id);
      await match.handleVoteContinue(0, "no", receipt);
    } finally {
      votes.finishContinueVote(false);
      expect(await voting).toBe(false);
    }
    expect(match.owners.timing.metadata(0, 0).promptWindow).toBeNull();
    expect(match.owners.timeBank.balance(0)).toBe(20_000);
  });

  it("uses the calendar clock for game and relay replay archive dates", async () => {
    const archived: ArchiveReplayLogArgs[] = [];
    const repository: MatchRepository = {
      ...ephemeralMatchRepository,
      archiveReplayLog: async (args) => {
        archived.push(args);
      },
    };
    const clock = { reference: 1_000, calendar: Date.UTC(2026, 9, 1) };
    const match = ownedMatch(
      "owned-calendar-archive",
      clockRuntime(clock, "archive-epoch"),
      repository
    );
    setReadyCheckMs(0);
    await match.start();
    const startedCalendarAt = match.sessionSnapshot().startedAt?.getTime();
    clock.reference += 100;
    clock.calendar += 60_000;
    await match.owners.archive.archiveCurrentGame([
      { seat: 0, score: 25_000, place: 1 },
      { seat: 1, score: 25_000, place: 2 },
      { seat: 2, score: 25_000, place: 3 },
      { seat: 3, score: 25_000, place: 4 },
    ]);
    expect(archived[0].startedAt.getTime()).toBe(startedCalendarAt);
    expect(archived[0].endedAt.getTime()).toBe(clock.calendar);

    const relay = MatchProcess.createRelayMatch(
      "owned-calendar-relay",
      "source-game",
      {
        repository,
        runtime: clockRuntime(clock, "relay-epoch"),
      }
    );
    const relayStartedAt = clock.calendar;
    clock.reference += 100;
    clock.calendar += 60_000;
    await relay.closeRelay();
    expect(archived[1].startedAt.getTime()).toBe(relayStartedAt);
    expect(archived[1].endedAt.getTime()).toBe(clock.calendar);
  });

  it("restores calendar metadata without changing authoritative event or start ages", async () => {
    const clock = { reference: 1_000, calendar: Date.UTC(2026, 9, 1) };
    const match = ownedMatch(
      "owned-calendar-restore",
      clockRuntime(clock, "source-epoch")
    );
    setReadyCheckMs(0);
    await match.start();
    const checkpoint = match.createCheckpoint();
    if (checkpoint.status !== "playing") {
      throw new Error("Expected a playing checkpoint");
    }
    checkpoint.eventLog[0].calendarAt = 0;
    const restoredClock = {
      reference: 1_000_000,
      calendar: Date.UTC(2027, 9, 1),
    };
    const restored = MatchProcess.restoreCheckpoint(checkpoint, {
      repository: ephemeralMatchRepository,
      runtime: clockRuntime(restoredClock, "restored-epoch"),
    });
    expect(restored.sessionSnapshot().startedAt?.getTime()).toBe(
      checkpoint.startedCalendarAt
    );
    expect(restored.sessionSnapshot().startedReferenceAt).toBe(
      restoredClock.reference - checkpoint.startedAgoMs
    );
    expect(restored.owners.publisher.history()).toEqual(
      checkpoint.eventLog.map((entry) => ({
        seq: entry.seq,
        event: entry.event,
        emittedAt: restoredClock.reference - entry.emittedAgoMs,
        calendarAt: entry.calendarAt,
      }))
    );
    const recaptured = restored.createCheckpoint();
    if (recaptured.status !== "playing") {
      throw new Error("Expected the restored playing checkpoint");
    }
    expect(recaptured.startedAgoMs).toBe(checkpoint.startedAgoMs);
    expect(recaptured.startedCalendarAt).toBe(checkpoint.startedCalendarAt);
    expect(recaptured.eventLog.map((entry) => entry.calendarAt)).toEqual(
      checkpoint.eventLog.map((entry) => entry.calendarAt)
    );
  });

  it("keeps version-5 checkpoints and runtimes without optional calendar fields usable", async () => {
    const clock = { reference: 1_000, calendar: Date.UTC(2026, 9, 1) };
    const match = ownedMatch(
      "owned-calendar-legacy",
      clockRuntime(clock, "legacy-source")
    );
    setReadyCheckMs(0);
    await match.start();
    const checkpoint = match.createCheckpoint();
    if (checkpoint.status !== "playing") {
      throw new Error("Expected a playing checkpoint");
    }
    const legacy = { ...checkpoint, schemaVersion: 5 };
    delete legacy.startedCalendarAt;
    for (const entry of legacy.eventLog) {
      delete entry.calendarAt;
    }
    const restoredClock = {
      reference: 1_000_000,
      calendar: Date.UTC(2027, 9, 1),
    };
    const runtime = clockRuntime(restoredClock, "legacy-restored");
    delete runtime.wallNow;
    const restored = MatchProcess.restoreCheckpoint(legacy, {
      repository: ephemeralMatchRepository,
      runtime,
    });
    expect(restored.sessionSnapshot().startedAt?.getTime()).toBe(
      restoredClock.reference - checkpoint.startedAgoMs
    );
    expect(restored.sessionSnapshot().startedReferenceAt).toBe(
      restoredClock.reference - checkpoint.startedAgoMs
    );
    for (const entry of restored.owners.publisher.history()) {
      expect(entry).not.toHaveProperty("calendarAt");
    }
  });
});
