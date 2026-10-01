import { Graphics } from "pixi.js";
import type { RenderFrame } from "../scene/renderTypes";
import type { Rect } from "../tableLayout";

export function renderLayoutDebug(frame: RenderFrame): void {
  const fill = (rect: Rect, color: number, alpha = 0.75): Graphics =>
    new Graphics().rect(rect.x, rect.y, rect.w, rect.h).fill({ color, alpha });
  for (const rect of frame.layout.hands) {
    frame.root.addChild(fill(rect, 0x16a34a));
  }
  for (const rect of frame.layout.wall) {
    frame.root.addChild(fill(rect, 0xeab308));
  }
  for (const rect of frame.layout.playerInfo) {
    frame.root.addChild(fill(rect, 0xf97316));
  }
  for (const rect of frame.layout.discards) {
    frame.root.addChild(fill(rect, 0x2563eb));
  }
  frame.root.addChild(fill(frame.layout.center, 0xa855f7));
}

export function renderWallZonesDebug(frame: RenderFrame): void {
  for (const rect of frame.layout.wall) {
    const zone = new Graphics()
      .rect(rect.x, rect.y, rect.w, rect.h)
      .fill({ color: 0xeab308, alpha: 0.35 });
    zone.zIndex = 900;
    frame.root.addChild(zone);
  }
}
