import { Container, Graphics, Sprite, Text, TextStyle } from "pixi.js";
import type { ColorSource } from "pixi.js";
import type { LegalAction } from "~/game/protocol/messages";
import type { TableRendererPresentation } from "../scene/renderTypes";
import type { TileTextureStore } from "../tiles/tileTextureStore";
import {
  actionButtonColor,
  actionButtonStyle,
  labelForAction,
} from "../geometry/actionGeometry";
import { SMALL_TILE_H, SMALL_TILE_W } from "../geometry/renderConstants";
import { sortTilesForDisplay } from "../geometry/tileOrder";

export type CallGroup = "chi" | "pon" | "kan";
export interface ActionButtonNode {
  readonly c: Container;
  readonly w: number;
}

export function drawRiichiToggleButton(
  presentation: TableRendererPresentation,
  active: boolean,
  toggle: () => void
): ActionButtonNode {
  const style = actionButtonStyle(presentation);
  const height = style.height;
  const labelStyle = new TextStyle({
    fontFamily: "Inter, system-ui, sans-serif",
    fontSize: Math.round(height * 0.42),
    fontWeight: "700",
    fill: 0xffffff,
  });
  const labelNode = new Text({
    text: active ? "Cancel" : "Riichi",
    style: labelStyle,
  });
  const width = Math.max(
    style.minRiichiWidth,
    labelNode.width + style.horizontalPadding * 2
  );
  const bg = new Graphics().roundRect(0, 0, width, height, style.radius).fill({
    color: active ? 0xe0c060 : 0xc0a040,
    alpha: style.fillAlpha,
  });
  if (style.borderAlpha > 0) {
    bg.roundRect(0, 0, width, height, style.radius).stroke({
      color: 0xffffff,
      width: 2,
      alpha: style.borderAlpha,
    });
  }
  labelNode.anchor.set(0.5);
  labelNode.position.set(width / 2, height / 2);
  const c = new Container();
  c.addChild(bg, labelNode);
  c.eventMode = "static";
  c.cursor = "pointer";
  c.on("pointerdown", (event) => {
    if (event.button === 2) {
      return;
    }
    toggle();
  });
  return { c, w: width };
}

export function drawCallGroupButton(
  presentation: TableRendererPresentation,
  group: CallGroup,
  expanded: CallGroup | null,
  expand: (group: CallGroup | null) => void
): ActionButtonNode {
  const style = actionButtonStyle(presentation);
  const height = style.height;
  const palette: Record<CallGroup, ColorSource> = {
    chi: 0x4a7fb4,
    pon: 0xb47f3a,
    kan: 0x7a4ab4,
  };
  const labelStyle = new TextStyle({
    fontFamily: "Inter, system-ui, sans-serif",
    fontSize: Math.round(height * 0.42),
    fontWeight: "700",
    fill: 0xffffff,
  });
  const active = expanded === group;
  const labelText = group === "chi" ? "Chi" : group === "pon" ? "Pon" : "Kan";
  const labelNode = new Text({
    text: `${labelText} ${active ? "▴" : "▾"}`,
    style: labelStyle,
  });
  const width = Math.max(
    style.minGroupWidth,
    labelNode.width + style.horizontalPadding * 2
  );
  const bg = new Graphics()
    .roundRect(0, 0, width, height, style.radius)
    .fill({ color: palette[group], alpha: style.fillAlpha });
  if (active) {
    bg.roundRect(0, 0, width, height, style.radius).stroke({
      color: 0xffffff,
      width: 3,
    });
  } else if (style.borderAlpha > 0) {
    bg.roundRect(0, 0, width, height, style.radius).stroke({
      color: 0xffffff,
      width: 2,
      alpha: style.borderAlpha,
    });
  }
  labelNode.anchor.set(0.5);
  labelNode.position.set(width / 2, height / 2);
  const c = new Container();
  c.addChild(bg, labelNode);
  c.eventMode = "static";
  c.cursor = "pointer";
  c.on("pointerdown", (event) => {
    if (event.button === 2) {
      return;
    }
    expand(active ? null : group);
  });
  return { c, w: width };
}

