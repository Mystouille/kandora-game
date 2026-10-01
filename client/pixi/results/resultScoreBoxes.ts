import { Container, Graphics, Text, TextStyle } from "pixi.js";
import type { MatchView } from "../../store";
import type { HandResult } from "../scene/renderTypes";
import type { Rect } from "../tableLayout";
import { handResultDealerSeat } from "../geometry/resultReveal";
import { resultScoreBoxLayout } from "../geometry/scoreGeometry";
import { RESULT_SCORE_BOX_NAME_GAP } from "../geometry/renderConstants";

export function renderResultStickInfo(
  result: HandResult,
  inner: Rect,
  parent: Container
): void {
  const honba = result.honba ?? 0;
  const sticks = result.riichiSticks ?? 0;
  if (honba === 0 && sticks === 0) {
    return;
  }
  const lines: string[] = [];
  if (honba > 0) {
    lines.push(`${honba} honba`);
  }
  if (sticks > 0) {
    lines.push(`${sticks} riichi stick${sticks === 1 ? "" : "s"}`);
  }
  const fontSize = 18;
  const container = new Container();
  const texts = lines.map(
    (line) =>
      new Text({
        text: line,
        style: new TextStyle({
          fontFamily: "Inter, system-ui, sans-serif",
          fontSize,
          fontWeight: "500",
          fill: 0xffffff,
        }),
      })
  );
  const padX = 12;
  const padY = 8;
  const lineGap = 4;
  const w = Math.max(...texts.map((text) => text.width)) + padX * 2;
  const h = texts.length * fontSize + (texts.length - 1) * lineGap + padY * 2;
  const background = new Graphics()
    .roundRect(0, 0, w, h, 8)
    .fill({ color: 0x000000, alpha: 0.7 })
    .stroke({ color: 0xffffff, width: 1, alpha: 0.2 });
  container.addChild(background);
  texts.forEach((text, index) => {
    text.position.set(padX, padY + index * (fontSize + lineGap));
    container.addChild(text);
  });
  container.position.set(inner.x + 12, inner.y + 12);
  parent.addChild(container);
}

interface ScoreBoxPosition {
  x: number;
  y: number;
  anchor: "n" | "e" | "s" | "w";
}

export function renderResultScoreBoxes(
  view: Pick<MatchView, "dealer" | "seatNames" | "scores">,
  result: HandResult,
  inner: Rect,
  parent: Container,
  scoreDeltaRevealed: boolean
): void {
  if (!result.delta) {
    return;
  }
  const margin = 16;
  const cx = inner.x + inner.w / 2;
  const cy = inner.y + inner.h / 2;
  const positions: ScoreBoxPosition[] = [
    { x: cx, y: inner.y + inner.h - margin, anchor: "s" },
    { x: inner.x + inner.w - margin, y: cy, anchor: "e" },
    { x: cx, y: inner.y + margin, anchor: "n" },
    { x: inner.x + margin, y: cy, anchor: "w" },
  ];
  const resultDealer = handResultDealerSeat(result, view.dealer);
  for (let seat = 0; seat < 4; seat++) {
    const name = view.seatNames?.[seat] || `Player ${seat + 1}`;
    const delta = result.delta[seat] ?? 0;
    const before = (view.scores[seat] ?? 0) - delta;
    drawScoreBox(
      name,
      resultDealer === seat,
      before,
      delta,
      positions[seat],
      parent,
      scoreDeltaRevealed
    );
  }
}

function drawScoreBox(
  name: string,
  isDealer: boolean,
  before: number,
  delta: number,
  position: ScoreBoxPosition,
  parent: Container,
  scoreDeltaRevealed: boolean
): void {
  const container = new Container();
  const nameStyle = new TextStyle({
    fontFamily: "Inter, system-ui, sans-serif",
    fontSize: 20,
    fontWeight: "700",
    fill: 0xffffff,
  });
  const nameText = new Text({ text: name, style: nameStyle });
  const dealerText = isDealer
    ? new Text({ text: "(dealer)", style: nameStyle })
    : null;
  const scoreText = new Text({
    text: `${before}`,
    style: new TextStyle({
      fontFamily: "Inter, system-ui, sans-serif",
      fontSize: 22,
      fontWeight: "600",
      fill: 0xffffff,
    }),
  });
  const deltaText =
    delta !== 0
      ? new Text({
          text: delta > 0 ? `+${delta}` : `${delta}`,
          style: new TextStyle({
            fontFamily: "Inter, system-ui, sans-serif",
            fontSize: 22,
            fontWeight: "700",
            fill: delta > 0 ? 0x4ade80 : 0xf87171,
          }),
        })
      : null;
  if (deltaText) {
    deltaText.visible = scoreDeltaRevealed;
  }
  const padY = 14;
  const innerGap = 10;
  const rowContentW = deltaText
    ? scoreText.width + innerGap + deltaText.width
    : scoreText.width;
  const rowContentH = Math.max(scoreText.height, deltaText?.height ?? 0);
  const boxLayout = resultScoreBoxLayout(
    nameText.width,
    dealerText?.width ?? 0
  );
  const innerW = boxLayout.width;
  const innerH = boxLayout.height;
  nameText.scale.set(boxLayout.nameScale);
  const background = new Graphics()
    .roundRect(0, 0, innerW, innerH, 10)
    .fill({ color: 0x000000, alpha: 0.85 })
    .stroke({ color: 0xffffff, width: 1, alpha: 0.3 });
  container.addChild(background);
  const fittedNameWidth = nameText.width;
  const dealerGap = dealerText ? RESULT_SCORE_BOX_NAME_GAP : 0;
  const nameRowWidth = fittedNameWidth + dealerGap + (dealerText?.width ?? 0);
  const nameRowHeight = 24;
  const nameRowX = (innerW - nameRowWidth) / 2;
  nameText.position.set(nameRowX, padY + (nameRowHeight - nameText.height) / 2);
  container.addChild(nameText);
  if (dealerText) {
    dealerText.position.set(
      nameRowX + fittedNameWidth + dealerGap,
      padY + (nameRowHeight - dealerText.height) / 2
    );
    container.addChild(dealerText);
  }
  const rowY = innerH - padY - rowContentH;
  const rowX = (innerW - rowContentW) / 2;
  scoreText.position.set(rowX, rowY);
  container.addChild(scoreText);
  if (deltaText) {
    deltaText.position.set(rowX + scoreText.width + innerGap, rowY);
    container.addChild(deltaText);
  }
  let x = position.x - innerW / 2;
  let y = position.y - innerH / 2;
  if (position.anchor === "s") {
    y = position.y - innerH;
  } else if (position.anchor === "n") {
    y = position.y;
  } else if (position.anchor === "w") {
    x = position.x;
  } else if (position.anchor === "e") {
    x = position.x - innerW;
  }
  container.position.set(x, y);
  parent.addChild(container);
}
