import {
  allText,
  createFrame,
  createResources,
  flushAnimationFrame,
  installSceneEnvironment,
  logoLoad,
  sceneMocks,
} from "../results/pixiTestHarness";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  Container,
  EventBoundary,
  FederatedPointerEvent,
  Graphics,
  Point,
  Sprite,
  Texture,
  TextureSource,
} from "pixi.js";
import { useMatchStore, type MatchView } from "../../store";
import { TableRenderer } from "../TableRenderer";
import { DiscardAnimator } from "../discardAnimator";
import { mobileTableLayout } from "../layouts/mobileTableLayout";
import { currentTableLayout } from "../layouts/currentTableLayout";
import { resolveFelt, tableLayoutFromConfig } from "../tableLayout";
import { SceneGraph } from "./sceneGraph";
import { SceneAnchors } from "./sceneAnchors";

beforeEach(() => {
  installSceneEnvironment();
  logoLoad.mockResolvedValue(
    new Texture({ source: new TextureSource({ width: 4096, height: 4096 }) })
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function root(): Container {
  const child = sceneMocks.stages[sceneMocks.stages.length - 1]?.children[0];
  if (!(child instanceof Container)) {
    throw new Error("Expected mounted table root");
  }
  return child;
}

function click(node: Container, x = 0, y = 0): void {
  const event = new FederatedPointerEvent(new EventBoundary(node));
  event.button = 0;
  event.global.set(x, y);
  node.emit("pointerdown", event);
}

describe("scene lifecycle and viewport owner", () => {
  it("fits the design, disposes every old display child and retains shared textures", async () => {
    const owner = new SceneGraph();
    const app = await owner.mount(new HTMLElement(), currentTableLayout);
    const table = owner.createRoot();
    const resources = createResources();
    const old = new Sprite(Texture.EMPTY);
    table.addChild(old);
    app.screen.width = 2_000;
    app.screen.height = 2_000;
    const layout = tableLayoutFromConfig(currentTableLayout);
    const fitted = owner.beginFrame(
      layout,
      resolveFelt(currentTableLayout),
      resources
    );
    expect(fitted).toBe(table);
    expect(app.resize).toHaveBeenCalledTimes(1);
    const scale = Math.min(2_000 / layout.table.w, 2_000 / layout.table.h);
    expect(table.scale).toMatchObject({ x: scale, y: scale });
    expect(table.position).toMatchObject({
      x: (2_000 - layout.table.w * scale) / 2,
      y: (2_000 - layout.table.h * scale) / 2,
    });
    expect(old.destroyed).toBe(true);
    expect(Texture.EMPTY.destroyed).toBe(false);
    owner.destroy();
    expect(app.destroy).toHaveBeenCalledWith(true, { children: true });
    expect(owner.root).toBeNull();
    expect(owner.app).toBeNull();
  });

  it("coalesces ticker/resize/internal requests and cancels them on destruction", async () => {
    const owner = new SceneGraph();
    const app = await owner.mount(new HTMLElement(), currentTableLayout);
    owner.createRoot();
    const request = vi.fn();
    owner.setOnRenderRequest(request);
    let active = false;
    owner.startAnimationPump(() => active);
    owner.observe(new HTMLElement());
    for (const tick of sceneMocks.tickers[0]) {
      tick();
    }
    expect(sceneMocks.raf.size).toBe(0);
    active = true;
    for (const tick of sceneMocks.tickers[0]) {
      tick();
      tick();
    }
    owner.requestRender();
    expect(sceneMocks.raf.size).toBe(1);
    flushAnimationFrame();
    expect(request).toHaveBeenCalledTimes(1);
    sceneMocks.resizeCallbacks[0]();
    sceneMocks.resizeCallbacks[0]();
    expect(sceneMocks.raf.size).toBe(1);
    flushAnimationFrame();
    expect(app.resize).toHaveBeenCalledTimes(1);
    flushAnimationFrame();
    expect(request).toHaveBeenCalledTimes(2);
    owner.requestRender();
    sceneMocks.resizeCallbacks[0]();
    owner.destroy();
    expect(sceneMocks.raf.size).toBe(0);
    expect(sceneMocks.tickers[0].size).toBe(0);
    expect(sceneMocks.disconnect).toHaveBeenCalledTimes(1);
  });

  it("publishes transformed pond/hand anchors only when the viewport changes", () => {
    const owner = new SceneAnchors();
    const pond = vi.fn();
    const hand = vi.fn();
    owner.setPondCenterListener(pond);
    owner.setBottomHandBoundsListener(hand);
    const frame = createFrame({ mySeat: 0 });
    frame.root.scale.set(2);
    frame.root.position.set(12, 20);
    owner.publish(frame);
    owner.publish(frame);
    const bounds = frame.layout.discards[0];
    expect(pond).toHaveBeenCalledWith({
      x: (bounds.x + bounds.w / 2) * 2 + 12,
      y: (bounds.y + bounds.h / 2) * 2 + 20,
    });
    expect(pond).toHaveBeenCalledTimes(1);
    expect(hand).toHaveBeenCalledTimes(1);
    frame.root.position.x++;
    owner.publish(frame);
    expect(pond).toHaveBeenCalledTimes(2);
    expect(hand).toHaveBeenCalledTimes(2);
    owner.setPondCenterListener(null);
    owner.setBottomHandBoundsListener(null);
    frame.root.position.x++;
    owner.publish(frame);
    expect(pond).toHaveBeenCalledTimes(2);
  });
});

describe("public renderer composition", () => {
  it("preserves pre-mount options, helper-facing overlays, host anchors and complete disposal", async () => {
    const renderer = new TableRenderer({
      presentation: "mobile",
      layoutConfig: mobileTableLayout,
    });
    const bounds = vi.fn();
    const requests = vi.fn();
    renderer.setOnRenderRequest(requests);
    renderer.setBottomHandBoundsListener(bounds);
    renderer.setShowHands(true);
    renderer.setShowNames(false);
    renderer.setConnectionDiagnosticsVisible(false);
    renderer.setAnimationsEnabled(false);
    renderer.render(useMatchStore.getInitialState());
    expect(bounds).not.toHaveBeenCalled();
    await renderer.mount(new HTMLElement());
    renderer.render({
      ...useMatchStore.getInitialState(),
      conn: "replay",
      mySeat: 0,
      hands: [["2m", "1m", "3m"], ["4p", "5p", "6p"], [], []],
    });
    expect(bounds).toHaveBeenCalledTimes(1);
    expect(
      allText(sceneMocks.stages[0]).every(
        (text) => !text.text.startsWith("conn:")
      )
    ).toBe(true);
    renderer.setMobileActionButtonRightBoundary(1_100);
    expect(sceneMocks.raf.size).toBe(1);
    renderer.destroy();
    expect(sceneMocks.raf.size).toBe(0);
    expect(sceneMocks.tickers[0].size).toBe(0);
    expect(sceneMocks.stages[0].destroyed).toBe(true);
    expect(requests).not.toHaveBeenCalled();
  });

  it("retains retimed sound hooks, minimum-delay controls and the single animation owner", () => {
    const sequenced = vi.spyOn(DiscardAnimator.prototype, "setSequenced");
    const sounds = vi.spyOn(DiscardAnimator.prototype, "setSoundHooks");
    const minimum = vi.spyOn(
      DiscardAnimator.prototype,
      "setMinimumDrawToDiscardDelayEnabled"
    );
    const renderer = new TableRenderer();
    const hooks = {
      onDiscardLand: vi.fn(),
      onDrawLand: vi.fn(),
      onCatchUpSnap: vi.fn(),
    };
    renderer.setDrawSequencing(true, hooks);
    renderer.setMinimumDrawToDiscardDelayEnabled(false);
    expect(sequenced).toHaveBeenCalledWith(true);
    expect(sounds).toHaveBeenCalledWith(hooks);
    expect(minimum).toHaveBeenCalledWith(false);
    renderer.destroy();
  });

  it("clears riichi mode before invoking the host and keeps the shown physical tile intent", async () => {
    const renderer = new TableRenderer({ webTableLayoutMode: "compact" });
    const action = {
      id: "riichi:2m:hand",
      type: "riichi",
      tile: "2m",
      discardSource: "hand",
    } as const;
    const view: MatchView = {
      ...useMatchStore.getInitialState(),
      mySeat: 0,
      conn: "open" as const,
      hands: [["2m", "1m", "3m"], [], [], []],
      legalActions: [action],
    };
    renderer.setAnimationsEnabled(false);
    renderer.setOnRenderRequest(() => renderer.render(view));
    const onAction = vi.fn(() => {
      renderer.render(view);
      expect(allText(root()).some((text) => text.text === "Cancel")).toBe(
        false
      );
    });
    renderer.setOnActionClick(onAction);
    await renderer.mount(new HTMLElement());
    renderer.render(view);
    const riichi = allText(root()).find(
      (text) => text.text === "Riichi"
    )?.parent;
    if (!riichi) {
      throw new Error("Expected riichi control");
    }
    click(riichi);
    flushAnimationFrame();
    const hand = root().children.find((node) => node.zIndex === 10);
    if (!(hand instanceof Container)) {
      throw new Error("Expected focused hand");
    }
    const tile = hand.children.filter(
      (node): node is Sprite => node instanceof Sprite
    )[1];
    const point = hand.toGlobal(
      new Point(tile.x + tile.width / 2, tile.y + tile.height / 2)
    );
    click(tile, point.x, point.y);
    window.dispatchEvent(
      Object.assign(new Event("pointerup"), {
        button: 0,
        pointerType: "mouse",
        clientX: point.x,
        clientY: point.y,
      })
    );
    expect(onAction).toHaveBeenCalledWith({ action });
    renderer.destroy();
  });

  it("advances multi-winner pages immediately without waiting for the host's next animation frame", async () => {
    const renderer = new TableRenderer({ webTableLayoutMode: "compact" });
    renderer.setAnimationsEnabled(false);
    renderer.setStagedRevealEnabled(false);
    const view: MatchView = {
      ...useMatchStore.getInitialState(),
      conn: "replay",
      lastHandResult: {
        reason: "ron",
        delta: [-1_000, 500, 500, 0],
        wins: [
          { seat: 1, yaku: { Riichi: "1飜" } },
          { seat: 2, yaku: { Pinfu: "1飜" } },
        ],
      },
    };
    await renderer.mount(new HTMLElement());
    renderer.render(view);
    expect(allText(root()).some((text) => text.text === "1 / 2")).toBe(true);
    const overlay = root().children.find((node) => node.zIndex === 1_000);
    const background = overlay?.children[1]?.children[0];
    if (!(background instanceof Graphics)) {
      throw new Error("Expected multi-winner paging target");
    }
    click(background);
    expect(allText(root()).some((text) => text.text === "2 / 2")).toBe(true);
    expect(sceneMocks.raf.size).toBe(0);
    renderer.destroy();
  });

  it("retains loaded team logos on a same-facade remount without destroying shared atlas sources", async () => {
    const renderer = new TableRenderer({ webTableLayoutMode: "compact" });
    renderer.setAnimationsEnabled(false);
    const logoUrl = "https://team.invalid/logo.png";
    renderer.setSeatEnrichment([{ teamName: "Team", teamLogoUrl: logoUrl }]);
    const view: MatchView = {
      ...useMatchStore.getInitialState(),
      conn: "replay",
      seatNames: ["Player A", "Player B", "Player C", "Player D"],
    };
    await renderer.mount(new HTMLElement());
    renderer.render(view);
    await Promise.resolve();
    renderer.render(view);
    expect(logoLoad.mock.calls.filter(([url]) => url === logoUrl)).toHaveLength(
      1
    );
    const cached = await logoLoad.mock.results.find(
      (_result, index) => logoLoad.mock.calls[index][0] === logoUrl
    )?.value;
    renderer.destroy();
    expect(cached?.destroyed).toBe(false);
    await renderer.mount(new HTMLElement());
    renderer.render(view);
    expect(logoLoad.mock.calls.filter(([url]) => url === logoUrl)).toHaveLength(
      1
    );
    renderer.destroy();
    expect(cached?.destroyed).toBe(false);
  });
});
