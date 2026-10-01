import { vi } from "vitest";
import { Container, Graphics, Sprite, Text, Texture } from "pixi.js";
import { useMatchStore, type MatchView } from "../../store";
import { currentTableLayout } from "../layouts/currentTableLayout";
import type {
  RenderFrame,
  RenderResources,
  TableRendererPresentation,
} from "../scene/renderTypes";
import { tableLayoutFromConfig } from "../tableLayout";
import { meldTileDims } from "../tileAreaLayout";
import { tenhouTileDesign } from "../tiles/designs/tenhouTileDesign";
import { TileSpriteFactory } from "../tiles/tileSpriteFactory";
import { TileTextureStore } from "../tiles/tileTextureStore";
import type { TimerHost } from "../hud/hudTypes";
import type { MeldDrawingPort } from "./resultTypes";

const logoMocks = vi.hoisted(() => ({
  logoLoad: vi.fn<(url: string) => Promise<Texture>>(),
}));

export const logoLoad = logoMocks.logoLoad;

const sceneState = vi.hoisted(() => ({
  stages: [] as Container[],
  screens: [] as { width: number; height: number }[],
  canvases: [] as EventTarget[],
  tickers: [] as Set<() => void>[],
  raf: new Map<number, FrameRequestCallback>(),
  resizeCallbacks: [] as (() => void)[],
  fontLoad: vi.fn<(font: string, text?: string) => Promise<FontFace[]>>(),
  disconnect: vi.fn<() => void>(),
  nextRaf: 0,
}));

export const sceneMocks = sceneState;

// Stub browser startup and font measurement, retaining real Pixi display trees.
vi.mock("pixi.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("pixi.js")>();
  class HeadlessText extends actual.Container {
    text: string;
    style: InstanceType<typeof actual.TextStyle>;
    anchor = new actual.Point();

    constructor(options: {
      text: string;
      style: InstanceType<typeof actual.TextStyle>;
    }) {
      super();
      this.text = options.text;
      this.style = options.style;
    }

    override get width(): number {
      return Math.abs(this.scale.x) * this.text.length * 8;
    }

    override set width(width: number) {
      this.scale.x = this.text.length > 0 ? width / (this.text.length * 8) : 1;
    }

    override get height(): number {
      return Math.abs(this.scale.y) * Number(this.style.fontSize);
    }

    override set height(height: number) {
      this.scale.y = height / Number(this.style.fontSize);
    }
  }
  class HeadlessCanvas extends EventTarget {
    constructor(private readonly screen: { width: number; height: number }) {
      super();
    }
    getBoundingClientRect(): DOMRect {
      return {
        x: 0,
        y: 0,
        left: 0,
        top: 0,
        right: this.screen.width,
        bottom: this.screen.height,
        width: this.screen.width,
        height: this.screen.height,
        toJSON: () => ({}),
      };
    }
  }
  class HeadlessApplication {
    readonly screen = { width: 1_000, height: 926 };
    readonly canvas = new HeadlessCanvas(this.screen);
    readonly stage = new actual.Container();
    private readonly callbacks = new Set<() => void>();
    readonly ticker = {
      add: vi.fn((callback: () => void) => this.callbacks.add(callback)),
      remove: vi.fn((callback: () => void) => this.callbacks.delete(callback)),
    };
    readonly init = vi.fn(
      async (options: { width: number; height: number }) => {
        this.screen.width = options.width;
        this.screen.height = options.height;
      }
    );
    readonly resize = vi.fn<() => void>();
    readonly destroy = vi.fn(
      (_removeView: boolean, options: { children: boolean }) => {
        this.stage.destroy(options);
      }
    );

    constructor() {
      sceneMocks.stages.push(this.stage);
      sceneMocks.screens.push(this.screen);
      sceneMocks.canvases.push(this.canvas);
      sceneMocks.tickers.push(this.callbacks);
    }
  }
  return {
    ...actual,
    Text: HeadlessText,
    Application: HeadlessApplication,
    Assets: { ...actual.Assets, load: logoMocks.logoLoad },
  };
});

