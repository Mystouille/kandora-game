import {
  createFrame,
  installSceneEnvironment,
} from "../results/pixiTestHarness";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mobileTableLayout } from "../layouts/mobileTableLayout";
import { tableLayoutFromConfig } from "../tableLayout";
import { SceneGraph } from "../scene/sceneGraph";
import {
  CanvasInteractions,
  type CanvasShortcutFrame,
  type ResultPressPort,
} from "./canvasInteractions";

class PointerSample extends Event {
  readonly pointerId = 1;
  readonly pointerType = "touch";
  readonly isPrimary = true;

  constructor(
    type: string,
    readonly clientX: number,
    readonly clientY: number,
    private readonly stamp: number,
    readonly button = 0
  ) {
    super(type, { cancelable: true });
  }

  override get timeStamp(): number {
    return this.stamp;
  }
}

async function harness() {
  installSceneEnvironment();
  const graph = new SceneGraph();
  const app = await graph.mount(new HTMLElement(), mobileTableLayout);
  const root = graph.createRoot();
  const source = createFrame(
    { legalActions: [{ id: "pass", type: "pass" }] },
    "mobile"
  );
  const frame: CanvasShortcutFrame = {
    root,
    view: source.view,
    layout: tableLayoutFromConfig(mobileTableLayout),
    presentation: "mobile",
    actionBounds: [{ x: 900, y: 150, w: 200, h: 100 }],
  };
  const press = {
    winInfoPressEnabled: false,
    lastResultPanelBounds: null,
    hideHandResult: vi.fn(),
    restoreHandResult: vi.fn(),
  } satisfies ResultPressPort;
  const shortcut = vi.fn();
  const input = new CanvasInteractions(() => frame, shortcut, press);
  input.mount(app);
  const tap = (x: number, y: number, time: number, endX = x): PointerSample => {
    app.canvas.dispatchEvent(new PointerSample("pointerdown", x, y, time - 20));
    const release = new PointerSample("pointerup", endX, y, time);
    app.canvas.dispatchEvent(release);
    return release;
  };
  return { app, graph, input, press, shortcut, frame, tap };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("canvas input binding owner", () => {
  it("consumes only an eligible double tap and preserves the delay and movement limits", async () => {
    const h = await harness();
    expect(h.tap(200, 150, 100).defaultPrevented).toBe(false);
    expect(h.tap(200, 150, 400).defaultPrevented).toBe(true);
    expect(h.shortcut).toHaveBeenCalledTimes(1);
    h.tap(200, 150, 600, 230);
    h.tap(200, 150, 700);
    expect(h.shortcut).toHaveBeenCalledTimes(1);
    h.input.destroy();
    h.graph.destroy();
  });

  it.each([
    [600, 300],
    [600, 650],
    [1_000, 200],
  ])(
    "does not steal taps from the center, hand or controls at %i,%i",
    async (x, y) => {
      const h = await harness();
      h.tap(x, y, 100);
      expect(h.tap(x, y, 200).defaultPrevented).toBe(false);
      expect(h.shortcut).not.toHaveBeenCalled();
      h.input.destroy();
      h.graph.destroy();
    }
  );

  it("keeps right-click pass/tsumogiri separate from left-click and cleans up every DOM binding", async () => {
    const h = await harness();
    const context = new Event("contextmenu", { cancelable: true });
    h.app.canvas.dispatchEvent(context);
    expect(context.defaultPrevented).toBe(true);
    h.app.canvas.dispatchEvent(new PointerSample("mousedown", 20, 20, 100, 0));
    expect(h.shortcut).not.toHaveBeenCalled();
    h.app.canvas.dispatchEvent(new PointerSample("mousedown", 20, 20, 100, 2));
    expect(h.shortcut).toHaveBeenCalledTimes(1);
    h.input.destroy();
    h.app.canvas.dispatchEvent(new PointerSample("mousedown", 20, 20, 100, 2));
    window.dispatchEvent(new Event("pointerup"));
    expect(h.shortcut).toHaveBeenCalledTimes(1);
    expect(h.press.restoreHandResult).not.toHaveBeenCalled();
    h.graph.destroy();
  });
});
