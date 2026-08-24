import { describe, expect, it } from "vitest";
import type { LegalAction } from "~/game/protocol/messages";
import {
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
});