export function installSceneEnvironment(): HTMLElement {
  sceneMocks.stages.length = 0;
  sceneMocks.screens.length = 0;
  sceneMocks.canvases.length = 0;
  sceneMocks.tickers.length = 0;
  sceneMocks.raf.clear();
  sceneMocks.resizeCallbacks.length = 0;
  sceneMocks.nextRaf = 0;
  sceneMocks.disconnect.mockClear();
  sceneMocks.fontLoad.mockResolvedValue([]);
  vi.stubGlobal(
    "window",
    Object.assign(new EventTarget(), { devicePixelRatio: 2 })
  );
  vi.stubGlobal(
    "requestAnimationFrame",
    (callback: FrameRequestCallback): number => {
      const id = ++sceneMocks.nextRaf;
      sceneMocks.raf.set(id, callback);
      return id;
    }
  );
  vi.stubGlobal("cancelAnimationFrame", (id: number): void => {
    sceneMocks.raf.delete(id);
  });
  class HeadlessElement extends EventTarget {
    appendChild<T extends Node>(child: T): T {
      return child;
    }
  }
  vi.stubGlobal("HTMLElement", HeadlessElement);
  vi.stubGlobal("document", { fonts: { load: sceneMocks.fontLoad } });
  class HeadlessResizeObserver implements ResizeObserver {
    constructor(callback: ResizeObserverCallback) {
      sceneMocks.resizeCallbacks.push(() => callback([], this));
    }
    observe(_target: Element): void {}
    unobserve(_target: Element): void {}
    disconnect(): void {
      sceneMocks.disconnect();
    }
  }
  vi.stubGlobal("ResizeObserver", HeadlessResizeObserver);
  return new HTMLElement();
}

export function flushAnimationFrame(): void {
  const callbacks = [...sceneMocks.raf.values()];
  sceneMocks.raf.clear();
  for (const callback of callbacks) {
    callback(0);
  }
}

export function createFrame(
  overrides: Partial<MatchView> = {},
  presentation: TableRendererPresentation = "standard"
): RenderFrame {
  return {
    view: { ...useMatchStore.getInitialState(), ...overrides },
    root: new Container(),
    layout: tableLayoutFromConfig(currentTableLayout),
    presentation,
    waitTiles: new Set(),
  };
}

export function createResources(): RenderResources {
  const textureStore = new TileTextureStore(tenhouTileDesign);
  const spriteFactory = new TileSpriteFactory(textureStore);
  vi.spyOn(spriteFactory, "create").mockImplementation((spec) => {
    const sprite = new Sprite(Texture.EMPTY);
    sprite.anchor.set(spec.anchor ?? 0.5);
    sprite.width = spec.width;
    sprite.height = spec.height;
    return sprite;
  });
  return {
    tileDesign: tenhouTileDesign,
    textureStore,
    spriteFactory,
    chipIconTex: null,
    dabukenIconTex: null,
    feltMaskTex: null,
  };
}

export function createMeldDrawer(): MeldDrawingPort {
  const metrics = meldTileDims(tenhouTileDesign, 0);
  return {
    drawMeld: vi.fn(() => ({
      node: new Container(),
      width: metrics.w * 3,
      boxes: [],
    })),
    drawMeldTile: vi.fn(() => ({
      node: new Graphics().rect(0, 0, metrics.w, metrics.h).fill(0xffffff),
      offX: 0,
      offY: 0,
      footW: metrics.w,
      footH: metrics.h,
    })),
  };
}

export function allText(root: Container): Text[] {
  const texts: Text[] = [];
  for (const child of root.children) {
    if (child instanceof Text) {
      texts.push(child);
    }
    if (child instanceof Container) {
      texts.push(...allText(child));
    }
  }
  return texts;
}

export function createTimerHost(): {
  host: TimerHost;
  callbacks: Set<() => void>;
} {
  const callbacks = new Set<() => void>();
  const host: TimerHost = {
    stage: new Container(),
    screen: { width: 1_000, height: 926 },
    ticker: {
      add(callback): void {
        callbacks.add(callback);
      },
      remove(callback): void {
        callbacks.delete(callback);
      },
    },
  };
  return { host, callbacks };
}
