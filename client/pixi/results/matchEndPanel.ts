import { Container, Graphics, Sprite, Text, TextStyle } from "pixi.js";
import type { MatchView } from "../../store";
import type { RenderResources } from "../scene/renderTypes";
import type { Rect } from "../tableLayout";

export function renderMatchEnd(
  view: Pick<MatchView, "matchEnded" | "seatNames" | "buuMode">,
  root: Container,
  resources: RenderResources,
  cx: number,
  cy: number
): Rect | null {
  if (!view.matchEnded) {
    return null;
  }
  const ordered = [...view.matchEnded.finalScores].sort(
    (a, b) => a.place - b.place
  );
  const showChipDelta =
    view.buuMode === true &&
    Array.isArray(view.matchEnded.chipsDelta) &&
    view.matchEnded.chipsDelta.length === 4;
  const chipDelta = showChipDelta ? view.matchEnded.chipsDelta : null;
  const rows = ordered.map((standing) => ({
    place: standing.place,
    name: view.seatNames?.[standing.seat] ?? `Seat ${standing.seat}`,
    score: standing.score,
    chipDelta: chipDelta ? chipDelta[standing.seat] : 0,
  }));
  const padX = 28;
  const padY = 20;
  const titleSize = 22;
  const rowSize = 16;
  const titleGap = 18;
  const dividerGap = 14;
  const rowHeight = 24;
  const titleStyle = new TextStyle({
    fontFamily: "Inter, system-ui, sans-serif",
    fontSize: titleSize,
    fontWeight: "700",
    fill: 0xffffff,
  });
  const rowStyle = new TextStyle({
    fontFamily: "Inter, system-ui, sans-serif",
    fontSize: rowSize,
    fontWeight: "600",
    fill: 0xffffff,
  });
  const titleText = new Text({ text: "Match ended", style: titleStyle });
  const formatChipDelta = (delta: number): string => {
    if (delta > 0) {
      return `+${delta}`;
    }
    if (delta < 0) {
      return `\u2212${Math.abs(delta)}`;
    }
    return "0";
  };
  const rowTexts = rows.map((row) => ({
    place: new Text({ text: `${row.place}.`, style: rowStyle }),
    name: new Text({ text: row.name, style: rowStyle }),
    score: new Text({ text: `${row.score}`, style: rowStyle }),
    chipDeltaText: showChipDelta
      ? new Text({
          text: formatChipDelta(row.chipDelta),
          style: new TextStyle({
            fontFamily: "Inter, system-ui, sans-serif",
            fontSize: rowSize,
            fontWeight: "700",
            fill:
              row.chipDelta > 0
                ? 0x86efac
                : row.chipDelta < 0
                  ? 0xfca5a5
                  : 0xe5e7eb,
          }),
        })
      : null,
  }));
  const placeColW = Math.max(...rowTexts.map((row) => row.place.width));
  const nameColW = Math.max(...rowTexts.map((row) => row.name.width));
  const scoreColW = Math.max(...rowTexts.map((row) => row.score.width));
  const placeGap = 8;
  const scoreGap = 28;
  const chipIconR = 9;
  const chipIconGap = 5;
  const chipDeltaGap = 24;
  const chipDeltaTextW = showChipDelta
    ? Math.max(
        ...rowTexts.map((row) =>
          row.chipDeltaText ? Math.ceil(row.chipDeltaText.width) : 0
        )
      )
    : 0;
  const chipDeltaColW = showChipDelta
    ? chipIconR * 2 + chipIconGap + chipDeltaTextW
    : 0;
  const contentW =
    placeColW +
    placeGap +
    nameColW +
    scoreGap +
    scoreColW +
    (showChipDelta ? chipDeltaGap + chipDeltaColW : 0);
  const innerW = Math.max(280, titleText.width, contentW);
  const w = innerW + padX * 2;
  const h =
    padY +
    titleText.height +
    titleGap +
    1 +
    dividerGap +
    rowTexts.length * rowHeight +
    padY;
  const panel = new Container();
  const background = new Graphics()
    .roundRect(0, 0, w, h, 12)
    .fill({ color: 0x000000, alpha: 0.85 });
  panel.addChild(background);
  titleText.position.set((w - titleText.width) / 2, padY);
  panel.addChild(titleText);
  const dividerY = padY + titleText.height + titleGap;
  const divider = new Graphics()
    .moveTo(padX, dividerY)
    .lineTo(w - padX, dividerY)
    .stroke({ color: 0xffffff, width: 1, alpha: 0.35 });
  panel.addChild(divider);
  const rowsX = (w - contentW) / 2;
  const rowsStartY = dividerY + dividerGap;
  rowTexts.forEach((row, index) => {
    const y = rowsStartY + index * rowHeight;
    row.place.position.set(rowsX, y);
    row.name.position.set(rowsX + placeColW + placeGap, y);
    const scoreRightX =
      rowsX + placeColW + placeGap + nameColW + scoreGap + scoreColW;
    row.score.position.set(scoreRightX - row.score.width, y);
    panel.addChild(row.place, row.name, row.score);
    if (showChipDelta && row.chipDeltaText) {
      const colLeftX = scoreRightX + chipDeltaGap;
      const rowCY = y + rowHeight / 2 - 4;
      let icon: Container;
      if (resources.chipIconTex) {
        const sprite = new Sprite(resources.chipIconTex);
        sprite.anchor.set(0.5, 0.5);
        sprite.width = chipIconR * 2;
        sprite.height = chipIconR * 2;
        icon = sprite;
      } else {
        icon = new Graphics()
          .circle(0, 0, chipIconR)
          .fill({ color: 0xfacc15 })
          .stroke({ color: 0xffffff, width: 1, alpha: 0.9 });
      }
      icon.position.set(colLeftX + chipIconR, rowCY);
      panel.addChild(icon);
      row.chipDeltaText.position.set(colLeftX + chipIconR * 2 + chipIconGap, y);
      panel.addChild(row.chipDeltaText);
    }
  });
  panel.position.set(cx - w / 2, cy - h / 2);
  root.addChild(panel);
  return { x: cx - w / 2, y: cy - h / 2, w, h };
}
