import { Container, Graphics, Text, TextStyle } from "pixi.js";
import type { RenderFrame } from "../scene/renderTypes";
import {
  activePlayerIndicatorSeat,
  formatTableScore,
} from "../geometry/resultReveal";
import {
  scoreCartridgeFontSize,
  scoreCartridgeMetrics,
  scoreCartridgeScoreScale,
  scoreCartridgeTextLayout,
} from "../geometry/scoreGeometry";
import { KANJI_FONT_FAMILY, WIND_KANJI } from "../geometry/renderConstants";

export function renderScores(
  frame: RenderFrame,
  showRelativeScores: boolean,
  showWaits: boolean
): void {
  const { view, root, presentation } = frame;
  const center = frame.layout.center;
  const cx = center.x + center.w / 2;
  const cy = center.y + center.h / 2;
  const { width: chipW, height: chipH, inset } = scoreCartridgeMetrics(center);
  const indicatorSeat = activePlayerIndicatorSeat(view);
  const positions = [
    { x: cx, y: center.y + center.h - inset - chipH / 2, rotation: 0 },
    {
      x: center.x + center.w - inset - chipH / 2,
      y: cy,
      rotation: -Math.PI / 2,
    },
    { x: cx, y: center.y + inset + chipH / 2, rotation: Math.PI },
    { x: center.x + inset + chipH / 2, y: cy, rotation: Math.PI / 2 },
  ];
  for (let seat = 0; seat < 4; seat++) {
    const position = positions[seat];
    const chip = new Container();
    const background = new Graphics()
      .roundRect(-chipW / 2, -chipH / 2, chipW, chipH, 6)
      .fill({ color: 0x000000, alpha: 0.7 });
    const score = new Text({
      text: formatTableScore(
        view.scores[seat],
        view.scores[0],
        showRelativeScores && seat !== 0
      ),
      style: new TextStyle({
        fontFamily: "Inter, system-ui, sans-serif",
        fontSize: scoreCartridgeFontSize(chipH, presentation),
        fontWeight: "700",
        fill: view.sinking[seat] ? 0xff6b6b : 0xffffff,
      }),
    });
    const textLayout = scoreCartridgeTextLayout(chipW, chipH, presentation);
    score.anchor.set(1, 0.5);
    score.position.set(textLayout.scoreRightX, 0);
    const wind = WIND_KANJI[(seat - view.dealer + 4) % 4];
    const windText = new Text({
      text: wind,
      style: new TextStyle({
        fontFamily: KANJI_FONT_FAMILY,
        fontSize: Math.max(16, chipH),
        fontWeight: "400",
        fill:
          indicatorSeat === seat
            ? 0xff4d4f
            : wind === "東"
              ? 0xffffff
              : 0x9ca3af,
      }),
    });
    windText.anchor.set(0, 0.5);
    windText.position.set(textLayout.seatIndicatorLeftX, 0);
    if (presentation === "mobile") {
      score.scale.set(
        scoreCartridgeScoreScale(chipW, chipH, score.width, windText.width)
      );
    }
    chip.addChild(background, windText, score);
    if (showWaits && view.lastHandResult?.waits && view.mySeat === seat) {
      const waits = view.lastHandResult.waits[seat];
      if (waits && waits.length > 0) {
        const waitText = new Text({
          text: `待: ${waits.join(" ")}`,
          style: new TextStyle({
            fontFamily: "Inter, system-ui, sans-serif",
            fontSize: Math.max(10, Math.round(chipH * 0.5)),
            fontWeight: "600",
            fill: 0x86efac,
            stroke: { color: 0x000000, width: 3 },
          }),
        });
        waitText.anchor.set(0.5, 0);
        waitText.position.set(0, chipH / 2 + 4);
        chip.addChild(waitText);
      }
    }
    chip.rotation = position.rotation;
    chip.position.set(position.x, position.y);
    root.addChild(chip);
  }
}
