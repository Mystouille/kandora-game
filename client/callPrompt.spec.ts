import { describe, expect, it } from "vitest";
import type { LegalAction } from "~/game/protocol/messages";
import { shouldPlayCallPrompt, shouldTriggerCallPrompt } from "./callPrompt";

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