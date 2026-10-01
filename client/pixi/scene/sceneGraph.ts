import { Application, Container, Graphics, Sprite } from "pixi.js";
import type { Rect, TableLayout, TableLayoutConfig } from "../tableLayout";
import { BG_COLOR, FELT_COLOR } from "../geometry/renderConstants";
import type { RenderResources } from "./renderTypes";

export class SceneGraph {
  private application: Application | null = null;
  private tableRoot: Container | null = null;
  private onRenderRequest: (() => void) | null = null;
  private renderRequestRafHandle: number | null = null;
  private resizeRafHandle: number | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private animationTickHandler: (() => void) | null = null;

  get app(): Application | null {
    return this.application;
  }

  get root(): Container | null {
    return this.tableRoot;
  }

  setOnRenderRequest(handler: () => void): void {
    this.onRenderRequest = handler;
  }

  requestRender(): void {
    if (this.renderRequestRafHandle !== null || !this.onRenderRequest) {
      return;
    }
    this.renderRequestRafHandle = requestAnimationFrame(() => {
      this.renderRequestRafHandle = null;
      this.onRenderRequest?.();
    });
  }

  async mount(
    container: HTMLElement,
    layoutConfig: TableLayoutConfig
  ): Promise<Application> {
    const app = new Application();
    await app.init({
      width: layoutConfig.viewport.w,
      height: layoutConfig.viewport.h,
      background: BG_COLOR,
      antialias: true,
      roundPixels: true,
      resolution: window.devicePixelRatio || 1,
      autoDensity: true,
      resizeTo: container,
    });
    container.appendChild(app.canvas);
    this.application = app;
    return app;
  }

  createRoot(): Container {
    const app = this.application;
    if (!app) {
      throw new Error("TableRenderer: application not mounted");
    }
    const root = new Container();
    root.sortableChildren = true;
    app.stage.addChild(root);
    this.tableRoot = root;
    return root;
  }

  startAnimationPump(hasActive: () => boolean): void {
    const app = this.application;
    if (!app) {
      throw new Error("TableRenderer: application not mounted");
    }
    const handler = (): void => {
      if (hasActive()) {
        this.requestRender();
      }
    };
    this.animationTickHandler = handler;
    app.ticker.add(handler);
  }

  observe(container: HTMLElement): void {
    if (typeof ResizeObserver === "undefined") {
      return;
    }
    this.resizeObserver = new ResizeObserver(() => {
      if (this.resizeRafHandle !== null) {
        return;
      }
      this.resizeRafHandle = requestAnimationFrame(() => {
        this.resizeRafHandle = null;
        this.application?.resize();
        this.requestRender();
      });
    });
    this.resizeObserver.observe(container);
  }

  beginFrame(
    layout: TableLayout,
    feltBox: Rect,
    resources: RenderResources
  ): Container {
    const app = this.application;
    const root = this.tableRoot;
    if (!app || !root) {
      throw new Error("TableRenderer: scene not mounted");
    }
    app.resize();
    const screenW = app.screen.width;
    const screenH = app.screen.height;
    const scale = Math.min(screenW / layout.table.w, screenH / layout.table.h);
    root.scale.set(scale);
    root.position.set(
      (screenW - layout.table.w * scale) / 2,
      (screenH - layout.table.h * scale) / 2
    );
    for (const child of root.removeChildren()) {
      child.destroy({ children: true, texture: false });
    }
    const felt = new Graphics()
      .rect(feltBox.x, feltBox.y, feltBox.w, feltBox.h)
      .fill({ color: FELT_COLOR });
    felt.zIndex = -30;
    root.addChild(felt);
    if (resources.feltMaskTex) {
      const mask = new Sprite(resources.feltMaskTex);
      mask.position.set(feltBox.x, feltBox.y);
      mask.width = feltBox.w;
      mask.height = feltBox.h;
      mask.blendMode = "multiply";
      mask.zIndex = -20;
      root.addChild(mask);
    }
    return root;
  }

  destroy(): void {
    if (this.resizeRafHandle !== null) {
      cancelAnimationFrame(this.resizeRafHandle);
      this.resizeRafHandle = null;
    }
    if (this.renderRequestRafHandle !== null) {
      cancelAnimationFrame(this.renderRequestRafHandle);
      this.renderRequestRafHandle = null;
    }
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    if (this.application) {
      if (this.animationTickHandler) {
        this.application.ticker.remove(this.animationTickHandler);
        this.animationTickHandler = null;
      }
      // The Pixi asset cache owns atlas sources across renderer mounts.
      this.application.destroy(true, { children: true });
      this.application = null;
    }
    this.tableRoot = null;
  }
}
