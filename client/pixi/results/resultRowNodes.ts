import { Container, Text, TextStyle } from "pixi.js";
import type { RenderResources } from "../scene/renderTypes";
import { meldTileDims } from "../tileAreaLayout";
import type { MeldDrawingPort, ResultRow } from "./resultTypes";

export type BuiltResultRow =
  | { kind: "yaku"; name: Text; value: Text; h: number }
  | {
      kind: "yaku2";
      leftName: Text;
      leftValue: Text;
      rightName: Text | null;
      rightValue: Text | null;
      h: number;
    }
  | { kind: "single"; text: Text; h: number }
  | {
      kind: "scoreRow";
      scoreContainer: Container;
      ptsText: Text | null;
      scoreWidth: number;
      scoreHeight: number;
      w: number;
      h: number;
    }
  | { kind: "tiles"; container: Container; w: number; h: number }
  | { kind: "hand"; container: Container; w: number; h: number }
  | { kind: "divider"; h: number };

export const RESULT_ROW_INNER_GAP = 24;
const RESULT_SCORE_BREAKDOWN_GAP = 8;

export function resultScoreBreakdownLayout(
  pointsWidth: number,
  flowersWidth: number,
  totalPointsWidth: number
): {
  pointsX: number;
  flowersX: number;
  totalPointsX: number;
  width: number;
} {
  const alignedColumnWidth = Math.max(pointsWidth, flowersWidth);
  return {
    pointsX: alignedColumnWidth - pointsWidth,
    flowersX: alignedColumnWidth - flowersWidth,
    totalPointsX: alignedColumnWidth + RESULT_SCORE_BREAKDOWN_GAP,
    width:
      alignedColumnWidth + RESULT_SCORE_BREAKDOWN_GAP + totalPointsWidth,
  };
}

export interface ResultPanelNodes {
  readonly rows: readonly BuiltResultRow[];
  readonly maxYakuName: number;
  readonly maxYakuValue: number;
  readonly maxSingle: number;
  readonly maxTilesW: number;
}

