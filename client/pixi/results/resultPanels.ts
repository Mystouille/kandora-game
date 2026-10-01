import { Container, Graphics } from "pixi.js";
import type { RenderResources } from "../scene/renderTypes";
import {
  buildResultRowNodes,
  RESULT_ROW_INNER_GAP,
  type BuiltResultRow,
} from "./resultRowNodes";
import type { MeldDrawingPort, ResultRow } from "./resultTypes";

function rowGap(
  previous: BuiltResultRow["kind"] | null,
  row: BuiltResultRow
): number {
  if (previous === null) {
    return 0;
  }
  return row.kind !== previous || (row.kind !== "yaku" && row.kind !== "yaku2")
    ? 14
    : 6;
}

export function renderResultCenterPanel(
  rows: readonly ResultRow[],
  cx: number,
  cy: number,
  parent: Container,
  resources: RenderResources,
  melds: MeldDrawingPort,
  nextPage: (() => void) | null
): void {
  const container = new Container();
  const nodes = buildResultRowNodes(rows, resources, melds);
  const built = nodes.rows;
  const yakuColW = nodes.maxYakuName + 36 + nodes.maxYakuValue;
  const yakuColumnGap = 48;
  const has2ColYaku = built.some((row) => row.kind === "yaku2");
  const yakuBlockW = has2ColYaku ? yakuColW * 2 + yakuColumnGap : yakuColW;
  const contentW = Math.max(yakuBlockW, nodes.maxSingle, nodes.maxTilesW);
  let totalH = 0;
  let previousKind: BuiltResultRow["kind"] | null = null;
  for (const row of built) {
    totalH += rowGap(previousKind, row) + row.h;
    previousKind = row.kind;
  }
  const padX = 36;
  const padY = 24;
  const panelW = contentW + padX * 2;
  const panelH = totalH + padY * 2;
  const background = new Graphics()
    .roundRect(0, 0, panelW, panelH, 16)
    .fill({ color: 0x000000, alpha: 0.85 })
    .stroke({ color: 0xffffff, width: 1, alpha: 0.25 });
  container.addChild(background);
  let y = padY;
  previousKind = null;
  let scoreRowCenterY: number | null = null;
  for (const row of built) {
    y += rowGap(previousKind, row);
    if (row.kind === "yaku") {
      const colLeft = (panelW - yakuColW) / 2;
      row.name.position.set(colLeft, y);
      row.value.position.set(colLeft + yakuColW - row.value.width, y);
      container.addChild(row.name, row.value);
    } else if (row.kind === "yaku2") {
      const blockLeft = (panelW - yakuBlockW) / 2;
      const rightColLeft = blockLeft + yakuColW + yakuColumnGap;
      row.leftName.position.set(blockLeft, y);
      row.leftValue.position.set(blockLeft + yakuColW - row.leftValue.width, y);
      container.addChild(row.leftName, row.leftValue);
      if (row.rightName && row.rightValue) {
        row.rightName.position.set(rightColLeft, y);
        row.rightValue.position.set(
          rightColLeft + yakuColW - row.rightValue.width,
          y
        );
        container.addChild(row.rightName, row.rightValue);
      }
    } else if (row.kind === "tiles" || row.kind === "hand") {
      row.container.position.set((panelW - row.w) / 2, y);
      container.addChild(row.container);
    } else if (row.kind === "scoreRow") {
      const rowLeft = (panelW - row.w) / 2;
      row.hanText.position.set(rowLeft, y);
      container.addChild(row.hanText);
      if (row.ptsText) {
        row.ptsText.position.set(
          rowLeft + row.hanText.width + RESULT_ROW_INNER_GAP,
          y
        );
        container.addChild(row.ptsText);
      }
      scoreRowCenterY = y + row.h / 2;
    } else if (row.kind === "divider") {
      const line = new Graphics()
        .moveTo(padX, y + row.h / 2)
        .lineTo(panelW - padX, y + row.h / 2)
        .stroke({ color: 0xffffff, width: 1, alpha: 0.25 });
      container.addChild(line);
    } else {
      row.text.position.set((panelW - row.text.width) / 2, y);
      container.addChild(row.text);
    }
    y += row.h;
    previousKind = row.kind;
  }
  const panelY =
    scoreRowCenterY !== null ? cy - scoreRowCenterY : cy - panelH / 2;
  container.position.set(cx - panelW / 2, panelY);
  parent.addChild(container);
  if (nextPage) {
    background.eventMode = "static";
    background.cursor = "pointer";
    background.on("pointerdown", (event) => {
      if (event.button === 2) {
        return;
      }
      nextPage();
    });
  }
}
