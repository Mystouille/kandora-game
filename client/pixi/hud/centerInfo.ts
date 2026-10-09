import { Container, Graphics, Text, TextStyle } from "pixi.js";
import type { RenderFrame, RenderResources } from "../scene/renderTypes";
import { displayedTilesRemaining } from "../panels/duplicateCounterPlan";
import {
  fitCounterContentInCell,
  MOBILE_DORA_INDICATOR_GAP,
  mobileCounterCells,
  mobileDoraIndicatorSlots,
  mobileDoraRowGeometry,
} from "../geometry/centerGeometry";
import {
  KANJI_FONT_FAMILY,
  ROUND_WIND_KANJI,
} from "../geometry/renderConstants";

export function renderMobileCenterPanel(frame: RenderFrame): void {
  const center = frame.layout.center;
  const panel = new Graphics()
    .roundRect(center.x, center.y, center.w, center.h, 7)
    .fill({ color: 0x161b19, alpha: 0.96 })
    .stroke({ color: 0x778078, width: 2, alpha: 0.55 });
  panel.zIndex = -8;
  frame.root.addChild(panel);
}

export function renderMobileCenterInfo(
  frame: RenderFrame,
  resources: RenderResources
): void {
  const { view, root } = frame;
  const center = frame.layout.center;
  const cx = center.x + center.w / 2;
  const slots = mobileDoraIndicatorSlots(view.doraIndicators);
  const dora = mobileDoraRowGeometry(center, slots.length);
  slots.forEach((tile, index) => {
    const sprite = resources.spriteFactory.create({
      atlasId:
        tile === null
          ? resources.tileDesign.sheets.wallBack[0]
          : resources.tileDesign.sheets.wallFace[0],
      tile,
      width: dora.tileW,
      height: dora.tileH,
      anchor: 0,
    });
    sprite.position.set(
      dora.x + index * (dora.tileW + MOBILE_DORA_INDICATOR_GAP),
      dora.y
    );
    root.addChild(sprite);
  });
  const heading = new Text({
    text:
      view.rulesFamily === "mcr"
        ? `${view.roundWind} ${view.roundNumber}`
        : `${ROUND_WIND_KANJI[view.roundWind]}${view.roundNumber}局`,
    style: new TextStyle({
      fontFamily: KANJI_FONT_FAMILY,
      fontSize: Math.max(28, Math.round(center.h * 0.15)),
      fontWeight: "400",
      fill: 0xffffff,
    }),
  });
  heading.anchor.set(0.5, 0.5);
  heading.position.set(cx, dora.y + dora.tileH + heading.height * 0.55);
  root.addChild(heading);
  const counters: Array<{
    kind: "honba" | "riichi" | "tiles";
    value: number;
    color: number;
  }> = [
    ...(view.buuMode === true || view.rulesFamily === "mcr"
      ? []
      : [{ kind: "honba" as const, value: view.honba, color: 0xfde68a }]),
    ...(view.rulesFamily === "mcr"
      ? []
      : [
          {
            kind: "riichi" as const,
            value: view.riichiSticks,
            color: 0xfca5a5,
          },
        ]),
    { kind: "tiles", value: displayedTilesRemaining(view), color: 0xd1d5db },
  ];
  const cells = mobileCounterCells(center, counters.length);
  const counterRow = new Container();
  counters.forEach((counter, index) => {
    const item = new Container();
    const icon = new Graphics();
    if (counter.kind === "tiles") {
      icon
        .roundRect(-6, -9, 12, 18, 2)
        .stroke({ color: counter.color, width: 2 });
    } else {
      icon.roundRect(-9, -3, 18, 6, 2).fill({ color: 0xf2f0df });
      if (counter.kind === "riichi") {
        icon.circle(0, 0, 2.5).fill({ color: 0xd9363e });
      } else {
        [-5, 0, 5].forEach((x) => {
          icon.circle(x, 0, 1).fill({ color: 0x6b5b2a });
        });
      }
    }
    const value = new Text({
      text: String(counter.value),
      style: new TextStyle({
        fontFamily: "Inter, system-ui, sans-serif",
        fontSize: 16,
        fontWeight: "700",
        fill: counter.color,
      }),
    });
    value.anchor.set(0, 0.5);
    value.position.set(12, 0);
    item.addChild(icon, value);
    const bounds = item.getLocalBounds();
    const placement = fitCounterContentInCell(
      {
        minX: bounds.minX,
        minY: bounds.minY,
        maxX: bounds.maxX,
        maxY: bounds.maxY,
      },
      cells[index],
      3
    );
    item.scale.set(placement.scale);
    item.position.set(placement.x, placement.y);
    counterRow.addChild(item);
  });
  root.addChild(counterRow);
}
