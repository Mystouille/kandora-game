import { describe, expect, it, vi } from "vitest";
import type { LegalAction } from "~/game/protocol/messages";
import {
  createCallPromptSoundSequencer,
  createNoCallAutoPassController,
  filterNoCallActionButtons,
  findNoCallAutoPass,
  shouldPlayCallPrompt,
  shouldDeferCallPromptControls,
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

describe("call-prompt sound sequencing", () => {
  const ronActions: LegalAction[] = [
    { id: "ron", type: "ron" },
    { id: "pass", type: "pass" },
  ];
  const tsumoActions: LegalAction[] = [{ id: "tsumo", type: "tsumo" }];

  it("plays immediately when no tile presentation is pending", () => {
    const sequencer = createCallPromptSoundSequencer();

    expect(sequencer.updateActions([], ronActions, false)).toBe("play");
  });

  it("defers a discard call until that discard lands", () => {
    const sequencer = createCallPromptSoundSequencer();

    sequencer.notePresentation("discard", 41, true);

    expect(sequencer.updateActions([], ronActions, false)).toBe("defer");
    expect(sequencer.presentationLanded("draw", 41)).toBe(false);
    expect(sequencer.presentationLanded("discard", 40)).toBe(false);
    expect(sequencer.presentationLanded("discard", 41)).toBe(true);
    expect(sequencer.presentationLanded("discard", 41)).toBe(false);
  });

  it("keeps a discard pending across the event frame's empty actions", () => {
    const sequencer = createCallPromptSoundSequencer();

    sequencer.notePresentation("discard", 41, true);

    expect(sequencer.updateActions([], [], false)).toBe("none");
    expect(sequencer.updateActions([], ronActions, false)).toBe("defer");
    expect(sequencer.presentationLanded("discard", 41)).toBe(true);
  });

  it("defers a winning draw prompt until the drawn tile lands", () => {
    const sequencer = createCallPromptSoundSequencer();

    sequencer.notePresentation("draw", 42, true);

    expect(sequencer.updateActions([], tsumoActions, false)).toBe("defer");
    expect(sequencer.presentationLanded("draw", 42)).toBe(true);
  });

  it("cancels a deferred prompt when its action window closes", () => {
    const sequencer = createCallPromptSoundSequencer();

    sequencer.notePresentation("discard", 41, true);
    expect(sequencer.updateActions([], ronActions, false)).toBe("defer");
    expect(sequencer.updateActions(ronActions, [], false)).toBe("none");

    expect(sequencer.presentationLanded("discard", 41)).toBe(false);
  });

  it("does not release a newer prompt on an older discard landing", () => {
    const sequencer = createCallPromptSoundSequencer();

    sequencer.notePresentation("discard", 41, true);
    expect(sequencer.updateActions([], ronActions, false)).toBe("defer");
    expect(sequencer.updateActions(ronActions, [], false)).toBe("none");

    sequencer.notePresentation("discard", 44, true);
    expect(sequencer.updateActions([], ronActions, false)).toBe("defer");

    expect(sequencer.presentationLanded("discard", 41)).toBe(false);
    expect(sequencer.presentationLanded("discard", 44)).toBe(true);
  });

  it("does not carry a non-prompt draw into a later action window", () => {
    const sequencer = createCallPromptSoundSequencer();
    const discardActions: LegalAction[] = [
      { id: "discard", type: "discard", tile: "1m" },
    ];

    sequencer.notePresentation("draw", 42, true);
    expect(sequencer.updateActions([], discardActions, false)).toBe("none");
    expect(sequencer.presentationLanded("draw", 42)).toBe(false);

    expect(sequencer.updateActions([], ronActions, false)).toBe("play");
  });
});

describe("call-prompt control sequencing", () => {
  it("defers reactive controls while the triggering discard is moving", () => {
    const actions: LegalAction[] = [
      { id: "ron", type: "ron" },
      { id: "pass", type: "pass" },
    ];

    expect(shouldDeferCallPromptControls(actions, true)).toBe(true);
    expect(shouldDeferCallPromptControls(actions, false)).toBe(false);
  });

  it("does not defer a pass without a callable action", () => {
    expect(
      shouldDeferCallPromptControls([{ id: "pass", type: "pass" }], true)
    ).toBe(false);
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
    expect(
      filterNoCallActionButtons(actions, true).map(({ id }) => id)
    ).toEqual(["ron", "pass"]);
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
