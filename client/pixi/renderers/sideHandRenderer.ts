import { Container } from "pixi.js";
import type { RenderFrame, RenderResources } from "../scene/renderTypes";
import { SEAT_CONTAINER_ROT } from "../geometry/renderConstants";
import { layoutSideHand, type TilePlacement } from "../tileAreaLayout";
import { tintIfWait } from "./tileTint";
import {
  HAND_DRAW_SLIDE_PX,
  type HandShadows,
  type HandStripPaint,
} from "./handRenderTypes";

export function renderSideHand(
  resources: RenderResources,
  frame: RenderFrame,
  paint: HandStripPaint & { readonly seat: 1 | 3 },
  shadows: HandShadows
): void {
  const { handContainer, seat, hand, hideTsumoTile, isDrawing, drawProgress } =
    paint;
  handContainer.sortableChildren = true;
  const placements = layoutSideHand(resources.tileDesign, seat, hand, {
    canReveal: paint.canReveal,
    maskedForResult: paint.maskedForResult,
    isFreshlyDrawn: paint.isFreshlyDrawn,
    hiddenSlot: paint.hiddenHandSlot,
  });
  const lastPlacement = placements[placements.length - 1] ?? null;
  for (const p of placements) {
    const sprite = resources.spriteFactory.create({
      atlasId: p.atlasId,
      tile: p.tile,
      width: p.sprite.width,
      height: p.sprite.height,
      rotation: p.sprite.rotation,
    });
    sprite.position.set(p.sprite.x, p.sprite.y);
    tintIfWait(sprite, p.tile, frame.waitTiles);
    if (hideTsumoTile && p === lastPlacement) {
      sprite.alpha = 0;
    }
    const wrap = new Container();
    wrap.addChild(sprite);
    wrap.position.set(p.wrap.x, p.wrap.y);
    wrap.zIndex = p.zIndex;
    handContainer.addChild(wrap);
  }
  if (isDrawing && lastPlacement) {
    const p = lastPlacement;
    const sprite = resources.spriteFactory.create({
      atlasId: p.atlasId,
      tile: p.tile,
      width: p.sprite.width,
      height: p.sprite.height,
      rotation: p.sprite.rotation,
    });
    sprite.position.set(p.sprite.x, p.sprite.y);
    const wrap = new Container();
    wrap.addChild(sprite);
    wrap.zIndex = p.zIndex;
    wrap.position.set(
      p.wrap.x + HAND_DRAW_SLIDE_PX * (1 - drawProgress),
      p.wrap.y
    );
    handContainer.addChild(wrap);
  }
  const rotation = SEAT_CONTAINER_ROT[seat];
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  const layer = shadows.screenShadowLayer(handContainer, rotation);
  const shadowSize = (p: TilePlacement) => ({
    w: p.sprite.width,
    h: p.sprite.height,
  });
  shadows.placeColumnShadows(
    layer,
    placements
      .filter((p) => !(hideTsumoTile && p === lastPlacement))
      .map((p) => {
        const lx = p.wrap.x + p.sprite.x;
        const ly = p.wrap.y + p.sprite.y;
        const size = shadowSize(p);
        return {
          ax: lx * cos - ly * sin,
          ay: lx * sin + ly * cos,
          w: size.w,
          h: size.h,
        };
      })
  );
  if (isDrawing && lastPlacement) {
    const p = lastPlacement;
    const lx = p.wrap.x + HAND_DRAW_SLIDE_PX * (1 - drawProgress) + p.sprite.x;
    const ly = p.wrap.y + p.sprite.y;
    const size = shadowSize(p);
    shadows.placeColumnShadows(layer, [
      {
        ax: lx * cos - ly * sin,
        ay: lx * sin + ly * cos,
        w: size.w,
        h: size.h,
      },
    ]);
  }
}
