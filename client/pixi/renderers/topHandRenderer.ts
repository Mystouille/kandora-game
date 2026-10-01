import { Container } from "pixi.js";
import type { RenderFrame, RenderResources } from "../scene/renderTypes";
import { SEAT_CONTAINER_ROT } from "../geometry/renderConstants";
import { layoutTopHand, type TilePlacement } from "../tileAreaLayout";
import { tintIfWait } from "./tileTint";
import {
  HAND_DRAW_SLIDE_PX,
  type HandShadows,
  type HandStripPaint,
} from "./handRenderTypes";

export function renderTopHand(
  resources: RenderResources,
  frame: RenderFrame,
  paint: HandStripPaint,
  shadows: HandShadows
): void {
  const { handContainer, seat, hand, hideTsumoTile, isDrawing, drawProgress } =
    paint;
  const placements = layoutTopHand(resources.tileDesign, hand, {
    canReveal: paint.canReveal,
    maskedForResult: paint.maskedForResult,
    isFreshlyDrawn: paint.isFreshlyDrawn,
    hiddenSlot: paint.hiddenHandSlot,
  });
  handContainer.sortableChildren = true;
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
  const effect = resources.tileDesign.effects.shadow;
  if (effect) {
    const placeShadow = (p: TilePlacement, shift: number): void => {
      const lx = p.wrap.x + shift + p.sprite.x;
      const ly = p.wrap.y + p.sprite.y;
      const ax = lx * cos - ly * sin;
      const ay = lx * sin + ly * cos;
      if (p.tile === null && !paint.maskedForResult) {
        shadows.placeUprightShadow(
          layer,
          ax + p.sprite.width / 2,
          ay + p.sprite.height / 2,
          p.sprite.height,
          effect.uprightSmall
        );
      } else {
        shadows.placeBasicShadow(
          layer,
          ax + p.sprite.width / 2,
          ay,
          p.sprite.height,
          effect.small
        );
      }
    };
    for (const p of placements) {
      if (hideTsumoTile && p === lastPlacement) {
        continue;
      }
      placeShadow(p, 0);
    }
    if (isDrawing && lastPlacement) {
      placeShadow(lastPlacement, HAND_DRAW_SLIDE_PX * (1 - drawProgress));
    }
  }
}
