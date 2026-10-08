import { Text, TextStyle } from "pixi.js";
import { isTableSeatActive } from "../../tableProjection";
import type { Seat } from "../tableGeometry";
import type { RenderFrame } from "../scene/renderTypes";
import type { MeldAnimator } from "../meldAnimator";
import type { RyuukyokuDeclarationAnimator } from "../ryuukyokuDeclarationAnimator";
import { callEffectAnchor } from "../geometry/tableGeometry";
import {
  KANJI_FONT_FAMILY,
  CALL_EFFECT_Z_INDEX,
} from "../geometry/renderConstants";

export function renderCallEffects(
  frame: RenderFrame,
  meldAnimator: MeldAnimator,
  declarationAnimator: RyuukyokuDeclarationAnimator
): void {
  const layout = frame.layout;

  if (!frame.root) {
    return;
  }
  const effects = [
    meldAnimator.getCallEffect(),
    declarationAnimator.getCallEffect(),
  ].filter((effect) => effect !== null);
  for (const effect of effects) {
    if (!isTableSeatActive(frame.view, effect.seat)) {
      continue;
    }
    const anchor = callEffectAnchor(layout, effect.seat as Seat);
    const text = new Text({
      text: effect.label,
      style: new TextStyle({
        fontFamily: KANJI_FONT_FAMILY,
        fontSize: 54,
        fontWeight: "700",
        fill: 0xffffff,
        stroke: { color: 0x000000, width: 8 },
      }),
    });
    text.anchor.set(0.5);
    text.position.set(anchor.x, anchor.y);
    text.alpha = effect.alpha;
    text.scale.set(effect.scale);
    text.zIndex = CALL_EFFECT_Z_INDEX;
    frame.root.sortableChildren = true;
    frame.root.addChild(text);
  }
}
