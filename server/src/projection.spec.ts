/**
 * Per-recipient projection — privacy / redaction guarantees.
 *
 * The projection layer is the wire-level redaction boundary: every
 * event sent to a live recipient (and every event replayed via the
 * in-process resync) must pass through it. Returning `null` means
 * "drop this event entirely for this recipient" — the per-seat seq
 * counter in `MatchProcess` will not advance, so each seat's wire
 * stream remains strictly contiguous from their own perspective.
 */
import { describe, expect, it } from "vitest";

import type { GameEvent, Seat } from "~/game/protocol/messages";

import { projectEvent, projectPublicEvent } from "./projection";

describe("projectEvent — privacy redaction", () => {
  it("drops furiten events whose seat is not the recipient", () => {
    const ev: GameEvent = { type: "furiten", seat: 1, active: true };
    for (const recipient of [0, 2, 3] as Seat[]) {
      expect(projectEvent(ev, recipient)).toBeNull();
    }
  });

  it("passes furiten events through to the affected seat", () => {
    const ev: GameEvent = { type: "furiten", seat: 2, active: true };
    expect(projectEvent(ev, 2)).toEqual(ev);
  });

  it("strips the drawn tile when the recipient is not the drawer", () => {
    const ev: GameEvent = {
      type: "draw",
      seat: 1,
      tile: "5m",
      wallRemaining: 69,
    };
    const projected = projectEvent(ev, 0);
    expect(projected).not.toBeNull();
    expect(projected?.type).toBe("draw");
    if (projected?.type === "draw") {
      expect(projected.tile).toBeUndefined();
      expect(projected.wallRemaining).toBe(69);
    }
  });

  it("keeps the drawn tile when the recipient is the drawer", () => {
    const ev: GameEvent = {
      type: "draw",
      seat: 0,
      tile: "5m",
      wallRemaining: 69,
    };
    expect(projectEvent(ev, 0)).toEqual(ev);
  });
});

describe("projectEvent — spectator (omniscient)", () => {
  it("keeps the drawn tile for every seat", () => {
    for (const seat of [0, 1, 2, 3] as Seat[]) {
      const ev: GameEvent = {
        type: "draw",
        seat,
        tile: "5m",
        wallRemaining: 42,
        fromDeadWall: true,
      };
      const projected = projectEvent(ev, "spectator");
      expect(projected).not.toBeNull();
      expect(projected?.type).toBe("draw");
      if (projected?.type === "draw") {
        expect(projected.tile).toBe("5m");
        expect(projected.seat).toBe(seat);
        expect(projected.wallRemaining).toBe(42);
        expect(projected.fromDeadWall).toBe(true);
      }
    }
  });

  it("forwards every furiten event (spectators are omniscient)", () => {
    for (const seat of [0, 1, 2, 3] as Seat[]) {
      const ev: GameEvent = { type: "furiten", seat, active: true };
      expect(projectEvent(ev, "spectator")).toEqual(ev);
    }
  });

  it("forwards hand_start verbatim (omniscient: hands + walls + schedule)", () => {
    const ev: GameEvent = {
      type: "hand_start",
      round: 1,
      dealer: 0,
      roundWind: "E",
      roundNumber: 1,
      honba: 0,
      riichiSticks: 0,
      scores: [25000, 25000, 25000, 25000],
      hand: ["1m", "2m", "3m"],
      startingHands: [
        ["1m", "2m", "3m"],
        ["4m", "5m", "6m"],
        ["7m", "8m", "9m"],
        ["1p", "2p", "3p"],
      ],
      doraIndicators: ["1z"],
      liveWall: new Array(70).fill("1m"),
      deadWall: new Array(14).fill("2m"),
      liveDrawSchedule: new Array(70).fill(0),
    };
    const projected = projectEvent(ev, "spectator");
    expect(projected).not.toBeNull();
    expect(projected?.type).toBe("hand_start");
    if (projected?.type === "hand_start") {
      // Public + omniscient hand fields preserved.
      expect(projected.round).toBe(1);
      expect(projected.dealer).toBe(0);
      expect(projected.roundWind).toBe("E");
      expect(projected.doraIndicators).toEqual(["1z"]);
      expect(projected.scores).toEqual([25000, 25000, 25000, 25000]);
      expect(projected.hand).toEqual(["1m", "2m", "3m"]);
      expect(projected.startingHands).toEqual([
        ["1m", "2m", "3m"],
        ["4m", "5m", "6m"],
        ["7m", "8m", "9m"],
        ["1p", "2p", "3p"],
      ]);
      // Wall reveal fields are also forwarded — spectators are
      // omniscient and the wall overlay uses these.
      expect(projected.liveWall).toEqual(new Array(70).fill("1m"));
      expect(projected.deadWall).toEqual(new Array(14).fill("2m"));
      expect(projected.liveDrawSchedule).toEqual(new Array(70).fill(0));
    }
  });

  it("passes public events (discard, call, win, hand_end, new_dora, match_start, match_end) through unchanged", () => {
    const events: GameEvent[] = [
      { type: "discard", seat: 1, tile: "9p", tsumogiri: false },
      {
        type: "call",
        seat: 2,
        meld: {
          type: "pon",
          tiles: ["5s", "5s", "5s"],
          claimedTile: "5s",
          from: 1,
        },
      },
      { type: "new_dora", indicator: "3z" },
      {
        type: "win",
        seat: 0,
        loser: 1,
        winTile: "4m",
        han: 3,
        fu: 30,
        ten: 5200,
      },
      { type: "hand_end", reason: "ron", delta: [5200, -5200, 0, 0] },
      {
        type: "match_start",
        seats: [
          { seat: 0, userId: "a", displayName: "A" },
          { seat: 1, userId: "b", displayName: "B" },
          { seat: 2, userId: "c", displayName: "C" },
          { seat: 3, userId: "d", displayName: "D" },
        ],
        ruleSet: "default",
      },
      {
        type: "match_end",
        reason: "round_limit",
        finalScores: [
          { seat: 0, score: 30000, place: 1 },
          { seat: 1, score: 25000, place: 2 },
          { seat: 2, score: 23000, place: 3 },
          { seat: 3, score: 22000, place: 4 },
        ],
      },
    ];
    for (const ev of events) {
      expect(projectEvent(ev, "spectator")).toEqual(ev);
    }
  });

  it("projectPublicEvent is equivalent to projectEvent(ev, 'spectator')", () => {
    const ev: GameEvent = {
      type: "draw",
      seat: 2,
      tile: "5m",
      wallRemaining: 10,
    };
    expect(projectPublicEvent(ev)).toEqual(projectEvent(ev, "spectator"));
    const furiten: GameEvent = { type: "furiten", seat: 3, active: true };
    expect(projectPublicEvent(furiten)).toEqual(furiten);
  });
});
