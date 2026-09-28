import { afterEach, describe, expect, it } from "vitest";
import type { GameEvent, ServerMessage } from "~/game/protocol/messages";
import {
  compactRyuukyokuDeclarationsForReplay,
  MatchProcess,
  setDelayAfterDiscardMs,
  setNextHandDelayMs,
  setReadyCheckMs,
  setRyuukyokuDeclarationTimingMs,
} from "./match";
import { ephemeralMatchRepository } from "./repository";
import type { MatchRuntime } from "./runtime";

function handStart(dealer: 0 | 1 | 2 | 3): GameEvent {
  return {
    type: "hand_start",
    round: 1,
    dealer,
    doraIndicators: ["1z"],
  };
}

describe("native ryuukyoku replay compaction", () => {
  it("merges four live declarations into the exhaustive hand_end", () => {
    const events: GameEvent[] = [
      handStart(2),
      { type: "ryuukyoku_declaration", seat: 2, tenpai: true, hand: ["1m"] },
      { type: "ryuukyoku_declaration", seat: 3, tenpai: false },
      { type: "ryuukyoku_declaration", seat: 0, tenpai: true, hand: ["2m"] },
      { type: "ryuukyoku_declaration", seat: 1, tenpai: false },
      {
        type: "hand_end",
        reason: "exhaustive_draw",
        tenpai: [true, false, true, false],
      },
    ];

    const compacted = compactRyuukyokuDeclarationsForReplay(events);

    expect(compacted).toHaveLength(2);
    expect(compacted.some((event) => event.type === "ryuukyoku_declaration")).toBe(
      false
    );
    expect(compacted[1]).toMatchObject({
      type: "hand_end",
      declarations: [
        { seat: 2, tenpai: true },
        { seat: 3, tenpai: false },
        { seat: 0, tenpai: true },
        { seat: 1, tenpai: false },
      ],
    });
  });

  describe("MatchProcess ryuukyoku declaration pacing", () => {
    afterEach(() => {
      setReadyCheckMs(5_000);
      setNextHandDelayMs(5_000);
      setDelayAfterDiscardMs(350);
      setRyuukyokuDeclarationTimingMs({
        automatic: 700,
        action: 5_000,
        result: 1_000,
      });
    });

    it("waits 700 ms per automatic declaration and 1 second before hand_end", async () => {
      let now = 10_000;
      const sleeps: number[] = [];
      const emitted: Array<{ at: number; event: GameEvent }> = [];
      const runtime: MatchRuntime = {
        now: () => now,
        random: () => 0.5,
        captureRandomState: () => 0,
        restoreRandomState: () => undefined,
        schedule: () => ({ cancel: () => undefined }),
        sleep: async (delayMs) => {
          sleeps.push(delayMs);
          now += delayMs;
        },
      };
      const match = new MatchProcess(
        "ryuukyoku-pacing",
        42,
        [
          { userId: "human-0", displayName: "Human", isBot: false },
          { userId: "bot-1", displayName: "Bot 1", isBot: true },
          { userId: "bot-2", displayName: "Bot 2", isBot: true },
          { userId: "bot-3", displayName: "Bot 3", isBot: true },
        ],
        { repository: ephemeralMatchRepository, runtime }
      );
      match.attachHuman(0, (message: ServerMessage) => {
        if (message.type === "event") {
          for (const event of message.events) {
            emitted.push({ at: now, event });
          }
        }
      });
      setReadyCheckMs(0);
      setNextHandDelayMs(0);
      setDelayAfterDiscardMs(0);
      setRyuukyokuDeclarationTimingMs({
        automatic: 700,
        action: 5_000,
        result: 1_000,
      });
      await match.start();

      const internals = match as unknown as {
        state: {
          phase: string;
          dealer: 0 | 1 | 2 | 3;
          turn: 0 | 1 | 2 | 3;
          roundWind: "E" | "S" | "W" | "N";
          roundNumber: number;
          pendingRyuukyoku: {
            actualTenpai: [boolean, boolean, boolean, boolean];
            declarations: [
              boolean | null,
              boolean | null,
              boolean | null,
              boolean | null,
            ];
            nagashi: [boolean, boolean, boolean, boolean];
          } | null;
          lastHandResult: unknown;
        };
        setSeatLegals(seat: 0 | 1 | 2 | 3, actions: []): void;
        continueRyuukyokuDeclarations(): Promise<void>;
      };
      internals.setSeatLegals(0, []);
      internals.state.phase = "awaiting_ryuukyoku_declarations";
      internals.state.dealer = 0;
      internals.state.turn = 0;
      internals.state.roundWind = "S";
      internals.state.roundNumber = 4;
      internals.state.lastHandResult = null;
      internals.state.pendingRyuukyoku = {
        actualTenpai: [false, false, false, false],
        declarations: [null, null, null, null],
        nagashi: [false, false, false, false],
      };
      sleeps.length = 0;
      emitted.length = 0;

      await internals.continueRyuukyokuDeclarations();

      expect(sleeps).toEqual([700, 700, 700, 700, 1_000]);
      const declarations = emitted.filter(
        ({ event }) => event.type === "ryuukyoku_declaration"
      );
      expect(declarations.map(({ event }) => event)).toEqual([
        { type: "ryuukyoku_declaration", seat: 0, tenpai: false },
        { type: "ryuukyoku_declaration", seat: 1, tenpai: false },
        { type: "ryuukyoku_declaration", seat: 2, tenpai: false },
        { type: "ryuukyoku_declaration", seat: 3, tenpai: false },
      ]);
      const handEnd = emitted.find(({ event }) => event.type === "hand_end");
      expect(handEnd).toBeDefined();
      if (!handEnd) {
        throw new Error("expected exhaustive hand_end");
      }
      expect(handEnd.at - declarations[3].at).toBe(1_000);
      const settledSnapshot = match.buildSnapshotForSeat(0);
      expect(settledSnapshot.type).toBe("snapshot");
      if (settledSnapshot.type !== "snapshot") {
        throw new Error("expected settled snapshot");
      }
      expect(settledSnapshot.state.lastHandResult).toMatchObject({
        type: "hand_end",
        reason: "exhaustive_draw",
        declarations: [
          { seat: 0, tenpai: false },
          { seat: 1, tenpai: false },
          { seat: 2, tenpai: false },
          { seat: 3, tenpai: false },
        ],
      });
    });

    it("offers a fixed five-second prompt and defaults a silent human to tenpai", async () => {
      let now = 20_000;
      const sleeps: number[] = [];
      const emitted: GameEvent[] = [];
      const runtime: MatchRuntime = {
        now: () => now,
        random: () => 0.5,
        captureRandomState: () => 0,
        restoreRandomState: () => undefined,
        schedule: () => ({ cancel: () => undefined }),
        sleep: async (delayMs) => {
          sleeps.push(delayMs);
          now += delayMs;
        },
      };
      const match = new MatchProcess(
        "ryuukyoku-timeout",
        43,
        [
          { userId: "human-0", displayName: "Human", isBot: false },
          { userId: "bot-1", displayName: "Bot 1", isBot: true },
          { userId: "bot-2", displayName: "Bot 2", isBot: true },
          { userId: "bot-3", displayName: "Bot 3", isBot: true },
        ],
        { repository: ephemeralMatchRepository, runtime }
      );
      match.attachHuman(0, (message: ServerMessage) => {
        if (message.type === "event") {
          emitted.push(...message.events);
        }
      });
      setReadyCheckMs(0);
      setNextHandDelayMs(0);
      setDelayAfterDiscardMs(0);
      setRyuukyokuDeclarationTimingMs({
        automatic: 700,
        action: 5_000,
        result: 0,
      });
      await match.start();

      const internals = match as unknown as {
        state: {
          phase: string;
          dealer: 0 | 1 | 2 | 3;
          turn: 0 | 1 | 2 | 3;
          pendingRyuukyoku: {
            actualTenpai: [boolean, boolean, boolean, boolean];
            declarations: [
              boolean | null,
              boolean | null,
              boolean | null,
              boolean | null,
            ];
            nagashi: [boolean, boolean, boolean, boolean];
          } | null;
          lastHandResult: unknown;
        };
        setSeatLegals(seat: 0 | 1 | 2 | 3, actions: []): void;
        continueRyuukyokuDeclarations(): Promise<void>;
        handleDeadlineExpiry(seat: 0 | 1 | 2 | 3): Promise<void>;
      };
      internals.setSeatLegals(0, []);
      internals.state.phase = "awaiting_ryuukyoku_declarations";
      internals.state.dealer = 0;
      internals.state.turn = 0;
      internals.state.lastHandResult = null;
      internals.state.pendingRyuukyoku = {
        actualTenpai: [true, false, false, false],
        declarations: [null, null, null, null],
        nagashi: [false, false, false, false],
      };
      emitted.length = 0;
      sleeps.length = 0;

      await internals.continueRyuukyokuDeclarations();

      const prompt = match.buildSnapshotForSeat(0);
      expect(prompt.type).toBe("snapshot");
      if (prompt.type !== "snapshot") {
        throw new Error("expected player snapshot");
      }
      expect(prompt.legalActions.map((action) => action.type)).toEqual([
        "declare_noten",
        "declare_tenpai",
      ]);
      expect(prompt.deadline).toBe(now + 5_000);
      expect(prompt.bufferMs).toBeUndefined();

      const checkpoint = match.createCheckpoint();
      expect(checkpoint.status).toBe("playing");
      if (
        checkpoint.status !== "playing" ||
        checkpoint.checkpointKind !== "action_window"
      ) {
        throw new Error("expected declaration action checkpoint");
      }
      expect(checkpoint.actionWindow.kind).toBe("ryuukyoku_declaration");
      expect(checkpoint.actionWindow.visibleRemainingMs).toBe(5_000);
      const restored = MatchProcess.restoreCheckpoint(checkpoint, {
        repository: ephemeralMatchRepository,
        runtime,
      });
      const restoredPrompt = restored.buildSnapshotForSeat(0);
      expect(restoredPrompt.type).toBe("snapshot");
      if (restoredPrompt.type !== "snapshot") {
        throw new Error("expected restored player snapshot");
      }
      expect(restoredPrompt.legalActions).toEqual(prompt.legalActions);
      expect(restoredPrompt.deadline).toBe(prompt.deadline);
      expect(restoredPrompt.bufferMs).toBeUndefined();

      now += 5_000;
      await internals.handleDeadlineExpiry(0);

      expect(sleeps[0]).toBe(700);
      expect(emitted).toContainEqual({
        type: "ryuukyoku_declaration",
        seat: 0,
        tenpai: true,
        hand: expect.any(Array),
      });
    });
  });

  it("leaves legacy exhaustive draws unchanged", () => {
    const events: GameEvent[] = [
      handStart(0),
      {
        type: "hand_end",
        reason: "exhaustive_draw",
        tenpai: [false, false, false, false],
      },
    ];

    expect(compactRyuukyokuDeclarationsForReplay(events)).toEqual(events);
  });

  it("rejects a declaration sequence that is not in current wind order", () => {
    const events: GameEvent[] = [
      handStart(1),
      { type: "ryuukyoku_declaration", seat: 1, tenpai: true },
      { type: "ryuukyoku_declaration", seat: 3, tenpai: false },
      { type: "ryuukyoku_declaration", seat: 2, tenpai: false },
      { type: "ryuukyoku_declaration", seat: 0, tenpai: false },
      {
        type: "hand_end",
        reason: "exhaustive_draw",
        tenpai: [false, true, false, false],
      },
    ];

    expect(() => compactRyuukyokuDeclarationsForReplay(events)).toThrow(
      "misordered"
    );
  });

  it("rejects an orphaned partial declaration sequence", () => {
    expect(() =>
      compactRyuukyokuDeclarationsForReplay([
        handStart(0),
        { type: "ryuukyoku_declaration", seat: 0, tenpai: false },
      ])
    ).toThrow("no hand_end");
  });
});