export function buildResultRowNodes(
  rows: readonly ResultRow[],
  resources: RenderResources,
  melds: MeldDrawingPort
): ResultPanelNodes {
  const yakuFont = 22;
  const yakuRowH = yakuFont + 4;
  const built: BuiltResultRow[] = [];
  let maxYakuName = 0;
  let maxYakuValue = 0;
  let maxSingle = 0;
  let maxTilesW = 0;
  const makeYakuText = (text: string, weight: "500" | "600"): Text =>
    new Text({
      text,
      style: new TextStyle({
        fontFamily: "Inter, system-ui, sans-serif",
        fontSize: yakuFont,
        fontWeight: weight,
        fill: 0xffffff,
      }),
    });
  for (const row of rows) {
    if (row.kind === "yaku") {
      const name = makeYakuText(row.name, "500");
      const value = makeYakuText(row.value, "600");
      maxYakuName = Math.max(maxYakuName, name.width);
      maxYakuValue = Math.max(maxYakuValue, value.width);
      if (row.hidden) {
        name.visible = false;
        value.visible = false;
      }
      built.push({ kind: "yaku", name, value, h: yakuRowH });
    } else if (row.kind === "yaku2") {
      const leftName = makeYakuText(row.left.name, "500");
      const leftValue = makeYakuText(row.left.value, "600");
      const rightName = row.right ? makeYakuText(row.right.name, "500") : null;
      const rightValue = row.right
        ? makeYakuText(row.right.value, "600")
        : null;
      maxYakuName = Math.max(
        maxYakuName,
        leftName.width,
        rightName?.width ?? 0
      );
      maxYakuValue = Math.max(
        maxYakuValue,
        leftValue.width,
        rightValue?.width ?? 0
      );
      if (row.leftHidden) {
        leftName.visible = false;
        leftValue.visible = false;
      }
      if (row.rightHidden && rightName && rightValue) {
        rightName.visible = false;
        rightValue.visible = false;
      }
      built.push({
        kind: "yaku2",
        leftName,
        leftValue,
        rightName,
        rightValue,
        h: yakuRowH,
      });
    } else if (row.kind === "tiles") {
      const tileContainer = new Container();
      const metrics = meldTileDims(resources.tileDesign, 0);
      let dx = 0;
      for (const tile of row.tiles) {
        const { node } = melds.drawMeldTile(tile, 0);
        node.position.set(dx, 0);
        tileContainer.addChild(node);
        dx += metrics.w;
      }
      const w = row.tiles.length * metrics.w;
      const h = metrics.h;
      maxTilesW = Math.max(maxTilesW, w);
      built.push({ kind: "tiles", container: tileContainer, w, h });
    } else if (row.kind === "hand") {
      const handContainer = new Container();
      const metrics = meldTileDims(resources.tileDesign, 0);
      const agariGap = 14;
      const meldGap = 18;
      let dx = 0;
      for (const tile of row.concealed) {
        const { node } = melds.drawMeldTile(tile, 0);
        node.position.set(dx, 0);
        handContainer.addChild(node);
        dx += metrics.w;
      }
      if (row.winTile) {
        dx += agariGap;
        const { node } = melds.drawMeldTile(row.winTile, 0);
        node.position.set(dx, 0);
        handContainer.addChild(node);
        dx += metrics.w;
      }
      if (row.melds && row.melds.length > 0) {
        for (const meld of row.melds) {
          dx += meldGap;
          const rendered = row.revealConcealedKongs
            ? melds.drawMeld(meld, 0, 0, true)
            : melds.drawMeld(meld, 0);
          const { node, width } = rendered;
          node.position.set(dx, 0);
          handContainer.addChild(node);
          dx += width;
        }
      }
      const w = dx;
      const h = metrics.h;
      maxTilesW = Math.max(maxTilesW, w);
      built.push({ kind: "hand", container: handContainer, w, h });
    } else if (row.kind === "divider") {
      built.push({ kind: "divider", h: 12 });
    } else if (row.kind === "scoreRow") {
      const makeScoreText = (text: string, fill: number): Text =>
        new Text({
          text,
          style: new TextStyle({
            fontFamily: "Inter, system-ui, sans-serif",
            fontSize: 30,
            fontWeight: "700",
            fill,
          }),
        });
      const scoreContainer = new Container();
      const primaryText = makeScoreText(
        row.scoreBreakdown?.points ?? row.han,
        0xffffff
      );
      scoreContainer.addChild(primaryText);
      let scoreWidth = primaryText.width;
      let scoreHeight = primaryText.height;
      if (row.scoreBreakdown) {
        const flowersText = makeScoreText(
          row.scoreBreakdown.flowers,
          0xffffff
        );
        const totalPointsText = makeScoreText(
          row.scoreBreakdown.totalPoints,
          0xffffff
        );
        const layout = resultScoreBreakdownLayout(
          primaryText.width,
          flowersText.width,
          totalPointsText.width
        );
        const secondLineY = primaryText.height;
        primaryText.position.set(layout.pointsX, 0);
        flowersText.position.set(layout.flowersX, secondLineY);
        totalPointsText.position.set(layout.totalPointsX, secondLineY);
        scoreContainer.addChild(flowersText, totalPointsText);
        scoreWidth = layout.width;
        scoreHeight =
          secondLineY + Math.max(flowersText.height, totalPointsText.height);
      }
      const ptsText = row.pts
        ? makeScoreText(row.pts, row.ptsColor ?? 0xfde68a)
        : null;
      const w = ptsText
        ? scoreWidth + RESULT_ROW_INNER_GAP + ptsText.width
        : scoreWidth;
      const h = Math.max(scoreHeight, ptsText?.height ?? 0) + 8;
      maxSingle = Math.max(maxSingle, w);
      if (row.hidden) {
        scoreContainer.visible = false;
        if (ptsText) {
          ptsText.visible = false;
        }
      }
      built.push({
        kind: "scoreRow",
        scoreContainer,
        ptsText,
        scoreWidth,
        scoreHeight,
        w,
        h,
      });
    } else {
      const text = new Text({
        text: row.text,
        style: new TextStyle({
          fontFamily: "Inter, system-ui, sans-serif",
          fontSize: row.size,
          fontWeight: row.kind === "title" ? "700" : "600",
          fill: (row.kind === "label" ? row.color : undefined) ?? 0xffffff,
        }),
      });
      maxSingle = Math.max(maxSingle, text.width);
      built.push({ kind: "single", text, h: row.size + 8 });
    }
  }
  return { rows: built, maxYakuName, maxYakuValue, maxSingle, maxTilesW };
}
