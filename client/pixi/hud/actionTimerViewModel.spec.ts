import { describe, expect, it } from "vitest";
import {
  actionTimerTickDecision,
  projectActionTimer,
  resolveActionTimerState,
  resolveTableHudState,
} from "./actionTimerViewModel";

describe("legacy HUD projection", () => {
  const action = {
    readyCheck: null,
    actionDeadline: 15_000,
    actionBufferMs: 20_000,
  };

  it("keeps the action deadline separate from connection diagnostics", () => {
    expect(
      resolveTableHudState(
        { ...action, conn: "open", drawsTaken: 7, lastSeq: 42 },
        false
      )
    ).toEqual({ diagnostics: "", deadline: 15_000, bufferMs: 20_000 });
    expect(
      resolveTableHudState(
        { ...action, conn: "open", drawsTaken: 73, lastSeq: 42 },
        true
      ).diagnostics
    ).toBe("conn: open   wall: 0   seq: 42");
  });

  it("suppresses a stale action timer during a ready check", () => {
    expect(
      resolveActionTimerState({
        ...action,
        readyCheck: { deadline: 20_000, acked: [false, true, true, true] },
      })
    ).toEqual({ deadline: null, bufferMs: null });
  });

  it("never introduces player clocks or diagnostics into replay", () => {
    expect(
      resolveTableHudState(
        { ...action, conn: "replay", drawsTaken: 7, lastSeq: 42 },
        true
      )
    ).toEqual({ diagnostics: "", deadline: null, bufferMs: null });
  });
});

describe("legacy countdown rounding and cues", () => {
  it("ceil-rounds the base and unchanged bank independently", () => {
    expect(projectActionTimer(15_000, 20_001, 14_999, null)).toEqual({
      text: "1 + 21",
      baseSeconds: 1,
      bufferSeconds: 21,
      displayedTotalSeconds: 22,
      style: "normal",
      play: false,
    });
  });

  it("burns the bank only after the base deadline", () => {
    expect(projectActionTimer(15_000, 20_000, 15_001, 21)).toEqual({
      text: "0 + 20",
      baseSeconds: 0,
      bufferSeconds: 20,
      displayedTotalSeconds: 20,
      style: "warn",
      play: false,
    });
  });

  it("uses danger styling at five displayed seconds but starts cues at four", () => {
    const five = projectActionTimer(15_000, 20_000, 30_000, 6);
    const four = projectActionTimer(15_000, 20_000, 31_000, 5);
    expect(five).toMatchObject({
      text: "0 + 5",
      style: "danger",
      play: false,
    });
    expect(four).toMatchObject({
      text: "0 + 4",
      style: "danger",
      play: true,
    });
    expect(projectActionTimer(15_000, 20_000, 31_001, 4).play).toBe(false);
  });

  it("retains the seconds suffix when the server supplied no bank", () => {
    expect(projectActionTimer(15_000, null, 11_001, null)).toMatchObject({
      text: "4s",
      displayedTotalSeconds: 4,
      style: "danger",
      play: true,
    });
  });

  it("clamps expired allocations to zero without an expiry cue", () => {
    expect(projectActionTimer(15_000, 20_000, 40_000, 1)).toMatchObject({
      text: "0 + 0",
      displayedTotalSeconds: 0,
      play: false,
    });
  });

  it("keys cues to the displayed total rather than base or bank separately", () => {
    expect(actionTimerTickDecision(4, 1, 3)).toEqual({
      displayedTotalSeconds: 4,
      play: false,
    });
    expect(actionTimerTickDecision(4, 0, 3)).toEqual({
      displayedTotalSeconds: 3,
      play: true,
    });
  });
});
