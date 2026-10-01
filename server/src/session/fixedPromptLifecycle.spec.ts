import { describe, expect, it } from "vitest";
import type { ServerMessage } from "~/game/protocol/messages";
import { createControlledRuntime } from "~/game/testing/timing/controlledRuntime";
import { ActionWindowRegistry } from "../timing/actionWindows";
import { PromptWindows } from "../timing/promptWindows";
import { RoomRoster } from "./roomRoster";
import { PlayerConnections } from "./playerConnections";
import { CommandCoordinator } from "./commandCoordinator";
import { ReadyCheck } from "./readyCheck";
import { ContinueVote } from "./continueVote";

function fixture() {
  const runtime = createControlledRuntime(1_000);
  const messages: ServerMessage[] = [];
  const roster = new RoomRoster(
    "fixed-prompts",
    [0, 1, 2, 3].map((seat) => ({
      userId: `human-${seat}`,
      displayName: `Human ${seat}`,
      isBot: false,
    })),
    {
      status: () => "playing",
      assertNotPaused: () => undefined,
      hasSender: () => true,
      send: (_seat, message) => messages.push(message),
      clearConnection: () => undefined,
      permuteConnections: () => undefined,
      onPlayingHumanClaimed: () => undefined,
      broadcastRoom: () => undefined,
      broadcastViewers: () => undefined,
      start: async () => undefined,
    }
  );
  const connections = new PlayerConnections(
    (seat) => roster.player(seat),
    () => undefined
  );
  const windows = new ActionWindowRegistry(
    runtime,
    () => undefined,
    () => false
  );
  const prompts = new PromptWindows(
    "fixed-prompts",
    "epoch-1",
    runtime,
    () => ({
      network: "remote",
      profile: null,
    })
  );
  let ready: ReadyCheck;
  let vote: ContinueVote;
  let hold: Promise<void> | null = null;
  const commands = new CommandCoordinator(windows, {
    sequence: () => 0,
    status: () => "playing",
    isPaused: () => false,
    pendingCheckpointSave: () => null,
    decisionId: (command) => prompts.view(command.seat)?.id ?? null,
    accept: (command) =>
      command.type === "ready"
        ? ready.isAcceptedReady(command.seat)
        : command.type === "vote_continue" &&
          vote.isAcceptedContinueVote(command.seat, command.vote),
    execute: async (command) => {
      if (hold) {
        await hold;
      }
      if (command.type === "ready") {
        ready.handleReadyDirect(command.seat);
      } else if (command.type === "vote_continue") {
        await vote.handleVoteContinueDirect(command.seat, command.vote);
      }
    },
    afkDefaultAction: () => null,
    persistRecovery: async () => undefined,
  });
  ready = new ReadyCheck(
    runtime,
    roster,
    commands,
    {
      isPaused: () => false,
      humanSeats: () => [0, 1, 2, 3],
      sender: () => (message) => {
        messages.push(message);
      },
      resumeReadyContinuation: async () => undefined,
    },
    prompts
  );
  vote = new ContinueVote(
    runtime,
    roster,
    connections,
    commands,
    {
      isPaused: () => false,
      emitEvent: async (event) => {
        messages.push({
          type: "event",
          seq: 0,
          events: [event],
          legalActions: [],
        });
      },
      gameIndex: () => 0,
      gameFinalized: () => undefined,
      continueAfterVote: async () => undefined,
    },
    prompts
  );
  return {
    runtime,
    prompts,
    ready,
    vote,
    commands,
    messages,
    setHold: (promise: Promise<void>) => {
      hold = promise;
    },
  };
}

describe("fixed readiness and vote lifecycle", () => {
  it("publishes private ready identities and resolves acknowledgements without bank use", async () => {
    const f = fixture();
    const waiting = f.ready.runReadyCheck(5_000, "initial_hand");
    const frames = f.messages.filter(
      (message) => message.type === "ready_check"
    );
    expect(frames).toHaveLength(4);
    expect(
      frames.map((message) =>
        message.type === "ready_check" ? message.window?.id : null
      )
    ).toEqual(
      [0, 1, 2, 3].map((seat) => f.prompts.view(seat as 0 | 1 | 2 | 3)?.id)
    );
    for (const seat of [0, 1, 2, 3] as const) {
      const window = f.prompts.view(seat);
      if (!window) {
        throw new Error("Expected ready identity");
      }
      f.ready.reserve(seat, {
        receivedAt: 1_500,
        windowId: window.id,
        clockEpoch: window.clockEpoch,
      });
      await f.commands.handleReady(seat);
    }
    await waiting;
    expect(f.ready.snapshot().active).toBe(false);
    expect(f.prompts.view(0)).toBeNull();
  });

  it("lets a timely queued ready reply beat the aggregate timeout", async () => {
    const f = fixture();
    const waiting = f.ready.runReadyCheck(5_000, "initial_hand");
    let release!: () => void;
    f.setHold(
      new Promise<void>((resolve) => {
        release = resolve;
      })
    );
    await f.runtime.advanceBy(5_199);
    const window = f.prompts.view(0);
    if (!window) {
      throw new Error("Expected ready window");
    }
    f.ready.reserve(0, {
      receivedAt: f.runtime.now(),
      windowId: window.id,
      clockEpoch: window.clockEpoch,
    });
    const reply = f.commands.handleReady(0);
    await f.runtime.advanceBy(1_000);
    expect(f.ready.snapshot().active).toBe(true);
    release();
    await reply;
    await waiting;
    expect(f.ready.snapshot().acked[0]).toBe(true);
    expect(f.ready.snapshot().active).toBe(false);
  });

  it("resolves a reserved no vote by the actual reply rather than an expired default", async () => {
    const f = fixture();
    const waiting = f.vote.runContinueVote(
      [0, 1, 2, 3].map((seat) => ({
        seat: seat as 0 | 1 | 2 | 3,
        score: 25_000,
        place: (seat + 1) as 1 | 2 | 3 | 4,
      }))
    );
    const window = f.prompts.view(0);
    if (!window) {
      throw new Error("Expected vote window");
    }
    await f.runtime.advanceBy(window.expiresAt - f.runtime.now() - 1);
    let release!: () => void;
    f.setHold(
      new Promise<void>((resolve) => {
        release = resolve;
      })
    );
    f.vote.reserve(0, "no", {
      receivedAt: f.runtime.now(),
      windowId: window.id,
      clockEpoch: window.clockEpoch,
    });
    const reply = f.commands.handleVoteContinue(0, "no");
    await f.runtime.advanceBy(1_000);
    expect(f.vote.snapshot().active).toBe(true);
    release();
    await reply;
    await expect(waiting).resolves.toBe(false);
    expect(f.vote.snapshot().lastVoteReason).toBe("vote_no");
  });
});
