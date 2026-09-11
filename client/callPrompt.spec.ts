import { describe, expect, it, vi } from "vitest";
import type { LegalAction } from "~/game/protocol/messages";
import {
  createNoCallAutoPassController,
  filterNoCallActionButtons,
  findNoCallAutoPass,
  shouldPlayCallPrompt,
  shouldTriggerCallPrompt,
} from "./callPrompt";

describe("shouldPlayCallPrompt", () => {
  it("silences callable discards while No call is enabled", () => {
    const actions: LegalAction[] = [
      { id: "chi", type: "chi", tiles: ["2m", "3m"] },
      { id: "pass", type: "pass" },
    ];

    expect(shouldPlayCallPrompt(actions, true)).toBe(false);
    expect(shouldPlayCallPrompt(actions, false)).toBe(true);
  });

  it("preserves a win alert even when No call is enabled", () => {
    const actions: LegalAction[] = [
      { id: "pon", type: "pon", tiles: ["5p", "5p"] },
      { id: "ron", type: "ron" },
      { id: "pass", type: "pass" },
    ];

    expect(shouldPlayCallPrompt(actions, true)).toBe(true);
  });

  it("does not suppress a self-kan prompt", () => {
    const actions: LegalAction[] = [
      {
        id: "ankan",
        type: "kan",
        kanKind: "ankan",
        tiles: ["5p", "5p", "5p"],
      },
    ];

    expect(shouldPlayCallPrompt(actions, true)).toBe(true);
  });

  it("alerts when a win appears after a suppressed call-only state", () => {
    const calls: LegalAction[] = [
      { id: "pon", type: "pon", tiles: ["5p", "5p"] },
      { id: "pass", type: "pass" },
    ];
    const winningActions: LegalAction[] = [
      ...calls,
      { id: "ron", type: "ron" },
    ];

    expect(shouldTriggerCallPrompt(calls, winningActions, true)).toBe(true);
  });
});

describe("No-call action policy", () => {
  it("auto-passes and hides a passable call-only window", () => {
    const actions: LegalAction[] = [
      { id: "chi", type: "chi", tiles: ["2m", "3m"] },
      { id: "pon", type: "pon", tiles: ["5p", "5p"] },
      {
        id: "daiminkan",
        type: "kan",
        kanKind: "daiminkan",
        tiles: ["7s", "7s", "7s"],
      },
      { id: "pass", type: "pass" },
    ];

    expect(findNoCallAutoPass(actions, true)?.id).toBe("pass");
    expect(filterNoCallActionButtons(actions, true)).toEqual([]);
  });

  it("keeps ron and pass while hiding lower calls in a win window", () => {
    const actions: LegalAction[] = [
      { id: "pon", type: "pon", tiles: ["5p", "5p"] },
      { id: "ron", type: "ron" },
      { id: "pass", type: "pass" },
    ];

    expect(findNoCallAutoPass(actions, true)).toBeUndefined();
    expect(filterNoCallActionButtons(actions, true).map(({ id }) => id)).toEqual(
      ["ron", "pass"]
    );
  });

  it("preserves self-kan controls", () => {
    const actions: LegalAction[] = [
      {
        id: "ankan",
        type: "kan",
        kanKind: "ankan",
        tiles: ["5p", "5p", "5p"],
      },
    ];

    expect(filterNoCallActionButtons(actions, true)).toEqual(actions);
  });

  it("retries an auto-pass that the transport could not queue", () => {
    const send = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
    const onSent = vi.fn();
    const controller = createNoCallAutoPassController({
      isEnabled: () => true,
      send,
      onSent,
    });
    const state = {
      matchId: "match-1",
      lastSeq: 42,
      conn: "open" as const,
      legalActions: [
        { id: "pon", type: "pon" as const, tiles: ["5p", "5p"] },
        { id: "pass", type: "pass" as const },
      ],
    };

    expect(controller.evaluate(state)).toBe(false);
    expect(controller.evaluate(state)).toBe(true);
    expect(controller.evaluate(state)).toBe(false);
    expect(send).toHaveBeenCalledTimes(2);
    expect(onSent).toHaveBeenCalledOnce();
  });

  it("retries the current auto-pass after reconnecting", () => {
    const send = vi.fn().mockReturnValue(true);
    const controller = createNoCallAutoPassController({
      isEnabled: () => true,
      send,
    });
    const state = {
      matchId: "match-1",
      lastSeq: 42,
      conn: "open" as const,
      legalActions: [
        { id: "pon", type: "pon" as const, tiles: ["5p", "5p"] },
        { id: "pass", type: "pass" as const },
      ],
    };

    expect(controller.evaluate(state)).toBe(true);
    expect(
      controller.evaluate({ ...state, conn: "reconnecting" as const })
    ).toBe(false);
    expect(controller.evaluate(state)).toBe(true);
    expect(send).toHaveBeenCalledTimes(2);
  });
});