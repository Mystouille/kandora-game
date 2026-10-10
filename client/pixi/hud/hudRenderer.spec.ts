import {
  allText,
  createFrame,
  createResources,
  createTimerHost,
  logoLoad,
} from "../results/pixiTestHarness";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EventBoundary,
  FederatedPointerEvent,
  Graphics,
  Texture,
} from "pixi.js";
import type { RenderFrame } from "../scene/renderTypes";
import { UI_FONT_FAMILY } from "../geometry/renderConstants";
import { HudRenderer } from "./hudRenderer";
import { DEFAULT_CENTER_LABELS } from "./hudTypes";

vi.mock("../../sound", () => ({
  playGameSound: vi.fn(),
  playGameCountdownSound: vi.fn(),
}));

const request = vi.fn();
const owners: HudRenderer[] = [];
const createOwner = () => {
  const owner = new HudRenderer(request);
  owners.push(owner);
  return owner;
};

function deferredTexture() {
  let resolve!: (texture: Texture) => void;
  const promise = new Promise<Texture>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function centerClick(frame: RenderFrame, button = 0): void {
  const area = frame.root.children[0];
  if (!(area instanceof Graphics)) {
    throw new Error("Expected center score toggle");
  }
  const pointer = new FederatedPointerEvent(new EventBoundary(frame.root));
  pointer.button = button;
  area.emit("pointerdown", pointer);
}

const render = (
  owner: HudRenderer,
  frame: RenderFrame,
  indicatorCenter = false
): void => {
  owner.render(
    frame,
    createResources(),
    frame.layout.discards,
    indicatorCenter
  );
};

afterEach(() => {
  for (const owner of owners.splice(0)) {
    owner.destroy();
  }
  request.mockClear();
  logoLoad.mockReset();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("HudRenderer ownership", () => {
  it("keeps label and ordinary overlay setters silent but always requests enrichment changes", () => {
    const owner = createOwner();
    owner.setShowNames(false);
    owner.setShowWaits(true);
    owner.setShowLayoutDebug(true);
    owner.setShowWallZonesDebug(true);
    owner.setConnectionDiagnosticsVisible(false);
    owner.setCenterLabels(DEFAULT_CENTER_LABELS);
    expect(request).not.toHaveBeenCalled();
    owner.setSeatEnrichment([]);
    owner.setSeatEnrichment([]);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("returns only focused-seat waits and uses them only while that overlay is enabled", () => {
    const owner = createOwner();
    const view = {
      mySeat: 1 as const,
      currentWaits: [["1m"], ["2p", "3p"], [], []],
    };
    expect([...owner.waitTiles(view)]).toEqual([]);
    owner.setShowWaits(true);
    expect([...owner.waitTiles(view)]).toEqual(["2p", "3p"]);
    expect([...owner.waitTiles({ ...view, mySeat: null })]).toEqual([]);
  });

  it("toggles relative scores for exactly four seconds without changing the focused score", () => {
    vi.useFakeTimers();
    const owner = createOwner();
    const makeFrame = () =>
      createFrame({ scores: [25_000, 27_000, 24_000, 24_000] });
    const frame = makeFrame();
    render(owner, frame);
    centerClick(frame, 2);
    expect(request).not.toHaveBeenCalled();
    centerClick(frame);
    const relative = makeFrame();
    render(owner, relative);
    const texts = allText(relative.root).map((text) => text.text);
    expect(texts).toContain("25000");
    expect(texts).toContain("+2000");
    expect(texts.filter((text) => text === "-1000")).toHaveLength(2);
    expect(request).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(3_999);
    expect(request).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(request).toHaveBeenCalledTimes(2);
    const absolute = makeFrame();
    render(owner, absolute);
    expect(allText(absolute.root).map((text) => text.text)).toContain("27000");
  });

  it("clears the relative-score timeout when toggled off or destroyed", () => {
    vi.useFakeTimers();
    const owner = createOwner();
    const frame = createFrame();
    render(owner, frame);
    centerClick(frame);
    centerClick(frame);
    vi.advanceTimersByTime(4_000);
    expect(request).toHaveBeenCalledTimes(2);
    centerClick(frame);
    owner.destroy();
    vi.advanceTimersByTime(4_000);
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("keeps connection diagnostics independent of action clocks and suppresses replay diagnostics", () => {
    const owner = createOwner();
    const { host } = createTimerHost();
    owner.mount(host, "standard");
    const frame = createFrame({ conn: "open", lastSeq: 42, drawsTaken: 7 });
    owner.updateLiveHud(frame.view, null);
    expect(allText(host.stage)[0]?.text).toBe(
      "conn: open   wall: 63   seq: 42"
    );
    owner.setConnectionDiagnosticsVisible(false);
    owner.updateLiveHud(frame.view, null);
    expect(allText(host.stage)[0]?.text).toBe("");
    owner.setConnectionDiagnosticsVisible(true);
    owner.updateLiveHud({ ...frame.view, conn: "replay" }, null);
    expect(allText(host.stage)[0]?.text).toBe("");
  });

  it("retains translated round labels and omits the repeat counter in Buu mode", () => {
    const owner = createOwner();
    owner.setCenterLabels({
      repeat: "Repeat translated",
      riichi: "Sticks translated",
      tiles: "Tiles translated",
      remainingDraws: "Remaining translated",
    });
    const frame = createFrame({ buuMode: true });
    render(owner, frame);
    const texts = allText(frame.root).map((text) => text.text);
    expect(texts).not.toContain("Repeat translated");
    expect(texts).toContain("Sticks translated");
    expect(texts).toContain("Tiles translated");
  });

  it("renders the mobile center panel, five indicator slots, heading and counters", () => {
    const owner = createOwner();
    const frame = createFrame({ doraIndicators: ["1m", "2p"] }, "mobile");
    const resources = createResources();
    owner.renderMobileCenterPanel(frame);
    owner.render(frame, resources, frame.layout.discards, true);
    expect(frame.root.children[0].zIndex).toBe(-8);
    expect(resources.spriteFactory.create).toHaveBeenCalledTimes(5);
    expect(
      vi
        .mocked(resources.spriteFactory.create)
        .mock.calls.map(([spec]) => spec.tile)
    ).toEqual(["1m", "2p", null, null, null]);
    expect(allText(frame.root).map((text) => text.text)).toContain("東1局");
  });

  it("omits compact MCR dora slots while retaining them on mobile", () => {
    const owner = createOwner();
    const view = {
      rulesFamily: "mcr" as const,
      doraIndicators: ["1m", "2p"],
    };
    const compact = createFrame(view);
    const compactResources = createResources();
    owner.render(
      compact,
      compactResources,
      compact.layout.discards,
      true
    );
    expect(compactResources.spriteFactory.create).not.toHaveBeenCalled();

    const mobile = createFrame(view, "mobile");
    const mobileResources = createResources();
    owner.render(mobile, mobileResources, mobile.layout.discards, true);
    expect(mobileResources.spriteFactory.create).toHaveBeenCalledTimes(5);
  });

  it("uses the UI font for MCR round headings in both center layouts", () => {
    const owner = createOwner();
    const view = {
      rulesFamily: "mcr" as const,
      roundWind: "S" as const,
      roundNumber: 2,
    };
    const standard = createFrame(view);
    render(owner, standard);
    const standardHeading = allText(standard.root).find(
      (text) => text.text === "S - 2"
    );
    expect(standardHeading?.style.fontFamily).toBe(UI_FONT_FAMILY);

    const compact = createFrame(view);
    render(owner, compact, true);
    const compactHeading = allText(compact.root).find(
      (text) => text.text === "S 2"
    );
    expect(compactHeading?.style.fontFamily).toBe(UI_FONT_FAMILY);
  });

  it("owns both layout and wall-zone debug overlays without requesting renders on setters", () => {
    const owner = createOwner();
    const hidden = createFrame();
    owner.renderDebug(hidden);
    expect(hidden.root.children).toHaveLength(0);
    owner.setShowLayoutDebug(true);
    owner.setShowWallZonesDebug(true);
    const frame = createFrame();
    owner.renderDebug(frame);
    expect(frame.root.children).toHaveLength(21);
    expect(
      frame.root.children.filter((child) => child.zIndex === 900)
    ).toHaveLength(4);
    expect(request).not.toHaveBeenCalled();
  });

  it("retains name visibility, chip/dabuken fallbacks and focused wait labels", () => {
    const owner = createOwner();
    owner.setShowWaits(true);
    const makeFrame = () =>
      createFrame({
        mySeat: 0,
        seatNames: ["Alpha", "Beta", "Gamma", "Delta"],
        buuMode: true,
        chips: [3, 2, 1, 0],
        dabuken: [true, false, false, false],
        lastHandResult: {
          reason: "exhaustive_draw",
          waits: [["1m", "2m"], ["3p"], null, null],
        },
      });
    const frame = makeFrame();
    render(owner, frame);
    const texts = allText(frame.root).map((text) => text.text);
    expect(texts).toContain("Alpha");
    expect(texts).toContain("x2");
    expect(texts).toContain("待: 1m 2m");
    expect(texts).not.toContain("待: 3p");
    owner.setShowNames(false);
    const hidden = makeFrame();
    render(owner, hidden);
    expect(allText(hidden.root).map((text) => text.text)).not.toContain(
      "Alpha"
    );
  });

  it("deduplicates lazy logo loads across seats and frames and requests exactly one completion render", async () => {
    const owner = createOwner();
    const pending = deferredTexture();
    const load = logoLoad.mockReturnValue(pending.promise);
    owner.setSeatEnrichment([
      { teamName: "Team A", teamLogoUrl: "test-logo.png" },
      { teamLogoUrl: "test-logo.png" },
    ]);
    const makeFrame = () =>
      createFrame({ seatNames: ["Alpha", "Beta", "", ""] });
    render(owner, makeFrame());
    render(owner, makeFrame());
    expect(load).toHaveBeenCalledTimes(1);
    pending.resolve(Texture.EMPTY);
    await pending.promise;
    await Promise.resolve();
    expect(request).toHaveBeenCalledTimes(2);
    const cached = makeFrame();
    render(owner, cached);
    expect(load).toHaveBeenCalledTimes(1);
    expect(allText(cached.root).map((text) => text.text)).toContain("Team A");
  });

  it("does not resurrect a destroyed name owner when a pending logo resolves", async () => {
    const owner = createOwner();
    const pending = deferredTexture();
    logoLoad.mockReturnValue(pending.promise);
    owner.setSeatEnrichment([{ teamLogoUrl: "test-logo.png" }]);
    render(owner, createFrame({ seatNames: ["Alpha", "", "", ""] }));
    owner.destroy();
    pending.resolve(Texture.EMPTY);
    await pending.promise;
    await Promise.resolve();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("retries a failed logo load on a later frame without poisoning the cache", async () => {
    const owner = createOwner();
    logoLoad.mockRejectedValueOnce(new Error("Unavailable test logo"));
    logoLoad.mockResolvedValue(Texture.EMPTY);
    owner.setSeatEnrichment([{ teamLogoUrl: "test-logo.png" }]);
    const makeFrame = () => createFrame({ seatNames: ["Alpha", "", "", ""] });
    render(owner, makeFrame());
    await Promise.resolve();
    await Promise.resolve();
    render(owner, makeFrame());
    await Promise.resolve();
    render(owner, makeFrame());
    expect(logoLoad).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenCalledTimes(2);
  });
});
