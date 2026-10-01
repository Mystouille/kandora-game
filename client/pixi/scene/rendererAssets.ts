import { Assets, Texture } from "pixi.js";
import chipIconUrl from "~/game/client/icons/chips.png";
import dabukenIconUrl from "~/game/client/icons/dabuken.png";
import tenhouBgUrl from "~/game/tenhouSprites/tenhouBg.png";
import { WIND_KANJI } from "../geometry/renderConstants";
import type { TileDesign } from "../tiles/tileDesign";
import { TileSpriteFactory } from "../tiles/tileSpriteFactory";
import { TileTextureStore } from "../tiles/tileTextureStore";
import type { RenderResources } from "./renderTypes";

export class RendererAssets {
  private chipIconTex: Texture | null = null;
  private dabukenIconTex: Texture | null = null;
  private feltMaskTex: Texture | null = null;
  readonly resources: RenderResources;

  constructor(tileDesign: TileDesign) {
    const textureStore = new TileTextureStore(tileDesign);
    const owner = this;
    this.resources = {
      tileDesign,
      textureStore,
      spriteFactory: new TileSpriteFactory(textureStore),
      get chipIconTex(): Texture | null {
        return owner.chipIconTex;
      },
      get dabukenIconTex(): Texture | null {
        return owner.dabukenIconTex;
      },
      get feltMaskTex(): Texture | null {
        return owner.feltMaskTex;
      },
    };
  }

  async load(): Promise<RenderResources> {
    await this.resources.textureStore.load();
    try {
      await document.fonts.load('400 16px "Yuji Syuku"', WIND_KANJI.join(""));
    } catch (error) {
      // Local Mincho faces remain the intended fallback.
      // eslint-disable-next-line no-console
      console.warn("[TableRenderer] failed to load wind font", error);
    }
    try {
      [this.chipIconTex, this.dabukenIconTex, this.feltMaskTex] =
        await Promise.all([
          Assets.load<Texture>(chipIconUrl),
          Assets.load<Texture>(dabukenIconUrl),
          Assets.load<Texture>(tenhouBgUrl),
        ]);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.warn("[TableRenderer] failed to load nameplate icons", error);
    }
    return this.resources;
  }

  destroy(): void {
    this.resources.textureStore.destroy();
  }
}
