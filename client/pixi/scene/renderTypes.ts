import type { Container, Texture } from "pixi.js";
import type { MatchView } from "../../store";
import type { DiscardSource } from "../../discardActions";
import type { LegalAction } from "~/game/protocol/messages";
import type { ActionIntentContext } from "~/game/protocol/timing";
import type { TableLayout } from "../tableLayout";
import type { TileDesign } from "../tiles/tileDesign";
import type { TileSpriteFactory } from "../tiles/tileSpriteFactory";
import type { TileTextureStore } from "../tiles/tileTextureStore";

export interface SeatEnrichment {
  teamName?: string | null;
  teamLogoUrl?: string | null;
}

export type TableRendererPresentation = "standard" | "mobile";
export type TsumogiriTintMode = "none" | "fresh" | "all";
export type HandResult = NonNullable<MatchView["lastHandResult"]>;

export interface TileClick {
  intent?: ActionIntentContext;
  seat: number;
  index: number;
  tile: string;
  discardSource: DiscardSource;
}

export interface ActionClick {
  intent?: ActionIntentContext;
  action: LegalAction;
}

export interface RenderResources {
  readonly tileDesign: TileDesign;
  readonly textureStore: TileTextureStore;
  readonly spriteFactory: TileSpriteFactory;
  readonly chipIconTex: Texture | null;
  readonly dabukenIconTex: Texture | null;
  readonly feltMaskTex: Texture | null;
}

export interface RenderFrame {
  readonly view: MatchView;
  readonly layout: TableLayout;
  readonly root: Container;
  readonly presentation: TableRendererPresentation;
  readonly waitTiles: ReadonlySet<string>;
}
