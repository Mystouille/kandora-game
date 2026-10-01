import {
  createFrame,
  createMeldDrawer,
  createResources,
  allText,
} from "./pixiTestHarness";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  Container,
  EventBoundary,
  FederatedPointerEvent,
  Graphics,
} from "pixi.js";
import { playGameSound } from "../../sound";
import type { HandResult, RenderFrame } from "../scene/renderTypes";
import { ResultPresenter } from "./resultPresenter";
import { DEFAULT_RESULT_LABELS } from "./resultTypes";

vi.mock("../../sound", () => ({
  playGameSound: vi.fn(),
  playGameCountdownSound: vi.fn(),
}));

describe("ResultPresenter ownership", () => {
  let now = 1_000;
  const result: HandResult = {
    reason: "ron",
    dealer: 0,
    delta: [1_000, -1_000, 0, 0],
    wins: [
      {
        seat: 0,
        yaku: { Riichi: "1飜", Dora: "1飜" },
        han: 2,
        fu: 30,
        ten: 2_000,
        doraIndicators: ["1m"],
      },
    ],
  };
  const resources = createResources();
  const melds = createMeldDrawer();

  beforeEach(() => {
    now = 1_000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    vi.mocked(playGameSound).mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const render = (
    owner: ResultPresenter,
    frame: RenderFrame
  ): ReturnType<ResultPresenter["render"]> =>
    owner.render(frame, resources, melds);

  it("keeps ordinary setters silent and requests only changed staged-reveal settings", () => {
    const request = vi.fn();
    const owner = new ResultPresenter(request);
    owner.setShowHandResult(false);
    owner.setHandResultOverride(result);
    owner.setResultLabels(DEFAULT_RESULT_LABELS);
    owner.setResultPanelBoundsListener(vi.fn());
    owner.setStagedRevealEnabled(true);
    expect(request).not.toHaveBeenCalled();
    owner.setStagedRevealEnabled(false);
    owner.setStagedRevealEnabled(false);
    expect(request).toHaveBeenCalledTimes(1);
    expect(owner.handResultOverride).toBe(result);
  });

  it("waits for final hand-end deltas without losing press-hide eligibility", () => {
    const owner = new ResultPresenter(vi.fn());
    const transient = { ...result, delta: undefined };
    const frame = createFrame({ lastHandResult: transient });
    expect(render(owner, frame)).toBeNull();
    expect(frame.root.children).toHaveLength(0);
    expect(owner.winInfoPressEnabled).toBe(true);
    expect(owner.lastResultPanelBounds).toBeNull();
  });

  it("publishes transformed inner bounds only on changes, including hidden and restored frames", () => {
    const request = vi.fn();
    const owner = new ResultPresenter(request);
    const listener = vi.fn();
    owner.setResultPanelBoundsListener(listener);
    const frame = createFrame({
      lastHandResult: { reason: "exhaustive_draw" },
    });
    frame.root.scale.set(2, 3);
    frame.root.position.set(13, 17);
    const inner = render(owner, frame);
    if (inner === null) {
      throw new Error("Expected visible result bounds");
    }
    expect(listener).toHaveBeenLastCalledWith({
      x: inner.x * 2 + 13,
      y: inner.y * 3 + 17,
      w: inner.w * 2,
      h: inner.h * 3,
    });
    render(owner, frame);
    expect(listener).toHaveBeenCalledTimes(1);
    owner.hideHandResult();
    expect(owner.handResultPressHidden).toBe(true);
    expect(render(owner, frame)).toBeNull();
    expect(listener).toHaveBeenLastCalledWith(null);
    owner.restoreHandResult();
    owner.restoreHandResult();
    render(owner, frame);
    expect(listener).toHaveBeenCalledTimes(3);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("preserves reveal identity across equivalent snapshots and fires each yaku sound once", () => {
    const owner = new ResultPresenter(vi.fn());
    render(owner, createFrame({ lastHandResult: result }));
    now = 1_750;
    render(owner, createFrame({ lastHandResult: { ...result } }));
    expect(playGameSound).toHaveBeenCalledTimes(1);
    render(owner, createFrame({ lastHandResult: { ...result } }));
    expect(playGameSound).toHaveBeenCalledTimes(1);
    now = 2_500;
    render(owner, createFrame({ lastHandResult: result }));
    expect(playGameSound).toHaveBeenCalledTimes(2);
  });

  it("restarts reveal on a new result key or after the hand has cleared", () => {
    const owner = new ResultPresenter(vi.fn());
    render(owner, createFrame({ lastHandResult: result }));
    now = 1_750;
    render(owner, createFrame({ lastHandResult: result }));
    render(owner, createFrame({ lastHandResult: result, honba: 1 }));
    now = 2_500;
    render(owner, createFrame({ lastHandResult: result, honba: 1 }));
    expect(playGameSound).toHaveBeenCalledTimes(2);
    render(owner, createFrame());
    render(owner, createFrame({ lastHandResult: result }));
    now = 3_250;
    render(owner, createFrame({ lastHandResult: result }));
    expect(playGameSound).toHaveBeenCalledTimes(3);
  });

  it("renders historical overrides fully and silently without driving a reveal pump", () => {
    const request = vi.fn();
    const owner = new ResultPresenter(request);
    owner.setHandResultOverride(result);
    const frame = createFrame();
    render(owner, frame);
    expect(
      allText(frame.root).filter((text) => text.text === "Riichi")
    ).toMatchObject([{ visible: true }]);
    expect(request).not.toHaveBeenCalled();
    expect(playGameSound).not.toHaveBeenCalled();
  });

  it("preserves elapsed reveal time while press-hidden instead of restarting the page", () => {
    const owner = new ResultPresenter(vi.fn());
    render(owner, createFrame({ lastHandResult: result }));
    owner.hideHandResult();
    now = 3_000;
    render(owner, createFrame({ lastHandResult: result }));
    expect(playGameSound).not.toHaveBeenCalled();
    owner.restoreHandResult();
    render(owner, createFrame({ lastHandResult: result }));
    expect(playGameSound).toHaveBeenCalledTimes(2);
  });

  it("paginates through the shared panel callback and replays reveal for each page", () => {
    const request = vi.fn();
    const owner = new ResultPresenter(request);
    const multi: HandResult = {
      ...result,
      wins: [...(result.wins ?? []), { seat: 2, yaku: { Pinfu: "1飜" } }],
    };
    const frame = createFrame({ lastHandResult: multi });
    render(owner, frame);
    const overlay = frame.root.children[0];
    if (!(overlay instanceof Container)) {
      throw new Error("Expected result overlay");
    }
    const panel = overlay.children[1];
    if (!(panel instanceof Container)) {
      throw new Error("Expected result center panel");
    }
    const background = panel.children[0];
    if (!(background instanceof Graphics)) {
      throw new Error("Expected clickable panel background");
    }
    const pointer = new FederatedPointerEvent(new EventBoundary(frame.root));
    pointer.button = 2;
    background.emit("pointerdown", pointer);
    expect(request).toHaveBeenCalledTimes(1);
    pointer.button = 0;
    background.emit("pointerdown", pointer);
    expect(request).toHaveBeenCalledTimes(2);
    const nextFrame = createFrame({ lastHandResult: multi });
    render(owner, nextFrame);
    expect(allText(nextFrame.root).some((text) => text.text === "2 / 2")).toBe(
      true
    );
    expect(allText(nextFrame.root).some((text) => text.text === "Pinfu")).toBe(
      true
    );
    now = 1_750;
    render(owner, createFrame({ lastHandResult: multi }));
    expect(playGameSound).toHaveBeenCalledTimes(1);
  });

  it("does not double up positive-ura indicator and yaku sounds", () => {
    const owner = new ResultPresenter(vi.fn());
    const ura: HandResult = {
      ...result,
      wins: [
        {
          seat: 0,
          yaku: { Riichi: "1飜" },
          uraDoraCount: 1,
          uraDoraIndicators: ["2p"],
        },
      ],
    };
    render(owner, createFrame({ lastHandResult: ura }));
    now = 1_750;
    render(owner, createFrame({ lastHandResult: ura }));
    now = 3_750;
    render(owner, createFrame({ lastHandResult: ura }));
    expect(playGameSound).toHaveBeenCalledTimes(2);
    render(owner, createFrame({ lastHandResult: ura }));
    expect(playGameSound).toHaveBeenCalledTimes(2);
  });

  it("plays the zero-ura indicator flip once without revealing the reserved zero-yaku text", () => {
    const owner = new ResultPresenter(vi.fn());
    const ura: HandResult = {
      ...result,
      wins: [
        {
          seat: 0,
          yaku: { Riichi: "1飜" },
          uraDoraCount: 0,
          uraDoraIndicators: ["2p"],
        },
      ],
    };
    render(owner, createFrame({ lastHandResult: ura }));
    now = 3_750;
    const frame = createFrame({ lastHandResult: ura });
    render(owner, frame);
    expect(playGameSound).toHaveBeenCalledTimes(2);
    expect(
      allText(frame.root).find((text) => text.text === "Ura Dora")?.visible
    ).toBe(false);
  });

  it("plays match-end sound only for the first visible standings and excludes press hiding", () => {
    const owner = new ResultPresenter(vi.fn());
    const frame = createFrame({
      matchEnded: {
        reason: "round_limit",
        finalScores: [
          { seat: 0, score: 30_000, place: 1 },
          { seat: 1, score: 26_000, place: 2 },
          { seat: 2, score: 24_000, place: 3 },
          { seat: 3, score: 20_000, place: 4 },
        ],
      },
      lastHandResult: result,
    });
    owner.setShowHandResult(false);
    render(owner, frame);
    expect(playGameSound).not.toHaveBeenCalled();
    owner.setShowHandResult(true);
    render(owner, frame);
    render(owner, frame);
    expect(playGameSound).toHaveBeenCalledTimes(1);
    expect(owner.winInfoPressEnabled).toBe(false);
    render(owner, createFrame());
    render(owner, frame);
    expect(playGameSound).toHaveBeenCalledTimes(2);
  });

  it("reuses the supplied meld drawer and retains the result-time dealer label", () => {
    const owner = new ResultPresenter(vi.fn());
    const drawer = createMeldDrawer();
    const winning: HandResult = {
      ...result,
      dealer: 2,
      wins: [
        {
          seat: 2,
          hand: ["3m", "1m", "2m", "4m"],
          winTile: "4m",
          melds: [
            {
              type: "pon",
              tiles: ["1p", "1p", "1p"],
              claimedTile: "1p",
              from: 3,
            },
          ],
        },
      ],
    };
    const frame = createFrame({ lastHandResult: winning });
    owner.render(frame, resources, drawer);
    expect(drawer.drawMeld).toHaveBeenCalledWith(
      { type: "pon", tiles: ["1p", "1p", "1p"], claimedTile: "1p", from: 1 },
      0
    );
    const texts = allText(frame.root).map((text) => text.text);
    expect(texts).toContain("(dealer)");
    expect(texts).toContain("24000");
  });

  it("retains place ordering and signed Buu chip deltas with the Unicode minus sign", () => {
    const owner = new ResultPresenter(vi.fn());
    const frame = createFrame({
      buuMode: true,
      matchEnded: {
        reason: "round_limit",
        finalScores: [
          { seat: 2, score: 24_000, place: 3 },
          { seat: 1, score: 30_000, place: 1 },
          { seat: 0, score: 26_000, place: 2 },
          { seat: 3, score: 20_000, place: 4 },
        ],
        chipsDelta: [-3, 2, 1, 0],
      },
    });
    render(owner, frame);
    const texts = allText(frame.root).map((text) => text.text);
    expect(texts.slice(1, 4)).toEqual(["1.", "Seat 1", "30000"]);
    expect(texts).toContain("−3");
    expect(texts).toContain("+2");
    expect(texts).not.toContain("-3");
  });
});
