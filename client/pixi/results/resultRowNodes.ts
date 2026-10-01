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
      hanText: Text;
      ptsText: Text | null;
      w: number;
      h: number;
    }
  | { kind: "tiles"; container: Container; w: number; h: number }
  | { kind: "hand"; container: Container; w: number; h: number }
  | { kind: "divider"; h: number };

export const RESULT_ROW_INNER_GAP = 24;

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
          const { node, width } = melds.drawMeld(meld, 0);
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
      const hanText = new Text({
        text: row.han,
        style: new TextStyle({
          fontFamily: "Inter, system-ui, sans-serif",
          fontSize: 30,
          fontWeight: "700",
          fill: 0xffffff,
        }),
      });
      const ptsText = row.pts
        ? new Text({
            text: row.pts,
            style: new TextStyle({
              fontFamily: "Inter, system-ui, sans-serif",
              fontSize: 30,
              fontWeight: "700",
              fill: row.ptsColor ?? 0xfde68a,
            }),
          })
        : null;
      const w = ptsText
        ? hanText.width + RESULT_ROW_INNER_GAP + ptsText.width
        : hanText.width;
      const h = Math.max(hanText.height, ptsText?.height ?? 0) + 8;
      maxSingle = Math.max(maxSingle, w);
      if (row.hidden) {
        hanText.visible = false;
        if (ptsText) {
          ptsText.visible = false;
        }
      }
      built.push({ kind: "scoreRow", hanText, ptsText, w, h });
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
