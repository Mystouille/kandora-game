import { allText, createTimerHost } from "../results/pixiTestHarness";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { playGameCountdownSound } from "../../sound";
import type { TimerHost } from "./hudTypes";
import { ActionTimer, type ActionTimerView } from "./actionTimer";

vi.mock("../../sound", () => ({
  playGameSound: vi.fn(),
  playGameCountdownSound: vi.fn(),
}));

describe("ActionTimer owner", () => {
  const view: ActionTimerView = {
    conn: "open",
    drawsTaken: 0,
    lastSeq: 1,
    readyCheck: null,
    actionDeadline: 15_000,
    actionBufferMs: 20_000,
  };

  const textFor = (host: TimerHost) => {
    const text = allText(host.stage)[0];
    if (!text) {
      throw new Error("Expected mounted action timer Text");
    }
    return text;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(11_000);
    vi.mocked(playGameCountdownSound).mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("mounts exactly one ticker callback and removes its Text and ticker on destruction", () => {
    const owner = new ActionTimer();
    const { host, callbacks } = createTimerHost();
    owner.mount(host, "standard");
    const text = textFor(host);
    expect(callbacks.size).toBe(1);
    expect(text.visible).toBe(false);
    expect(text.position).toMatchObject({ x: 994, y: 922 });
    owner.update(view, null);
    expect(text.text).toBe("4 + 20");
    expect(text.visible).toBe(true);
    owner.destroy();
    expect(callbacks.size).toBe(0);
    expect(text.destroyed).toBe(true);
    expect(host.stage.children).toHaveLength(0);
    owner.tick();
  });

  it("uses the mobile font and stroke with an inset from the transformed felt anchor", () => {
    const owner = new ActionTimer();
    const { host } = createTimerHost();
    owner.mount(host, "mobile");
    owner.update(view, { x: 850, y: 800 });
    const text = textFor(host);
    expect(text.position).toMatchObject({ x: 840, y: 790 });
    expect(text.style.fontSize).toBe(24);
    owner.destroy();
  });

  it("uses normal, warn, and danger styles at the legacy displayed thresholds", () => {
    const owner = new ActionTimer();
    const { host } = createTimerHost();
    owner.mount(host, "standard");
    owner.update(view, null);
    const text = textFor(host);
    expect(text.style.fill).toBe(0xffffff);
    vi.setSystemTime(16_000);
    owner.tick();
    expect(text.text).toBe("0 + 19");
    expect(text.style.fill).toBe(0xfacc15);
    vi.setSystemTime(30_000);
    owner.tick();
    expect(text.text).toBe("0 + 5");
    expect(text.style.fill).toBe(0xef4444);
    expect(text.style.fontWeight).toBe("800");
    expect(playGameCountdownSound).not.toHaveBeenCalled();
    owner.destroy();
  });

  it("commits each 4-3-2-1 displayed second before requesting its once-per-second cue", () => {
    const owner = new ActionTimer();
    const { host } = createTimerHost();
    owner.mount(host, "standard");
    owner.update(view, null);
    const text = textFor(host);
    vi.mocked(playGameCountdownSound).mockImplementation(
      (_cue, _key, seconds) => {
        expect(text.text).toBe(`0 + ${seconds}`);
        expect(text.visible).toBe(true);
      }
    );
    for (let seconds = 4; seconds >= 0; seconds--) {
      vi.setSystemTime(35_000 - seconds * 1_000);
      owner.tick();
      owner.tick();
    }
    expect(playGameCountdownSound).toHaveBeenCalledTimes(4);
    expect(
      vi.mocked(playGameCountdownSound).mock.calls.map((call) => call.slice(1))
    ).toEqual([
      ["action:15000", 4],
      ["action:15000", 3],
      ["action:15000", 2],
      ["action:15000", 1],
    ]);
    owner.destroy();
  });

  it("hides stale ready-check and replay deadlines and resets cue history on a hidden clock", () => {
    const owner = new ActionTimer();
    const { host } = createTimerHost();
    owner.mount(host, "standard");
    const noBank = { ...view, actionBufferMs: null };
    owner.update(noBank, null);
    expect(textFor(host).text).toBe("4s");
    owner.update(
      {
        ...noBank,
        readyCheck: { deadline: 30_000, acked: [false, false, false, false] },
      },
      null
    );
    expect(textFor(host).visible).toBe(false);
    owner.update(noBank, null);
    expect(playGameCountdownSound).toHaveBeenCalledTimes(2);
    owner.update({ ...noBank, conn: "replay" }, null);
    expect(textFor(host).visible).toBe(false);
    owner.destroy();
  });

  it("retains Date.now wall-clock behavior rather than activating a synchronized-clock policy", () => {
    const owner = new ActionTimer();
    const { host } = createTimerHost();
    owner.mount(host, "standard");
    owner.update(view, null);
    vi.setSystemTime(10_000);
    owner.tick();
    expect(textFor(host).text).toBe("5 + 20");
    owner.destroy();
  });

  it("accepts the diagnostic seam without making that flag a timer visibility policy", () => {
    const owner = new ActionTimer();
    const { host } = createTimerHost();
    owner.mount(host, "standard");
    owner.render(view, false, { x: 850, y: 800 });
    expect(textFor(host).text).toBe("4 + 20");
    expect(textFor(host).visible).toBe(true);
    expect(textFor(host).position).toMatchObject({ x: 844, y: 796 });
    owner.destroy();
  });
});
