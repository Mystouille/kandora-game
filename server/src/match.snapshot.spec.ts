/**
 * Snapshot hydration tests.
 *
 * A reconnect mid-match sends a fresh `snapshot` message; the client
 * must be able to (a) validate it via the Zod schema and (b) hydrate
 * the Zustand store so the renderer paints the correct table state.
 *
 * Mongo is mocked so the orchestrator can run a few turns without
 * a database.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MatchProcess, setDelayAfterDiscardMs } from "./match";
import { ephemeralMatchRepository } from "./repository";
import { ServerMessageSchema } from "~/game/protocol/messages";
import { useMatchStore } from "~/game/client/store";
import type { RuleSetOverride } from "~/game/rules/ruleSet";

function makeMatch(
  seed: number,
  ruleSetOverride?: RuleSetOverride
): MatchProcess {
  return new MatchProcess(
    `m-${seed}-${Math.random().toString(36).slice(2, 8)}`,
    seed,
    [
      { userId: "u0", displayName: "Human", isBot: false },
      { userId: "u1", displayName: "Bot1", isBot: true },
      { userId: "u2", displayName: "Bot2", isBot: true },
      { userId: "u3", displayName: "Bot3", isBot: true },
    ],
    { repository: ephemeralMatchRepository },
    undefined,
    ruleSetOverride
  );
}

describe("snapshot hydration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useMatchStore.getState().reset();
    setDelayAfterDiscardMs(0);
  });
  afterEach(() => {
    vi.clearAllMocks();
    setDelayAfterDiscardMs(350);
  });

  it("server snapshot validates against the protocol schema", async () => {
    const m = makeMatch(1);
    m.attachHuman(0, () => undefined);
    await m.start();
    const snapshot = m.buildSnapshotForSeat(0);
    const parsed = ServerMessageSchema.safeParse(snapshot);
    if (!parsed.success) {
      // eslint-disable-next-line no-console
      console.error(parsed.error.issues);
    }
    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.data.type === "snapshot") {
      expect(parsed.data.state.mySeat).toBe(0);
      expect(parsed.data.state.scores).toEqual([25000, 25000, 25000, 25000]);
      expect(parsed.data.state.dealer).toBe(0);
      expect(parsed.data.state.roundWind).toBe("E");
    }
  });

  it("hydrateSnapshot populates round/score/dealer fields", async () => {
    const m = makeMatch(1, { uraDora: false });
    m.attachHuman(0, () => undefined);
    await m.start();
    const snapshot = m.buildSnapshotForSeat(0);
    const parsed = ServerMessageSchema.safeParse(snapshot);
    expect(parsed.success).toBe(true);
    if (!parsed.success || parsed.data.type !== "snapshot") {
      return;
    }
    useMatchStore
      .getState()
      .hydrateSnapshot(parsed.data.state, parsed.data.seq);
    const view = useMatchStore.getState();
    expect(view.mySeat).toBe(0);
    expect(view.dealer).toBe(0);
    expect(view.roundWind).toBe("E");
    expect(view.roundNumber).toBe(1);
    expect(view.honba).toBe(0);
    expect(view.scores).toEqual([25000, 25000, 25000, 25000]);
    expect(view.uraDoraEnabled).toBe(false);
    expect(view.hands[0].length).toBeGreaterThanOrEqual(13);
    // Opponents redacted to nulls.
    for (let s = 1; s < 4; s++) {
      expect(view.hands[s].every((t) => t === null)).toBe(true);
    }
    expect(view.lastSeq).toBe(parsed.data.seq);
  });

  it("hydrateSnapshot clears stale lastHandResult and matchEnded", () => {
    // Pre-populate the store as if a previous hand had ended.
    useMatchStore.setState({
      lastHandResult: {
        reason: "exhaustive_draw",
        delta: [0, 0, 0, 0],
      },
      matchEnded: {
        reason: "round_limit",
        finalScores: [
          { seat: 0, score: 25000, place: 1 },
          { seat: 1, score: 25000, place: 2 },
          { seat: 2, score: 25000, place: 3 },
          { seat: 3, score: 25000, place: 4 },
        ],
      },
    });
    const fakeState = {
      mySeat: 0 as const,
      hands: [
        new Array(13).fill(null),
        new Array(13).fill(null),
        new Array(13).fill(null),
        new Array(13).fill(null),
      ],
      discards: [[], [], [], []],
      melds: [[], [], [], []],
      wallRemaining: 70,
      doraIndicators: [],
      turn: 0 as const,
      dealer: 1 as const,
      roundWind: "E" as const,
      roundNumber: 2,
      honba: 1,
      riichiSticks: 0,
      scores: [27000, 24000, 24000, 25000],
      riichiDeclared: [false, false, false, false],
      lastDiscard: null,
      phase: "awaiting_draw",
    };
    useMatchStore.getState().hydrateSnapshot(fakeState, 42);
    const view = useMatchStore.getState();
    expect(view.lastHandResult).toBeNull();
    expect(view.matchEnded).toBeNull();
    expect(view.dealer).toBe(1);
    expect(view.honba).toBe(1);
    expect(view.scores).toEqual([27000, 24000, 24000, 25000]);
  });

  it("captures the completed hand dealer in the live result", () => {
    useMatchStore.setState({ dealer: 3 });

    useMatchStore.getState().applyEvent(
      { type: "hand_end", reason: "exhaustive_draw" },
      1
    );

    expect(useMatchStore.getState().lastHandResult?.dealer).toBe(3);
  });

  it("snapshot includes furiten with only the recipient's own slot populated", async () => {
    const m = makeMatch(1);
    m.attachHuman(0, () => undefined);
    await m.start();
    const snapshot = m.buildSnapshotForSeat(0);
    const parsed = ServerMessageSchema.safeParse(snapshot);
    expect(parsed.success).toBe(true);
    if (!parsed.success || parsed.data.type !== "snapshot") {
      return;
    }
    // Opponent slots are always false (privacy); seat 0's slot
    // reflects real engine state. At match start no seat is in
    // furiten, so the whole tuple is false.
    expect(parsed.data.state.furiten).toEqual([false, false, false, false]);
  });
});