export function drawCallOptionButton(
  presentation: TableRendererPresentation,
  textures: TileTextureStore,
  action: LegalAction,
  choose: (action: LegalAction) => void
): ActionButtonNode {
  const style = actionButtonStyle(presentation);
  const height = style.height;
  const previewTiles: string[] = [];
  if (action.tiles) {
    previewTiles.push(...action.tiles);
  }
  if (
    action.tile &&
    action.kanKind !== "ankan" &&
    action.kanKind !== "shouminkan"
  ) {
    previewTiles.push(action.tile);
  }
  previewTiles.splice(
    0,
    previewTiles.length,
    ...sortTilesForDisplay(previewTiles)
  );
  const tileH = height - style.optionTileInset;
  const tileW = (tileH * SMALL_TILE_W) / SMALL_TILE_H;
  const tileGap = presentation === "mobile" ? 3 : 2;
  const padX = style.optionPadding;
  const width =
    padX * 2 +
    previewTiles.length * tileW +
    tileGap * Math.max(0, previewTiles.length - 1);
  const palette: Record<string, ColorSource> = {
    chi: 0x4a7fb4,
    pon: 0xb47f3a,
    kan: 0x7a4ab4,
  };
  const bg = new Graphics().roundRect(0, 0, width, height, style.radius).fill({
    color: palette[action.type] ?? 0x666666,
    alpha: style.optionFillAlpha,
  });
  if (style.borderAlpha > 0) {
    bg.roundRect(0, 0, width, height, style.radius).stroke({
      color: 0xffffff,
      width: 2,
      alpha: style.borderAlpha,
    });
  }
  const c = new Container();
  c.addChild(bg);
  let tx = padX;
  const ty = (height - tileH) / 2;
  for (const tile of previewTiles) {
    const sprite = new Sprite(textures.getTexture("bottomSmall", tile));
    sprite.width = tileW;
    sprite.height = tileH;
    sprite.position.set(tx, ty);
    c.addChild(sprite);
    tx += tileW + tileGap;
  }
  c.eventMode = "static";
  c.cursor = "pointer";
  c.on("pointerdown", (event) => {
    if (event.button === 2) {
      return;
    }
    choose(action);
  });
  return { c, w: width };
}

export function drawActionButton(
  presentation: TableRendererPresentation,
  action: LegalAction,
  choose: (action: LegalAction) => void,
  labelOverride?: string
): ActionButtonNode {
  const style = actionButtonStyle(presentation);
  const height = style.height;
  const labelStyle = new TextStyle({
    fontFamily: "Inter, system-ui, sans-serif",
    fontSize: Math.round(height * 0.42),
    fontWeight: "700",
    fill: 0xffffff,
  });
  let text: string;
  if (labelOverride !== undefined) {
    text = labelOverride;
  } else if (action.type === "chi") {
    text = "Chi";
  } else if (action.type === "pon") {
    text = "Pon";
  } else if (action.type === "kan") {
    text = "Kan";
  } else {
    text = labelForAction(action);
  }
  const labelNode = new Text({ text, style: labelStyle });
  const width = Math.max(
    style.minActionWidth,
    labelNode.width + style.horizontalPadding * 2
  );
  const bg = new Graphics().roundRect(0, 0, width, height, style.radius).fill({
    color: actionButtonColor(action),
    alpha: style.fillAlpha,
  });
  if (style.borderAlpha > 0) {
    bg.roundRect(0, 0, width, height, style.radius).stroke({
      color: 0xffffff,
      width: 2,
      alpha: style.borderAlpha,
    });
  }
  labelNode.anchor.set(0.5);
  labelNode.position.set(width / 2, height / 2);
  const c = new Container();
  c.addChild(bg, labelNode);
  c.eventMode = "static";
  c.cursor = "pointer";
  c.on("pointerdown", (event) => {
    if (event.button === 2) {
      return;
    }
    choose(action);
  });
  return { c, w: width };
}
