import { Container, Text, TextStyle } from "pixi.js";
import type { RenderFrame } from "../scene/renderTypes";
import { displayedTilesRemaining } from "../panels/duplicateCounterPlan";
import { scoreCartridgeMetrics } from "../geometry/scoreGeometry";
import {
  KANJI_FONT_FAMILY,
  ROUND_WIND_KANJI,
} from "../geometry/renderConstants";
import type { CenterLabels } from "./hudTypes";

export function renderRoundInfo(
  frame: RenderFrame,
  labels: CenterLabels
): void {
  const { view, root } = frame;
  const center = frame.layout.center;
  const cx = center.x + center.w / 2;
  const cy = center.y + center.h / 2;
  const fontSize = Math.max(22, Math.round(center.h * 0.13 * 1.6));
  const heading = new Text({
    text: `${ROUND_WIND_KANJI[view.roundWind]} - ${view.roundNumber}`,
    style: new TextStyle({
      fontFamily: KANJI_FONT_FAMILY,
      fontSize,
      fontWeight: "400",
      fill: 0xffffff,
    }),
  });
  heading.anchor.set(0.5, 0.5);
  const lineSize = Math.max(10, Math.round(center.h * 0.085));
  const lineGap = Math.round(lineSize * 0.25);
  const lines = [
    ...(view.buuMode === true
      ? []
      : [{ label: labels.repeat, value: String(view.honba), color: 0xfde68a }]),
    { label: labels.riichi, value: String(view.riichiSticks), color: 0xfca5a5 },
    {
      label: labels.tiles,
      value: String(displayedTilesRemaining(view)),
      color: 0xd1d5db,
    },
  ];
  const linesBlockH = lines.length * lineSize + (lines.length - 1) * lineGap;
  const headingGap = Math.round(lineSize * 0.6);
  const totalH = fontSize + headingGap + linesBlockH;
  const topY = cy - totalH / 2 + 3;
  heading.position.set(cx, topY + fontSize / 2 + 2);
  root.addChild(heading);
  const statusBlock = new Container();
  const { bottomTop } = scoreCartridgeMetrics(center);
  statusBlock.position.set(cx + 10, bottomTop - linesBlockH);
  let lineY = lineSize / 2;
  for (const line of lines) {
    const style = new TextStyle({
      fontFamily: "Inter, system-ui, sans-serif",
      fontSize: lineSize,
      fontWeight: "600",
      fill: line.color,
    });
    const labelText = new Text({ text: line.label, style });
    const colonText = new Text({ text: ":", style });
    const valueText = new Text({ text: line.value, style });
    const valueGap = Math.round(lineSize * 0.3);
    labelText.anchor.set(1, 0.5);
    colonText.anchor.set(0.5, 0.5);
    valueText.anchor.set(0, 0.5);
    labelText.position.set(-colonText.width / 2, lineY);
    colonText.position.set(0, lineY);
    valueText.position.set(colonText.width / 2 + valueGap, lineY);
    statusBlock.addChild(labelText, colonText, valueText);
    lineY += lineSize + lineGap;
  }
  root.addChild(statusBlock);
}
