import type { RenderFrame, RenderResources } from "../scene/renderTypes";
import type { InteractionController } from "../interaction/interactionController";
import { focusedHandTileSpriteSpec } from "../geometry/handGeometry";
import { canInteractWithFocusedHand } from "../geometry/interactionPolicy";
import { TSUMO_GAP } from "../geometry/renderConstants";
import { tintIfWait } from "./tileTint";
import {
  HAND_DRAW_SLIDE_PX,
  type FocusedHandPaint,
  type HandShadows,
  type HandStripPaint,
} from "./handRenderTypes";

export function renderFocusedHand(
  resources: RenderResources,
  frame: RenderFrame,
  paint: HandStripPaint,
  focus: FocusedHandPaint,
  interaction: InteractionController,
  shadows: HandShadows
): void {
  const { handContainer, seat, hand, hiddenHandSlot, hideTsumoTile } = paint;
  const { rawHand, rawIndices, metrics } = focus;
  const { tile: t, spriteW, spriteH } = metrics;
  const handGap = paint.isFreshlyDrawn ? TSUMO_GAP : 0;
  const ownShadowSpec = resources.tileDesign.effects.shadow;
  const ownShadowLayer = shadows.screenShadowLayer(handContainer, 0);
  hand.forEach((tile, index) => {
    if (index === hiddenHandSlot) {
      return;
    }
    const sprite = resources.spriteFactory.create(
      focusedHandTileSpriteSpec(resources.tileDesign, tile, metrics)
    );
    tintIfWait(sprite, tile, frame.waitTiles);
    const extraGap = handGap > 0 && index === hand.length - 1 ? handGap : 0;
    const slotX = index * (t.w + t.gap) + extraGap;
    let posX = slotX;
    let posY = 0;
    if (seat === 0 && rawIndices !== null) {
      const position = interaction.focusedTilePosition(
        rawIndices[index],
        slotX
      );
      posX = position.x;
      posY = position.y;
    }
    sprite.position.set(posX, posY);
    if (
      seat === 0 &&
      rawIndices !== null &&
      interaction.isDraggedRawIndex(rawIndices[index])
    ) {
      sprite.zIndex = 1_000_000;
    }
    if (
      frame.view.mySeat === seat &&
      tile &&
      canInteractWithFocusedHand(frame.view)
    ) {
      interaction.bindFocusedHandTile(sprite, handContainer, {
        view: frame.view,
        seat,
        tile,
        displayIndex: index,
        rawIndex: rawIndices !== null ? rawIndices[index] : index,
        rawHand,
        displayHand: hand,
        isFreshlyDrawn: focus.isFreshlyDrawnNatural,
        slotX,
        spriteW,
        spriteH,
        inRiichiMode: focus.inRiichiMode,
      });
    }
    if (ownShadowSpec && !(hideTsumoTile && index === hand.length - 1)) {
      shadows.placeUprightShadow(
        ownShadowLayer,
        posX + spriteW,
        posY + spriteH,
        spriteH,
        ownShadowSpec.big
      );
    }
    if (hideTsumoTile && index === hand.length - 1) {
      sprite.alpha = 0;
    }
    handContainer.addChild(sprite);
  });
  if (paint.isDrawing) {
    const slotX = (hand.length - 1) * (t.w + t.gap) + handGap;
    const slidePosX = slotX + HAND_DRAW_SLIDE_PX * (1 - paint.drawProgress);
    if (ownShadowSpec) {
      shadows.placeUprightShadow(
        ownShadowLayer,
        slidePosX + spriteW,
        spriteH,
        spriteH,
        ownShadowSpec.big
      );
    }
    const sprite = resources.spriteFactory.create(
      focusedHandTileSpriteSpec(
        resources.tileDesign,
        hand[hand.length - 1],
        metrics
      )
    );
    sprite.position.set(slidePosX, 0);
    handContainer.addChild(sprite);
  }
  if (seat === 0) {
    handContainer.sortableChildren = true;
  }
}
